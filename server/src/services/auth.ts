/**
 * 鉴权：PIN → 会话 token
 *
 * 为什么需要这一层：这个学习台原本跑在「家庭内网 + 不把网址告诉孩子」的信任模型下，
 * 端口一旦暴露到公网，那套就彻底失效了 —— 陌生人可以下载你的全量数据、用 replace
 * 模式覆盖数据库、拿你配好的大模型 Key 去烧钱。所以公网访问必须先过一道
 * 「口令 → 会话 token」。
 *
 * 三条边界，按重要性排：
 *   1. token 只存 sha256：数据库被看走也换不回一个可用的会话；
 *   2. 家长类接口在公网**一律拒绝** —— 只放孩子端（家长功能回内网用）；
 *   3. 登录失败会锁定来源 IP，避免 8 位口令被慢慢试出来。
 *
 * 刻意不引新依赖：cookie 解析、token 生成都用 node 内置能力手写（各二十来行），
 * 少一个包就少一份要跟的安全公告。
 */
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config.js";
import { kvGet, kvSet } from "../db/repo/state.js";
import { logAuth } from "../logger.js";
import { inCidr, inContainer, isOwnGateway, isPrivateAddress, localSubnets } from "./net.js";

export type Role = "child" | "parent";

/** 会话存 app_kv（child_id=0，系统级），和 ttsVoice / llmRuntime 同一层 */
const KV_SESSIONS = "authSessions";
/** cookie 名。改它 = 让所有已发出的会话立即作废 */
export const SESSION_COOKIE = "g2sid";
/** 一个孩子 + 一个家长；留 20 条足够覆盖「换设备 / 重装 PWA / 旧手机没清」 */
const MAX_SESSIONS = 20;

/* ----------------------------------------------------------- 登录失败锁定 */

/** 连续错几次就锁 */
const MAX_FAILS = 5;
/** 锁定时长，同时也是计数的滑动窗口 */
const LOCK_MS = 15 * 60_000;

const attempts = new Map<string, { fails: number; firstAt: number; until: number }>();

export function lockState(ip: string): { locked: boolean; retryAfterSec: number; remaining: number } {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a) return { locked: false, retryAfterSec: 0, remaining: MAX_FAILS };
  if (a.until > now) {
    return { locked: true, retryAfterSec: Math.ceil((a.until - now) / 1000), remaining: 0 };
  }
  if (now - a.firstAt > LOCK_MS) {
    attempts.delete(ip);
    return { locked: false, retryAfterSec: 0, remaining: MAX_FAILS };
  }
  return { locked: false, retryAfterSec: 0, remaining: Math.max(0, MAX_FAILS - a.fails) };
}

function noteFail(ip: string): void {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.firstAt > LOCK_MS) {
    attempts.set(ip, { fails: 1, firstAt: now, until: 0 });
  } else {
    a.fails += 1;
    if (a.fails >= MAX_FAILS) a.until = now + LOCK_MS;
  }
  // 家庭场景 IP 是个位数。真被扫了会把表撑大，顺手清扫过期项
  if (attempts.size > 500) {
    for (const [k, v] of attempts) {
      if (v.until < now && now - v.firstAt > LOCK_MS) attempts.delete(k);
    }
  }
}

function clearFails(ip: string): void {
  attempts.delete(ip);
}

/* ------------------------------------------------------------- 内网判定 */

/** 基础判定在 services/net.ts（纯函数，单独可测）。这里转出去，调用方不用多 import 一个模块。 */
export { isPrivateAddress };

/** 可信网段 = 显式配置 + （非容器时的）本机网卡所在网段。算一次就缓存。 */
let netsCache: { key: string; nets: string[] } | null = null;

export function trustedNets(cfg: AppConfig): string[] {
  const key = cfg.server.auth.lanCidrs.join(",");
  if (netsCache?.key === key) return netsCache.nets;

  const out = new Set<string>(cfg.server.auth.lanCidrs);
  // 容器里不猜：容器看到的「本机网卡」全是 Docker 自己的网桥
  if (!inContainer()) {
    for (const c of localSubnets()) out.add(c);
  }
  const nets = [...out];
  netsCache = { key, nets };
  return nets;
}

/**
 * 这个来源地址算「自己人」吗？
 *
 * 三步走，每一步都在挡一个具体的坑：
 *   1. 显式配置的网段优先 —— 两种部署都认，也是容器里唯一的依据；
 *   2. 非容器环境额外信任「和本机同网段」—— 因为家里未必用 RFC1918 的段
 *      （172.10.10.0/24 就不在），光靠协议判定会把自己家平板当成公网；
 *   3. 最后才回落到协议判定（10/8、192.168/16、172.16/12、ULA、链路本地）。
 *
 * 容器里**故意跳过第 2、3 步**：Docker bridge 下请求的来源可能是 172.18.0.1
 * 这种网桥网关地址，而它恰好落在 RFC1918 里 —— 照单全收就等于把
 * 「公网免口令」这个洞开在 NAS 上，加固白做。
 */
export function isTrustedAddress(ip: string | undefined, cfg: AppConfig): boolean {
  if (!ip) return true;
  if (trustedNets(cfg).some((c) => inCidr(ip, c))) return true;
  if (inContainer()) return false;
  return isPrivateAddress(ip);
}

/** 这次请求该怎么对待：来自内网吗？按公网规则处理吗？ */
export function exposureOf(cfg: AppConfig, req: Request): { lan: boolean; exposed: boolean } {
  const lan = isTrustedAddress(req.socket.remoteAddress ?? undefined, cfg);
  return { lan, exposed: cfg.server.auth.forcePublic || !cfg.server.auth.lanBypass || !lan };
}

/* --------------------------------------------------------------- 会话 */

interface Session {
  /** token 的 sha256（不存原文） */
  hash: string;
  role: Role;
  createdAt: number;
  expiresAt: number;
  agent: string;
}

/**
 * 会话读写串行化。
 * 登录/登出同时发生时，「读-改-写」会互相覆盖掉对方的会话 —— 家庭场景概率极低，
 * 但代价只有一个 promise 链，没必要留这个坑。
 */
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** 定长哈希比对：避免「前几位对了就返回得快一点」这种时序泄漏 */
function sameSecret(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(sha256(a), "hex"), Buffer.from(sha256(b), "hex"));
}

export async function createSession(
  cfg: AppConfig,
  role: Role,
  agent: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + cfg.server.auth.sessionDays * 86_400_000;
  await serialize(async () => {
    const list = (await kvGet<Session[]>(0, KV_SESSIONS)) ?? [];
    const alive = list.filter((s) => s.expiresAt > now);
    alive.unshift({ hash: sha256(token), role, createdAt: now, expiresAt, agent: agent.slice(0, 100) });
    await kvSet(0, KV_SESSIONS, alive.slice(0, MAX_SESSIONS));
  });
  return { token, expiresAt };
}

export async function verifySession(token: string): Promise<Session | null> {
  if (!token) return null;
  const h = sha256(token);
  const list = (await kvGet<Session[]>(0, KV_SESSIONS)) ?? [];
  const now = Date.now();
  return list.find((s) => s.hash === h && s.expiresAt > now) ?? null;
}

export async function revokeSession(token: string): Promise<boolean> {
  if (!token) return false;
  const h = sha256(token);
  return serialize(async () => {
    const list = (await kvGet<Session[]>(0, KV_SESSIONS)) ?? [];
    const next = list.filter((s) => s.hash !== h);
    if (next.length === list.length) return false;
    await kvSet(0, KV_SESSIONS, next);
    return true;
  });
}

/** 让所有设备退出登录（家长「我的手机丢了」时用） */
export async function revokeAllSessions(): Promise<number> {
  return serialize(async () => {
    const list = (await kvGet<Session[]>(0, KV_SESSIONS)) ?? [];
    await kvSet(0, KV_SESSIONS, []);
    return list.length;
  });
}

/* --------------------------------------------------------------- 登录 */

export interface LoginOutcome {
  ok: boolean;
  status?: number;
  kind?: string;
  error?: string;
  role?: Role;
  token?: string;
  expiresAt?: number;
  remaining?: number;
  retryAfterSec?: number;
}

export async function login(
  cfg: AppConfig,
  pin: string,
  opts: { ip: string; fromLan: boolean; agent: string },
): Promise<LoginOutcome> {
  const auth = cfg.server.auth;

  const lock = lockState(opts.ip);
  if (lock.locked) {
    return {
      ok: false,
      status: 429,
      kind: "auth.locked",
      retryAfterSec: lock.retryAfterSec,
      error: `试错次数太多了，请等 ${Math.ceil(lock.retryAfterSec / 60)} 分钟再试`,
    };
  }

  const isParent = !!auth.parentPin && sameSecret(pin, auth.parentPin);
  const isChild = !!auth.childPin && sameSecret(pin, auth.childPin);

  // 家长口令本身就是「只能在家里用」的那把钥匙：外网连试都不让试，
  // 否则公网就成了家长口令的猜解口。
  if (isParent && !opts.fromLan) {
    noteFail(opts.ip);
    logAuth.warn({ ip: opts.ip }, "公网使用家长口令，已拒绝");
    return {
      ok: false,
      status: 403,
      kind: "auth.parentOffsite",
      error: "家长口令只能在家里（内网）使用。要管理内容请连上家里的 Wi-Fi。",
    };
  }

  const role: Role | null = isParent ? "parent" : isChild ? "child" : null;
  if (!role) {
    noteFail(opts.ip);
    const after = lockState(opts.ip);
    logAuth.warn({ ip: opts.ip, remaining: after.remaining }, "口令错误");
    return {
      ok: false,
      status: 401,
      kind: "auth.badpin",
      remaining: after.remaining,
      error: after.locked ? "口令不对，试错次数已用完，请稍后再试" : `口令不对，还能再试 ${after.remaining} 次`,
    };
  }

  clearFails(opts.ip);
  const s = await createSession(cfg, role, opts.agent);
  logAuth.info({ ip: opts.ip, role, days: auth.sessionDays }, "登录成功");
  return { ok: true, role, token: s.token, expiresAt: s.expiresAt };
}

/* --------------------------------------------------------------- 网关 */

/** 不需要登录也能访问的路径（**已去掉 /api 前缀**） */
const PUBLIC_PATHS = new Set([
  "/health",
  "/auth/login",
  "/auth/logout",
  "/auth/me",
  // 它本来就是「切到 https 之前先把根证书弄到平板上」用的，加锁就用不了了
  "/diag/rootca.crt",
]);

/**
 * 家长专属路径 —— 公网一律拒。
 *
 * 判据是「孩子端到底会不会调它」：只被家长后台 / 诊断抽屉调用的都归这里。
 * 孩子端要用的接口（答题、看题、朗读、看视频、读余额）全都不在表里。
 */
function isParentOnly(method: string, p: string, body: unknown): boolean {
  if (p === "/admin" || p.startsWith("/admin/")) return true;
  // 「登出所有设备」在公网被随便调就是一个 DoS 开关
  if (p === "/auth/logout-all") return true;
  if (p === "/backup" || p === "/backup/list" || p === "/backup/run" || p === "/restore") return true;
  if (
    p === "/diag/logs" ||
    p === "/diag/llm" ||
    p === "/diag/llm-test" ||
    p === "/diag/tts-test" ||
    p === "/diag/echo"
  ) {
    return true;
  }
  if (p === "/tts/prewarm" || p.startsWith("/tts/prewarm/") || p === "/tts/stats") return true;
  if (p === "/language/reset") return true;
  // 「再来一套」会真的花钱重出题；孩子端只用不带 force 的幂等版本
  if (p === "/language/generate" && (body as { force?: unknown } | undefined)?.force === true) return true;
  // 全量积分流水；孩子端只读自己的兑换历史（/points/history）
  if (p === "/points" && method === "GET") return true;
  return false;
}

export function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const v = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return "";
}

/** 优先 cookie（浏览器），其次 Bearer（curl / 脚本排查用） */
export function readToken(req: Request): string {
  const c = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (c) return c;
  const h = req.headers.authorization ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

/** 与 routes/helpers.ts 的 fail 同格式（services 不反向依赖 routes，所以本地写一个） */
function deny(res: Response, status: number, error: string, kind: string): void {
  res.status(status).json({ ok: false, error, kind });
}

/**
 * 鉴权网关。挂在 /api 路由**最前面**（health / auth 之后）。
 *
 * 三种去向：
 *   · 未启用鉴权、或来自内网且开了 lanBypass → 直接放行（= 加固之前的行为）
 *   · 被当作公网 + 家长接口 → 403
 *   · 被当作公网 + 没有有效会话 → 401（kind=auth.required，前端据此弹口令框）
 *
 * 配置在启动时取一次快照：auth 相关的改动需要重启才生效。
 * 这既符合 config.yaml 一直以来的约定，也避免请求打到「改了一半」的配置上。
 */
/**
 * 「来源地址被 Docker 改写」这条诊断只报一次。
 *
 * 它命中时说明用户正在踩 bridge 网络这个坑（见 net.ts 的 isOwnGateway）：
 * 每个请求都报一遍会把日志刷满，报一次就够定位了。
 */
let bridgeHintLogged = false;

export function createGuard(cfg: AppConfig): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const auth = cfg.server.auth;
  return async function guard(req, res, next) {
    if (!auth.enabled) {
      next();
      return;
    }

    // Express 在 app.use("/api", api) 时会改写 req.url，用 originalUrl 才拿得到完整路径
    const full = (req.originalUrl || req.url || "").split("?")[0];
    const p = full.startsWith("/api") ? full.slice(4) : full;
    const method = req.method.toUpperCase();

    if (PUBLIC_PATHS.has(p)) {
      next();
      return;
    }

    const ip = req.socket.remoteAddress ?? "";
    const exposed = exposureOf(cfg, req).exposed;
    if (!exposed) {
      next();
      return;
    }

    // 诊断：来源地址是「本机所在网段的网关」→ 真实客户端 IP 已被 Docker 改写。
    // 这就是「家里也要输口令、家长后台全 403」的根因（公网 IPv6 走 userland
    // docker-proxy 时必然如此），一行日志省掉之后半小时的排查。只报一次。
    if (!bridgeHintLogged && inContainer() && isOwnGateway(ip)) {
      bridgeHintLogged = true;
      logAuth.warn(
        { ip },
        "来源地址是容器自己网段的网关 → 客户端真实 IP 已被 Docker 改写（公网 IPv6 走 userland " +
          "docker-proxy 时必然如此）。若这是家里的设备，它会被当成公网：孩子端要输口令、" +
          "家长后台全 403。把 deploy/docker-compose.yml 的 app 改成 network_mode: host 即可" +
          "（见那里的注释）。",
      );
    }

    const session = await verifySession(readToken(req));

    if (isParentOnly(method, p, req.body)) {
      if (session?.role === "parent") {
        next();
        return;
      }
      logAuth.warn({ ip, method, path: p, role: session?.role ?? "none" }, "公网访问家长接口被拒");
      deny(res, 403, "家长功能只能在家里（内网）使用。要管理内容请连上家里的 Wi-Fi。", "auth.parentOffsite");
      return;
    }

    if (session) {
      next();
      return;
    }

    logAuth.warn({ ip, method, path: p }, "公网未登录访问被拒");
    deny(res, 401, "需要先输入口令才能使用", "auth.required");
  };
}
