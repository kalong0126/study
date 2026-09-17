/**
 * 来源地址判定
 *
 * 单独成一个文件，是因为它是个**纯函数**，而鉴权那套背后连着配置、数据库和日志。
 * 想要一条断言就能直接测它，就不能让它跟那些东西绑在一起 ——
 * 否则光为了调一次 isPrivateAddress("127.0.0.1")，测试进程就得先加载整个配置与日志系统。
 */
import fs from "node:fs";
import os from "node:os";

/**
 * 这个地址算不算「家里」？
 *
 * 判据是**直连的 socket 地址**，绝不看 X-Forwarded-For —— 那是客户端能随便写的头，
 * 信它等于把内网白名单免费送出去。
 *
 * ⚠️ 将来如果真加了反向代理（nginx / Cloudflare），这里必须改成
 *    「先从可信代理的固定地址取真实 IP，再判断」，否则所有请求的来源都会是
 *    反代自己的内网地址，等于全员内网、这道门形同虚设。
 */
export function isPrivateAddress(raw?: string): boolean {
  if (!raw) return true; // 拿不到地址（Unix socket / 测试环境）→ 当本机
  let ip = raw.trim().toLowerCase();
  // Node 在双栈监听下会把 IPv4 报成 ::ffff:192.168.1.5
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10 || a === 127) return true; // 10/8 · loopback
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 169 && b === 254) return true; // IPv4 link-local
    // 注意：100.64/10（运营商级 NAT）**不算**内网 —— 那是运营商的大内网，
    // 同段的其他宽带用户不在你家。宁可保守。
    return false;
  }

  if (ip === "::1" || ip === "::") return true;
  const head = ip.split(":")[0] ?? "";
  if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true; // fc00::/7 → fc / fd（ULA）
  if (/^fe[89ab][0-9a-f]?$/.test(head)) return true; // fe80::/10 → fe80..febf
  return false;
}

/* ------------------------------------------------------------ CIDR 匹配 */

/** 去掉 ::ffff: 前缀（双栈监听下 IPv4 会带这个） */
function bare(ip: string): string {
  const s = ip.trim().toLowerCase();
  return s.startsWith("::ffff:") && s.includes(".") ? s.slice(7) : s;
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((n) => n > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

/** 把 IPv6 展开成 8 组 16 位再拼成一个 128 位整数 */
function ipv6ToBigInt(ip: string): bigint | null {
  let s = ip;
  if (s.includes(".")) {
    const last = s.lastIndexOf(":");
    if (last < 0) return null;
    const v4 = ipv4ToInt(s.slice(last + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, last)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<string>(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/**
 * ip 是否落在 cidr 里（"172.10.10.0/24"、"240e:3b7:1:1000::/64"，也接受不带掩码的单地址）。
 *
 * 为什么需要它：**不是所有家庭内网都在 RFC1918 里**。这台机器所在的
 * 172.10.10.0/24 就不在（172.16–172.31 才是私有的），光靠 isPrivateAddress()
 * 会把自己家的平板判成公网，于是每次打开都要输口令。
 * 所以还得支持「信任我本机网卡所在的网段」这条路。
 */
export function inCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const netRaw = slash < 0 ? cidr : cidr.slice(0, slash);
  const net = bare(netRaw);
  const target = bare(ip);

  const a4 = ipv4ToInt(target);
  const n4 = ipv4ToInt(net);
  if (a4 !== null && n4 !== null) {
    const bits = slash < 0 ? 32 : Number(cidr.slice(slash + 1));
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((a4 & mask) >>> 0) === ((n4 & mask) >>> 0);
  }

  const a6 = ipv6ToBigInt(target);
  const n6 = ipv6ToBigInt(net);
  if (a6 !== null && n6 !== null) {
    const bits = slash < 0 ? 128 : Number(cidr.slice(slash + 1));
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
    const shift = BigInt(128 - bits);
    return a6 >> shift === n6 >> shift;
  }
  return false;
}

/**
 * 本机所有（非虚拟网卡的）网段，例如 ["172.10.10.14/24", "240e:3b7:1:1000::2/64"]。
 *
 * 用它来回答「这台设备是不是和我同一个局域网」—— 同一个网段就是邻居，
 * 这个推断在家用场景成立；跑在容器里时不成立（见 auth.ts 的 isTrustedAddress）。
 */
export function localSubnets(): string[] {
  const out = new Set<string>();
  // 虚拟网卡要排除：Docker / WSL / VMware 的网段信任了等于开门
  const VIRTUAL = /wsl|docker|veth|vmware|virtualbox|hyper-v|loopback|tailscale|zerotier/i;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const info of ifaces[name] ?? []) {
      if (info.internal || !info.cidr) continue;
      out.add(info.cidr.toLowerCase());
    }
  }
  return [...out];
}

/**
 * 这个地址是不是「本机某个网段的网关位」（网段内第一个可用地址）？
 *
 * 用途只有一个：**识别 Docker 把来源地址改写成了网桥网关**。
 *
 * bridge 网络下，只要请求不是从宿主机同一个二层进来的，容器看到的 remoteAddress
 * 就是本 compose 网段的网关 —— 典型例子是公网 IPv6：Docker 默认 bridge **不做
 * IPv6 NAT**，IPv6 那半边由 userland 的 docker-proxy 转发，实测容器看到的是
 * 172.22.0.1。它既不在 RFC1918（172.16–172.31）里、也不在用户配的信任网段里，
 * 于是「家里」被当成公网：孩子端要输口令、家长接口全 403。
 *
 * 真实客户端不会是网关自己（网关做 SNAT 的访客网络除外，那种本来也该按公网算），
 * 所以命中它基本可以断定来源 IP 已经丢了 —— 该换 host 网络。
 *
 * ⚠️ 只是**诊断**用（打一行日志），不参与放行判断：把它当白名单就等于把
 *    「公网免口令」的洞重新开出来。
 */
export function isOwnGateway(raw?: string): boolean {
  if (!raw) return false;
  const target = bare(raw);
  const t4 = ipv4ToInt(target);
  const t6 = ipv6ToBigInt(target);
  if (t4 === null && t6 === null) return false;

  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal || !info.cidr) continue;
      const slash = info.cidr.lastIndexOf("/");
      if (slash < 0) continue;
      const bits = Number(info.cidr.slice(slash + 1));
      if (!Number.isInteger(bits)) continue;
      if (!inCidr(target, info.cidr)) continue;

      if (t4 !== null) {
        const self4 = ipv4ToInt(bare(info.address));
        if (self4 === null || bits < 0 || bits > 32) continue;
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        if ((((self4 & mask) >>> 0) + 1) >>> 0 === t4) return true;
        continue;
      }

      const self6 = ipv6ToBigInt(bare(info.address));
      if (self6 === null || bits < 0 || bits > 128) continue;
      const shift = BigInt(128 - bits);
      if (((self6 >> shift) << shift) + 1n === t6) return true;
    }
  }
  return false;
}

/**
 * 是不是跑在容器里？
 *
 * 这件事必须知道，因为**容器里判断来源地址这一套基本不可用**：Docker 的
 * bridge 网络下，容器看到的 remoteAddress 往往是网桥网关（172.18.0.1 之类），
 * 而 172.18 恰好落在 RFC1918 里 —— 于是「公网来的请求」也会被当成内网放行，
 * 加固彻底失效。所以容器里只认**显式配置**的可信网段。
 */
export function inContainer(): boolean {
  try {
    if (fs.existsSync("/.dockerenv")) return true;
  } catch {
    /* ignore */
  }
  try {
    return /docker|containerd|kubepods|podman|libpod/i.test(fs.readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    /* Windows / 无 cgroup */
  }
  return false;
}
