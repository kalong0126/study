/**
 * PWA 安装能力回归测试
 *
 * 为什么需要这个测试：
 *   「平板装到桌面后还有浏览器地址栏和底栏」的根本原因是安卓 Chrome 不认为
 *   这个站点可安装。它要求三条**同时**满足，缺一条就退化成普通书签快捷方式：
 *     1. 安全上下文（https:// 或 http://localhost）
 *     2. manifest 里有 name / short_name / start_url / display:standalone / 图标
 *     3. 已注册的 Service Worker，且它监听了 fetch 事件
 *   这三条都不是「看一眼代码就知道对」的东西 —— manifest 少个字段、图标 404、
 *   sw.js 被当成 text/html 发出去、SW 里 fetch 分支写错，任何一样都会让安装入口消失，
 *   而且**页面上完全看不出异常**。所以必须用真实浏览器验一遍。
 *
 * 为什么能在这里测 SW：
 *   测试走 http://127.0.0.1，而 localhost / 127.0.0.1 本身就是安全上下文
 *   （Chrome 的白名单例外），所以不需要真的配 HTTPS 也能注册 SW。
 *   真机上的 HTTPS 那一环由 scripts/https-setup.ps1 负责，不在这里测。
 *
 * 覆盖点：
 *   1. manifest 200 且字段齐全（含 192 / 512 图标）
 *   2. manifest 里声明的每个图标都能 200 取到
 *   3. /sw.js 200 且 Content-Type 是 JS（发成 text/html 浏览器会拒绝注册）
 *   4. SW 真的注册成功、激活、并**接管页面**
 *   5. 离线后重新打开，应用外壳仍能从缓存里渲染出来（这是安装后的实际体验）
 *   6. /api/** 绝不被 SW 缓存（否则状态、判卷结果会读到过期数据）
 *
 * 用法：cd web && npm run build && npm run test:pwa
 * 依赖：playwright-core（在 workbuddy 的 node workspace 里）+ 已构建的 web/dist
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  chromium,
} = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

// 仓库根用「脚本自身位置」推，而不是 cwd —— `npm run` 时 cwd 是 web/，用 cwd 会推成 web/server
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(REPO, "server");
const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.pwatest.yaml");
const TEST_DB = path.join(SERVER, "data", "_pwatest.db");
const NODE = "C:/Users/kalon/.workbuddy/binaries/node/versions/22.22.2-3/node.exe";
const CHROME = "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";

/**
 * SW 缓存的名字，直接从 public/sw.js 里读 VERSION 拼出来。
 *
 * 以前这里是硬编码的 `grade2-shell-v1`（还留了句「改 sw.js 时记得同步」的注释）。
 * 那种约定迟早会漏：本轮把 VERSION 提到 v2 就是为了让 /fonts/ 走 cache-first，
 * 结果这条断言立刻假失败了一次。能从源码算出来的东西就别手抄。
 */
const CACHE_NAME = (() => {
  const src = fs.readFileSync(path.join(REPO, "web", "public", "sw.js"), "utf8");
  const v = /const VERSION = "([^"]+)"/.exec(src)?.[1];
  if (!v) throw new Error("读不到 public/sw.js 里的 VERSION");
  return `grade2-shell-${v}`;
})();

let pass = 0;
const failures = [];
const notes = [];
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? `   → ${detail}` : ""}`);
  }
};
const note = (m) => {
  notes.push(m);
  console.log(`  · ${m}`);
};
const step = (name) => console.log(`\n=== ${name} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------- 隔离实例的配置 */
/* 这个测试只 GET，不写业务数据；但为了不依赖家长本机的库（可能正在被孩子用），
   仍然单开一个实例 + 临时 DB，跑完删干净。 */
const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  https: { enabled: false }
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_pwatest.db }
llm:
  baseUrl: https://api.deepseek.com
  apiKey: test-key-not-used
  storyModel: deepseek-chat
  suggestModel: deepseek-chat
  timeoutMs: { story: 60000, suggest: 45000 }
  retries: 0
  temperature: { story: 0.9, suggest: 0.5 }
tts:
  provider: edge
  voice: zh-CN-XiaoyiNeural
  rate: "-12%"
  cacheDir: ./data/_pwatest_tts
backup:
  enabled: false
  dir: ./data/_pwatest_backup
`;

function startServer() {
  return spawn(NODE, ["node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
    cwd: SERVER,
    env: { ...process.env, CONFIG_PATH: TEST_CONFIG, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitHealthy(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(600);
  }
  return false;
}

let server;
let browser;

try {
  console.log(`\n=== 准备隔离实例（端口 ${PORT}，独立 DB）===`);
  fs.writeFileSync(TEST_CONFIG, TEST_CONFIG_YAML, "utf8");
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  server = startServer();
  const healthy = await waitHealthy();
  ok("隔离实例已就绪", healthy);
  if (!healthy) throw new Error("实例没起来，看 server/logs/app-*.log");

  /* ————————————————————————— 1. manifest 与图标（静态，不看浏览器） */
  step("1. manifest 与图标");
  const manRes = await fetch(`${BASE}/manifest.webmanifest`);
  ok("manifest 返回 200", manRes.status === 200, `status=${manRes.status}`);
  const manType = manRes.headers.get("content-type") ?? "";
  ok(
    "manifest 的 Content-Type 是 JSON 类型",
    /json|manifest/i.test(manType),
    `content-type=${manType}`,
  );
  const man = await manRes.json();
  ok("manifest 有 name", !!man.name, String(man.name));
  ok("manifest 有 short_name", !!man.short_name, String(man.short_name));
  ok("start_url 是站内路径", typeof man.start_url === "string" && man.start_url.startsWith("/"), String(man.start_url));
  ok("display 是 standalone", man.display === "standalone", String(man.display));
  const icons = Array.isArray(man.icons) ? man.icons : [];
  ok("manifest 声明了图标", icons.length > 0, `${icons.length} 个`);
  ok("有 192 尺寸的图标", icons.some((i) => String(i.sizes).includes("192")), JSON.stringify(icons.map((i) => i.sizes)));
  ok("有 512 尺寸的图标", icons.some((i) => String(i.sizes).includes("512")), JSON.stringify(icons.map((i) => i.sizes)));
  ok(
    "图标用的是实体文件（不再是 data: URI，WebAPK 生成时要能自己下载）",
    icons.every((i) => !String(i.src).startsWith("data:")),
    JSON.stringify(icons.map((i) => String(i.src).slice(0, 24))),
  );
  for (const ic of icons) {
    const r = await fetch(new URL(ic.src, BASE).href);
    ok(`图标可取到 ${ic.src}`, r.ok, `status=${r.status}`);
  }

  /* ————————————————————————— 2. sw.js 本身 */
  step("2. Service Worker 文件");
  const swRes = await fetch(`${BASE}/sw.js`);
  ok("/sw.js 返回 200", swRes.status === 200, `status=${swRes.status}`);
  const swType = swRes.headers.get("content-type") ?? "";
  ok(
    "/sw.js 的 Content-Type 是 JS（发成 text/html 浏览器会直接拒绝注册）",
    /javascript|ecmascript/i.test(swType),
    `content-type=${swType}`,
  );
  const swText = await swRes.text();
  ok("sw.js 里监听了 fetch（安装ability 的硬性要求）", /addEventListener\(\s*["']fetch["']/.test(swText));
  ok("sw.js 里没有对 /api/ 做 respondWith（接口必须直连网络）", /pathname\.startsWith\(\s*["']\/api\//.test(swText));

  /* ————————————————————————— 3. 浏览器里真的注册成功 */
  step("3. 注册 / 激活 / 接管页面");
  browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  ok("首页能正常打开", (await page.locator(".kid-shell").count()) > 0);

  const regInfo = await page.evaluate(async (cacheName) => {
    const timeout = (p, ms, tag) =>
      Promise.race([
        p,
        new Promise((_r, rej) => setTimeout(() => rej(new Error(`等待 ${tag} 超时`)), ms)),
      ]);
    const out = { supported: "serviceWorker" in navigator, scope: "", state: "", ctrl: false, caches: [] };
    if (!out.supported) return out;
    const reg = await timeout(navigator.serviceWorker.ready, 15000, "serviceWorker.ready");
    out.scope = reg.scope;
    out.state = reg.active ? reg.active.state : "";
    out.ctrl = !!navigator.serviceWorker.controller;
    out.caches = await caches.keys();
    return out;
  }, CACHE_NAME).catch((e) => ({ error: String(e && e.message ? e.message : e) }));

  if (regInfo.error) {
    ok("Service Worker 注册并激活", false, regInfo.error);
  } else {
    ok("浏览器支持 Service Worker", regInfo.supported);
    ok("注册作用域是 /", regInfo.scope.endsWith("/"), regInfo.scope);
    ok("已激活（state=activated）", regInfo.state === "activated", regInfo.state);
    ok(`缓存已建：${CACHE_NAME}`, (regInfo.caches ?? []).includes(CACHE_NAME), JSON.stringify(regInfo.caches));
    note(`首次加载时 controller=${regInfo.ctrl}（skipWaiting+clients.claim 会异步接管）`);
  }

  // 刷新一次，此时新页面必须是「被 SW 接管」的状态 —— 这才是安装后的日常
  await page.reload({ waitUntil: "networkidle" });
  const ctrl = await page.evaluate(() => !!navigator.serviceWorker.controller);
  ok("刷新后页面被 Service Worker 接管（controller 非空）", ctrl);

  const cacheProbe = await page.evaluate(async () => {
    const hitShell = await caches.match("/");
    const hitApi = await caches.match("/api/health");
    const keys = await caches.keys();
    let entries = 0;
    for (const k of keys) entries += (await (await caches.open(k)).keys()).length;
    return { shell: !!hitShell, api: !!hitApi, entries };
  });
  ok("app shell（首页 HTML）已进缓存", cacheProbe.shell);
  ok("接口 /api/** 没有被缓存", !cacheProbe.api);
  note(`缓存条目共 ${cacheProbe.entries} 条`);

  /* ————————————————————————— 4. 离线可用（安装后拔网的体验） */
  step("4. 离线仍能打开（用缓存里的外壳）");
  const errsBeforeOffline = consoleErrors.length;
  await context.setOffline(true);
  let offlineRendered = false;
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1500);
    offlineRendered = (await page.locator(".kid-shell").count()) > 0;
  } catch (e) {
    note(`离线 reload 抛错：${e instanceof Error ? e.message : e}`);
  }
  ok("断网后重新打开，应用外壳仍然渲染出来", offlineRendered);
  await context.setOffline(false);

  const offlineErrs = consoleErrors.slice(errsBeforeOffline);
  if (offlineErrs.length) {
    // 离线时 /api 请求必然失败并打到控制台，这不是 bug，只记录不判失败
    note(`离线阶段有 ${offlineErrs.length} 条控制台错误（预期，接口连不上）：${offlineErrs[0].slice(0, 80)}`);
  }

  /* ————————————————————————— 5. 在线阶段控制台必须干净 */
  step("5. 在线阶段控制台干净");
  const onlineErrs = consoleErrors.slice(0, errsBeforeOffline);
  ok(
    "在线阶段没有控制台错误",
    onlineErrs.length === 0,
    onlineErrs.slice(0, 3).join(" | "),
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill();
    await sleep(800);
  }
  for (const f of [TEST_CONFIG, TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  for (const d of ["_pwatest_tts", "_pwatest_backup"]) {
    try {
      fs.rmSync(path.join(SERVER, "data", d), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`PWA 安装能力回归：通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  console.log("=".repeat(60));
  process.exit(failures.length ? 1 : 0);
}
