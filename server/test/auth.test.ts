/**
 * 鉴权集成测试
 *
 * 起两个真实服务进程，因为「内网」和「公网」是**同一个服务的两套行为**，
 * 光靠配置是切换不过来的（配置在启动时取快照）：
 *   · A（8810）forcePublic=true  → 把每个请求都按公网处理，验证「公网那套锁」
 *   · B（8811）forcePublic=false → 127.0.0.1 就是内网，验证「家里照旧不受影响」
 *
 * A 故意监听 "::"（双栈），于是能顺手用 http://[::1]:8810 断言 IPv6 真的连得上 ——
 * 这既覆盖了「公网 IPv6 直连」的前提，也给**失败锁定**留了隔离手段：
 * ::1 与 127.0.0.1 在服务端是两个不同的来源地址，锁住一个不影响另一个。
 *
 * 运行：npm run test:auth
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, valueSource } from "../src/config.js";
import { inCidr, isPrivateAddress, localSubnets } from "../src/services/net.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, "..");
const NODE = process.execPath;
const TSX = path.join(SERVER_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const PORT_A = 8810;
const PORT_B = 8811;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
/** 走 IPv6 回环：既验证双栈，也是锁定测试的独立来源地址 */
const BASE_A6 = `http://[::1]:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;

const CHILD_PIN = "13572468";
const PARENT_PIN = "86421357";

const CONFIG_A = path.join(SERVER_ROOT, "config", "config.authtest.a.yaml");
const CONFIG_B = path.join(SERVER_ROOT, "config", "config.authtest.b.yaml");
const DB_A = path.join(SERVER_ROOT, "data", "_authtest_a.db");
const DB_B = path.join(SERVER_ROOT, "data", "_authtest_b.db");
const TTS_A = path.join(SERVER_ROOT, "data", "_authtest_a_tts");
const TTS_B = path.join(SERVER_ROOT, "data", "_authtest_b_tts");
const LOG_DIR = path.join(SERVER_ROOT, "logs", "_authtest");

/* --------------------------------------------------------------- 断言工具 */
let pass = 0;
const failures: string[] = [];
let currentGroup = "";

function group(name: string): void {
  currentGroup = name;
  console.log(`\n=== ${name} ===`);
}
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(`${currentGroup} · ${name}`);
    console.log(`  [FAIL] ${name}${detail ? `   → ${detail}` : ""}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* --------------------------------------------------------------- HTTP 封装 */
interface Resp {
  status: number;
  json: Record<string, unknown>;
  /** 只取 Cookie 头要的那一段（"g2sid=xxx"） */
  cookie: string;
  setCookie: string;
}

async function req(url: string, init: RequestInit = {}): Promise<Resp> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 非 JSON（如证书二进制） */
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { status: res.status, json, cookie: setCookie.split(";")[0] ?? "", setCookie };
}

const get = (base: string, p: string, cookie = ""): Promise<Resp> =>
  req(base + p, { headers: cookie ? { Cookie: cookie } : undefined });

const post = (base: string, p: string, body?: unknown, cookie = ""): Promise<Resp> =>
  req(base + p, {
    method: "POST",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

/* ------------------------------------------------------------------ 准备 */
function writeConfig(file: string, port: number, host: string, dbName: string, ttsName: string, forcePublic: boolean): void {
  // llm 指向一个没人监听的端口：这些用例一个 token 都不该花，
  // 真被调到会是「立刻 ECONNREFUSED」而不是等超时，跑得快也看得见。
  fs.writeFileSync(
    file,
    `server:
  port: ${port}
  host: "${host}"
  corsOrigins: []
  auth:
    enabled: true
    childPin: "${CHILD_PIN}"
    parentPin: "${PARENT_PIN}"
    sessionDays: 30
    lanBypass: true
    forcePublic: ${forcePublic}
db:
  driver: sqlite
  sqlite: { file: ./data/${dbName} }
llm:
  baseUrl: http://127.0.0.1:9/v1
  apiKey: sk-test-auth
  storyBaseUrl: http://127.0.0.1:9/v1
  markBaseUrl: http://127.0.0.1:9/v1
  storyModel: mock-auth
  markModel: mock-auth
  suggestModel: mock-auth
  timeoutMs: { story: 2000, mark: 2000, suggest: 2000 }
tts:
  provider: edge
  voice: zh-CN-XiaoyiNeural
  cacheDir: ./data/${ttsName}
logging:
  level: warn
  dir: ./logs/_authtest
backup:
  enabled: false
`,
    "utf8",
  );
}

function prepare(): void {
  for (const f of [
    CONFIG_A,
    CONFIG_B,
    DB_A,
    `${DB_A}-wal`,
    `${DB_A}-shm`,
    DB_B,
    `${DB_B}-wal`,
    `${DB_B}-shm`,
  ]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  for (const d of [TTS_A, TTS_B, LOG_DIR]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  writeConfig(CONFIG_A, PORT_A, "::", path.basename(DB_A), path.basename(TTS_A), true);
  writeConfig(CONFIG_B, PORT_B, "127.0.0.1", path.basename(DB_B), path.basename(TTS_B), false);
}

function startProc(script: string, label: string, env: Record<string, string> = {}): ChildProcess {
  const out = fs.openSync(path.join(SERVER_ROOT, "logs", `_authtest-${label}.log`), "w");
  return spawn(NODE, [TSX, script], {
    cwd: SERVER_ROOT,
    env: { ...process.env, ...env, FORCE_COLOR: "0" },
    stdio: ["ignore", out, out],
  });
}

async function waitHealthy(base: string, timeoutMs = 40000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  return false;
}

/* ------------------------------------------------------------------ 主流程 */
async function main(): Promise<void> {
  prepare();
  const appA = startProc(path.join("src", "index.ts"), "a", { CONFIG_PATH: CONFIG_A });
  const appB = startProc(path.join("src", "index.ts"), "b", { CONFIG_PATH: CONFIG_B });

  const [okA, okB] = await Promise.all([waitHealthy(BASE_A), waitHealthy(BASE_B)]);
  if (!okA || !okB) {
    console.error(`\n服务未能启动（A=${okA} B=${okB}），请看 logs/_authtest-a.log 与 _authtest-b.log`);
    appA.kill();
    appB.kill();
    process.exit(1);
  }

  try {
    /* ======================= N. 来源地址判定（纯函数） ======================= */
    group("N. 来源地址判定");
    ok("N1 回环 127.0.0.1 算内网", isPrivateAddress("127.0.0.1"));
    ok("N2 IPv6 回环 ::1 算内网", isPrivateAddress("::1"));
    ok("N3 IPv4-mapped 形式按 IPv4 判", isPrivateAddress("::ffff:192.168.1.5"));
    ok("N4 172.16.0.1 算内网（172.16/12）", isPrivateAddress("172.16.0.1"));
    ok("N5 172.32.0.1 不算内网（超出 172.16/12）", !isPrivateAddress("172.32.0.1"));
    ok("N6 公网 IPv6（240e:…）不算内网", !isPrivateAddress("240e:3b7:1:1000::1"));
    ok("N7 ULA fd00::1 算内网", isPrivateAddress("fd00::1"));
    ok("N8 链路本地 fe80::1 算内网", isPrivateAddress("fe80::1"));
    ok("N9 运营商级 NAT 100.64.0.1 不算内网", !isPrivateAddress("100.64.0.1"));
    ok("N10 拿不到地址时当作本机", isPrivateAddress(undefined));

    // 这一组是这次加固踩到的真坑：这台机器所在的内网是 172.10.10.0/24，
    // **不在 RFC1918 里**（私有的是 172.16–172.31）。光靠协议判定会把自家平板
    // 当成公网，于是每次打开都要输口令 —— 所以还要能「信任本机网卡所在网段」。
    ok("N11 172.10.10.25 不在 RFC1918 里（这是实情，不是 bug）", !isPrivateAddress("172.10.10.25"));
    ok("N12 但 172.10.10.25 落在 172.10.10.0/24 里", inCidr("172.10.10.25", "172.10.10.0/24"));
    ok("N13 172.10.11.25 不在 172.10.10.0/24 里", !inCidr("172.10.11.25", "172.10.10.0/24"));
    ok("N14 掩码为 0 时全都匹配", inCidr("8.8.8.8", "0.0.0.0/0"));
    ok("N15 IPv6 CIDR 匹配", inCidr("240e:3b7:1:1000::5", "240e:3b7:1:1000::/64"));
    ok("N16 IPv6 CIDR 不匹配另一段", !inCidr("240e:3b7:1:1001::5", "240e:3b7:1:1000::/64"));
    ok("N17 能自动识别出本机网段（家用场景靠它兜住非 RFC1918 的网段）", localSubnets().length > 0, JSON.stringify(localSubnets()));

    /* ========================= A. 公网 · 公开路径 ========================= */
    group("A. 公网 · 公开路径");
    const h = await get(BASE_A, "/api/health");
    ok("A1 /api/health 无需登录", h.status === 200, `status=${h.status}`);

    const me0 = await get(BASE_A, "/api/auth/me");
    ok(
      "A2 /api/auth/me 报告「需要登录」",
      me0.status === 200 && me0.json.enabled === true && me0.json.authed === false,
      JSON.stringify(me0.json),
    );
    eq("A3 me.exposed 为 true（确实被当成公网）", me0.json.exposed, true);

    const ca = await get(BASE_A, "/api/diag/rootca.crt");
    ok("A4 根证书仍可公开下载（否则平板装不了）", ca.status !== 401 && ca.status !== 403, `status=${ca.status}`);

    /* ====================== B. 公网 · 未登录一律拦住 ====================== */
    group("B. 公网 · 未登录一律拦住");
    const s0 = await get(BASE_A, "/api/state");
    ok("B1 /api/state 未登录 → 401", s0.status === 401, `status=${s0.status}`);
    eq("B2 kind=auth.required（前端据此弹口令框）", s0.json.kind, "auth.required");

    const v0 = await get(BASE_A, "/api/video/today");
    ok("B3 /api/video/today 未登录 → 401", v0.status === 401, `status=${v0.status}`);

    const ad0 = await get(BASE_A, "/api/admin/lessons");
    ok("B4 家长内容后台未登录 → 403", ad0.status === 403, `status=${ad0.status}`);
    eq("B5 kind=auth.parentOffsite", ad0.json.kind, "auth.parentOffsite");

    const bk0 = await post(BASE_A, "/api/backup/run");
    ok("B6 触发备份未登录 → 403", bk0.status === 403, `status=${bk0.status}`);

    const rs0 = await post(BASE_A, "/api/restore", { pack: { version: 2 } });
    ok("B7 覆盖数据未登录 → 403", rs0.status === 403, `status=${rs0.status}`);

    const lg0 = await get(BASE_A, "/api/diag/logs");
    ok("B8 读运行日志未登录 → 403", lg0.status === 403, `status=${lg0.status}`);

    /* =========================== C. 公网 · 登录 =========================== */
    group("C. 公网 · 登录");
    const bad = await post(BASE_A, "/api/auth/login", { pin: "00000000" });
    ok("C1 错口令 → 401", bad.status === 401, `status=${bad.status}`);
    eq("C2 kind=auth.badpin", bad.json.kind, "auth.badpin");
    eq("C3 会告诉还剩几次", bad.json.remaining, 4);

    const par = await post(BASE_A, "/api/auth/login", { pin: PARENT_PIN });
    ok("C4 公网用家长口令 → 403（不给猜解口）", par.status === 403, `status=${par.status}`);
    eq("C5 kind=auth.parentOffsite", par.json.kind, "auth.parentOffsite");

    const good = await post(BASE_A, "/api/auth/login", { pin: CHILD_PIN });
    ok("C6 孩子口令 → 200", good.status === 200 && good.json.ok === true, JSON.stringify(good.json).slice(0, 120));
    eq("C7 角色是 child", good.json.role, "child");
    ok("C8 下发了会话 cookie", /^g2sid=.+/.test(good.cookie), good.cookie.slice(0, 40));
    ok("C9 cookie 带 HttpOnly", /HttpOnly/i.test(good.setCookie), good.setCookie);
    ok("C10 cookie 带 SameSite=Strict", /SameSite=Strict/i.test(good.setCookie), good.setCookie);

    const SID = good.cookie;

    /* ======================== D. 公网 · 带着会话 ======================== */
    group("D. 公网 · 带着会话");
    const s1 = await get(BASE_A, "/api/state", SID);
    ok("D1 带会话读状态 → 200", s1.status === 200, `status=${s1.status}`);

    const me1 = await get(BASE_A, "/api/auth/me", SID);
    ok(
      "D2 me 报告已登录且角色是 child",
      me1.json.authed === true && me1.json.role === "child",
      JSON.stringify(me1.json),
    );

    const ad1 = await get(BASE_A, "/api/admin/lessons", SID);
    ok("D3 孩子的会话进不了内容后台 → 403", ad1.status === 403, `status=${ad1.status}`);

    const lg1 = await get(BASE_A, "/api/diag/logs", SID);
    ok("D4 孩子的会话读不了运行日志 → 403", lg1.status === 403, `status=${lg1.status}`);

    const pts1 = await get(BASE_A, "/api/points", SID);
    ok("D5 孩子的会话看不到全量积分流水 → 403", pts1.status === 403, `status=${pts1.status}`);

    const gen1 = await post(BASE_A, "/api/language/generate", { force: true }, SID);
    ok("D6 孩子的会话不能「再来一套」（会花钱）→ 403", gen1.status === 403, `status=${gen1.status}`);

    const gen0 = await post(BASE_A, "/api/language/generate", {}, SID);
    ok("D7 不带 force 的幂等出题没有被误伤", gen0.status !== 403, `status=${gen0.status}`);

    /* =========================== E. 公网 · 退出 =========================== */
    group("E. 公网 · 退出");
    const lo = await post(BASE_A, "/api/auth/logout", undefined, SID);
    ok("E1 退出登录 → 200", lo.status === 200, `status=${lo.status}`);
    const s2 = await get(BASE_A, "/api/state", SID);
    ok("E2 退出后旧 cookie 立刻失效 → 401", s2.status === 401, `status=${s2.status}`);

    /* ============ F. 公网 · IPv6 双栈与失败锁定（走 ::1，跟 127.0.0.1 互不干扰） ============ */
    group("F. 公网 · IPv6 可达与失败锁定");
    const h6 = await get(BASE_A6, "/api/health");
    ok("F1 监听 :: 之后 IPv6（[::1]）也能连上", h6.status === 200, `status=${h6.status}`);

    let lastStatus = 0;
    let lastJson: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) {
      const r = await post(BASE_A6, "/api/auth/login", { pin: "00000000" });
      lastStatus = r.status;
      lastJson = r.json;
    }
    ok(
      "F2 连错 5 次，第 5 次仍是 401 但剩余次数归零",
      lastStatus === 401 && lastJson.remaining === 0,
      `status=${lastStatus} remaining=${String(lastJson.remaining)}`,
    );

    const locked = await post(BASE_A6, "/api/auth/login", { pin: "00000000" });
    ok("F3 第 6 次 → 429 已锁定", locked.status === 429, `status=${locked.status}`);
    eq("F4 kind=auth.locked", locked.json.kind, "auth.locked");
    ok(
      "F5 会告知还要等多久",
      typeof locked.json.retryAfterSec === "number" && (locked.json.retryAfterSec as number) > 0,
      JSON.stringify(locked.json.retryAfterSec),
    );

    const lockedRight = await post(BASE_A6, "/api/auth/login", { pin: CHILD_PIN });
    ok("F6 锁定期间连正确口令也拒绝（不给暴力试的机会）", lockedRight.status === 429, `status=${lockedRight.status}`);

    const stillOk = await get(BASE_A, "/api/health");
    ok("F7 锁定只针对来源地址，127.0.0.1 不受影响", stillOk.status === 200, `status=${stillOk.status}`);

    /* ===================== G. 内网 · 照旧不受影响 ===================== */
    group("G. 内网 · 照旧不受影响");
    const meB = await get(BASE_B, "/api/auth/me");
    ok(
      "G1 内网 me 直接算已通过",
      meB.json.authed === true && meB.json.exposed === false,
      JSON.stringify(meB.json),
    );
    eq("G2 内网角色是 parent", meB.json.role, "parent");

    const sB = await get(BASE_B, "/api/state");
    ok("G3 内网不带任何 cookie 也能读状态 → 200", sB.status === 200, `status=${sB.status}`);

    const adB = await get(BASE_B, "/api/admin/lessons");
    ok("G4 内网直接进内容后台 → 200", adB.status === 200, `status=${adB.status}`);

    const lgB = await get(BASE_B, "/api/diag/logs");
    ok("G5 内网直接读运行日志 → 200", lgB.status === 200, `status=${lgB.status}`);
  } finally {
    appA.kill();
    appB.kill();
    await sleep(800);
  }

  // 两个实例都退出了再跑：它会改 CONFIG_PATH / AUTH_LAN_CIDRS
  configGroup();

  /* --------------------------------------------------- H. 配置解析（容器靠 env 传） */
/**
 * 为什么单独测这一组：容器部署时 lanCidrs 只能从环境变量来（env 里塞不进数组），
 * 必须确认「逗号分隔的字符串」也能变成 string[]。
 *
 * 这一条曾经静默失效过 —— 写错了不会报任何错，只会让「家里每次打开都要输口令」，
 * 而这种症状很容易被当成「IP 判定有问题」，很难往配置解析上想。
 *
 * 放在所有子进程都退出之后跑：它会临时改 CONFIG_PATH / AUTH_LAN_CIDRS，
 * 而这些环境变量会被 spawn 出去的实例继承。
 */
function configGroup(): void {
  group("H. 配置解析（lanCidrs 的两种写法）");
  const file = path.join(SERVER_ROOT, "config", "config.authtest.cfg.yaml");
  const yaml = (cidrs: string, pinLine = '    childPin: "12345678"'): string => `server:
  port: 8899
  host: 127.0.0.1
  corsOrigins: []
  auth:
    enabled: true
${pinLine}
    lanCidrs: ${cidrs}
db:
  driver: sqlite
  sqlite: { file: ./data/_authtest_cfg.db }
llm:
  baseUrl: http://127.0.0.1:9/v1
  apiKey: sk-test
  timeoutMs: { story: 2000, mark: 2000, suggest: 2000 }
logging:
  level: warn
  dir: ./logs/_authtest
backup:
  enabled: false
`;

  const oldPath = process.env.CONFIG_PATH;
  const oldCidrs = process.env.AUTH_LAN_CIDRS;
  const read = (cidrs: string, envValue?: string): string[] => {
    fs.writeFileSync(file, yaml(cidrs), "utf8");
    if (envValue === undefined) delete process.env.AUTH_LAN_CIDRS;
    else process.env.AUTH_LAN_CIDRS = envValue;
    return loadConfig(true).server.auth.lanCidrs;
  };

  try {
    process.env.CONFIG_PATH = file;
    eq("H1 环境变量为空 → 空数组（不是空字符串）", read(`"\${AUTH_LAN_CIDRS:-}"`, ""), []);
    eq(
      "H2 逗号分隔的字符串 → 切成两项（容器里就是这么传的）",
      read(`"\${AUTH_LAN_CIDRS:-}"`, "172.10.10.0/24,2408:8352:a13:2cb1::/64"),
      ["172.10.10.0/24", "2408:8352:a13:2cb1::/64"],
    );
    eq("H3 空格分隔也认", read(`"\${AUTH_LAN_CIDRS:-}"`, "10.0.0.0/8 192.168.0.0/16"), ["10.0.0.0/8", "192.168.0.0/16"]);
    eq("H4 config.yaml 里写数组仍然可用（原有写法不能坏）", read('["10.0.0.0/8"]', ""), ["10.0.0.0/8"]);

    /* ---- I：PIN 的引号位置（真实事故） --------------------------------------
     * 插值是「把值原样贴进 YAML 文本」，所以 `childPin: ${CHILD_PIN:-"84644229"}`
     * 遇上 8 位纯数字的环境变量会变成 YAML **数字** → z.string() 校验失败 →
     * **服务根本起不来**（报 expected string, received number）。
     * 引号写在 ${} 外面 —— `"${CHILD_PIN:-84644229}"` —— 才两头都对。
     * 环境变量用 ""（而不是 delete）表示「没配」：与 interpolate 的判据一致，
     * 也不受本机 deploy/.env 影响。
     */
    group("I. 配置解析（PIN：引号必须在 \${} 外面）");
    const OUTSIDE = '    childPin: "${CHILD_PIN:-84644229}"'; // 正确
    const INSIDE = '    childPin: ${CHILD_PIN:-"84644229"}'; //  事故写法
    const oldPin = process.env.CHILD_PIN;
    const readPin = (pinLine: string, envValue: string): string => {
      fs.writeFileSync(file, yaml('"${AUTH_LAN_CIDRS:-}"', pinLine), "utf8");
      process.env.CHILD_PIN = envValue;
      try {
        return loadConfig(true).server.auth.childPin;
      } catch (e) {
        return `ERR ${(e as Error).message.replace(/\s+/g, " ").slice(0, 50)}`;
      }
    };
    try {
      eq("I1 正确写法 + 环境变量是 8 位数字 → 原样拿到", readPin(OUTSIDE, "20181101"), "20181101");
      eq("I2 正确写法 + 没配环境变量 → 用默认值", readPin(OUTSIDE, ""), "84644229");
      eq("I3 事故写法 + 8 位数字也不能让服务起不来（兜底转字符串）", readPin(INSIDE, "20181101"), "20181101");
      eq("I4 事故写法 + 没配环境变量 → 默认值（默认值本来就带引号）", readPin(INSIDE, ""), "84644229");
      eq("I5 前导 0 只能靠引号保住（YAML 数字会把 00112233 吃掉）", readPin('    childPin: "${CHILD_PIN:-00112233}"', ""), "00112233");
      eq("I6 连引号都没写、裸数字也兜得回来", readPin("    childPin: 20181101", ""), "20181101");
      eq("I7 兜底不碰正常字符串", readPin('    childPin: "test-pin"', ""), "test-pin");
      process.env.CHILD_PIN = "20181101";
      eq("I8 来源判定：配了就是环境变量/.env", valueSource("CHILD_PIN"), "环境变量/.env");
      process.env.CHILD_PIN = "";
      eq("I9 来源判定：空值算 config.yaml 默认值（启动日志靠它定位「口令没读进去」）", valueSource("CHILD_PIN"), "config.yaml 默认值");
    } finally {
      if (oldPin === undefined) delete process.env.CHILD_PIN;
      else process.env.CHILD_PIN = oldPin;
    }
  } finally {
    if (oldPath === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = oldPath;
    if (oldCidrs === undefined) delete process.env.AUTH_LAN_CIDRS;
    else process.env.AUTH_LAN_CIDRS = oldCidrs;
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

console.log("\n" + "=".repeat(60));
  console.log(`总计 ${pass + failures.length} 项，通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("\n失败清单：");
    for (const f of failures) console.log("  · " + f);
  }
  console.log("=".repeat(60));

  cleanup();
  process.exit(failures.length ? 1 : 0);
}

function cleanup(): void {
  for (const f of [
    CONFIG_A,
    CONFIG_B,
    path.join(SERVER_ROOT, "config", "config.authtest.cfg.yaml"),
    DB_A,
    `${DB_A}-wal`,
    `${DB_A}-shm`,
    DB_B,
    `${DB_B}-wal`,
    `${DB_B}-shm`,
    path.join(SERVER_ROOT, "logs", "_authtest-a.log"),
    path.join(SERVER_ROOT, "logs", "_authtest-b.log"),
  ]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  for (const d of [TTS_A, TTS_B, LOG_DIR]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch(async (e) => {
  console.error("\n测试执行异常：", e);
  cleanup();
  process.exit(1);
});
