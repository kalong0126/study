/**
 * 公网口令门（LockGate）浏览器回归
 *
 * 为什么单独一个测试：加固后「公网打开这个网址」看到的第一个界面就是口令门，
 * 它一旦坏掉，孩子**连进都进不去** —— 而服务端那 60 条断言（auth.test.ts）
 * 只看得到 401 / 403 的状态码，看不出前端到底有没有把门画出来。
 *
 * 隔离实例：8792 端口 + 临时 config + 独立 DB，并且**故意开 forcePublic=true**
 * 把来源地址是 127.0.0.1 的请求也当成公网 —— 否则在回环地址上恒为「内网免口令」，
 * 这条路根本走不到。
 *
 * 用法：npm run test:authui   （在 web/ 下）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SERVER = path.join(REPO, "server");
const SHOTS = path.join(HERE, "shots");

const PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}`;
const CHILD_PIN = "13572468";
const CONFIG = path.join(SERVER, "config", "config.authuitest.yaml");
const DB = path.join(SERVER, "data", "_authuitest.db");
const NODE = "C:/Users/kalon/.workbuddy/binaries/node/versions/22.22.2-3/node.exe";

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? `   → ${detail}` : ""}`);
  }
};
const step = (name) => console.log(`\n=== ${name} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth:
    enabled: true
    childPin: "${CHILD_PIN}"
    parentPin: "86421357"
    sessionDays: 30
    lanBypass: true
    forcePublic: true
db:
  driver: sqlite
  sqlite: { file: ./data/_authuitest.db }
llm:
  baseUrl: http://127.0.0.1:9/v1
  apiKey: sk-test-authui
  storyBaseUrl: http://127.0.0.1:9/v1
  markBaseUrl: http://127.0.0.1:9/v1
  storyModel: mock-authui
  markModel: mock-authui
  suggestModel: mock-authui
  timeoutMs: { story: 2000, mark: 2000, suggest: 2000 }
  retries: 0
tts:
  provider: edge
  voice: zh-CN-XiaoyiNeural
  cacheDir: ./data/_authuitest_tts
imagegen:
  enabled: false
  dir: ./data/_authuitest_images
video:
  enabled: false
  dir: ./data/_authuitest_video
logging:
  level: warn
  dir: ./logs/_authuitest
backup:
  enabled: false
  dir: ./data/_authuitest_backup
`;

function startServer() {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, TEST_CONFIG_YAML, "utf8");
  const out = fs.openSync(path.join(SERVER, "logs", "_authuitest-server.log"), "w");
  return spawn(NODE, ["node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
    cwd: SERVER,
    env: { ...process.env, CONFIG_PATH: CONFIG, FORCE_COLOR: "0" },
    stdio: ["ignore", out, out],
  });
}

async function waitHealthy(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  return false;
}

function cleanup() {
  for (const f of [CONFIG, DB, `${DB}-wal`, `${DB}-shm`, path.join(SERVER, "logs", "_authuitest-server.log")]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  for (const d of ["_authuitest_tts", "_authuitest_images", "_authuitest_video", "_authuitest_backup"]) {
    try {
      fs.rmSync(path.join(SERVER, "data", d), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(path.join(SERVER, "logs", "_authuitest"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ 主流程 */
const server = startServer();
let browser;
try {
  if (!(await waitHealthy())) {
    console.error("隔离实例没起来，请看 server/logs/_authuitest-server.log");
    process.exit(1);
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  browser = await chromium.launch({
    executablePath: "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    args: ["--no-sandbox"],
  });
  // 同一个 context 贯穿全程：cookie 要留着，才能验证「登录一次就记住了」
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 900 },
    deviceScaleFactor: 2,
    hasTouch: true,
  });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const text = `${m.type()}: ${m.text()}`;
    if (/favicon/i.test(text)) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const visible = (sel) => page.locator(sel).first().isVisible().catch(() => false);
  const count = (sel) => page.locator(sel).count();
  const textOf = async (sel) => (await page.locator(sel).first().textContent().catch(() => ""))?.trim() ?? "";

  /** 按数字键盘输入一串口令（满 8 位前端会自动提交） */
  async function typePin(pin) {
    for (const d of pin) {
      await page.locator(".lk-key", { hasText: new RegExp(`^${d}$`) }).first().click({ timeout: 5000 });
      await page.waitForTimeout(90);
    }
    await page.waitForTimeout(1200);
  }

  /* ------------------------------------------------- 1. 未登录：只给口令门 */
  step("1. 公网未登录 → 整屏口令门（且不泄露孩子端界面）");
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".lk", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  ok("出现口令门 .lk", await visible(".lk"), "没渲染出来");
  ok("标题是「请输入口令」", (await textOf(".lk-title")) === "请输入口令", await textOf(".lk-title"));
  ok("口令门上有说明文案（hint）", (await textOf(".lk-sub")).length > 0, await textOf(".lk-sub"));

  const keys = await count(".lk-key");
  ok("数字键盘 12 键（0-9 + 删除 + 进入）", keys === 12, `实际=${keys}`);
  ok("8 个口令位", (await count(".lk-dots span")) === 8, `实际=${await count(".lk-dots span")}`);
  ok("底部告诉孩子「口令由家长设置」", /家长/.test(await textOf(".lk-foot")), await textOf(".lk-foot"));

  // 这一条是安全断言：锁着的时候绝不能顺手把孩子端壳子画出来
  const navLocked = await count("nav.nav a");
  ok("未登录时看不到孩子端底部导航", navLocked === 0, `导航项=${navLocked}`);
  ok("未登录时没有入口能点到家长后台", (await count('a[href*="/admin"]')) === 0);

  await page.screenshot({ path: path.join(SHOTS, "auth-01-locked.png") });

  // 到这里为止一个错都不该有。这一条专门守住「首次加载别乱发请求」：
  // 万一哪天启动流程把 authMe 挪到了拉数据之后，孩子端会在锁着的时候先打一堆 401，
  // 表现就是控制台刷红 + 页面先闪一下壳子 —— 这里能立刻发现。
  ok("首次加载到口令门为止，控制台零错误", consoleErrors.length === 0, consoleErrors.join(" | "));

  /* ------------------------------------------------- 2. 口令错误：给得出人话 */
  step("2. 口令错误 → 原地报错、清空、可重试");
  await typePin("00000000");
  const errText = await textOf(".lk-msg");
  ok("报错文案来自后端（提到「口令不对」）", /口令不对/.test(errText), errText);
  ok("报错时口令位已清空（不会让人接着输成 9 位）", (await count(".lk-dots span.on")) === 0);
  ok("报错时仍停在口令门，没有误放行", (await visible(".lk")) && (await count("nav.nav a")) === 0);
  await page.screenshot({ path: path.join(SHOTS, "auth-02-badpin.png") });

  /* --------------------------------------------- 3. 口令正确：进入孩子端 */
  step("3. 口令正确 → 自动提交并进入孩子端");
  await typePin(CHILD_PIN);
  await page.waitForSelector(".wrap", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);

  ok("口令门已消失", !(await visible(".lk")), "口令门还在");
  const navAfter = await count("nav.nav a");
  ok("孩子端底部导航渲染出来了（≥5 项）", navAfter >= 5, `导航项=${navAfter}`);
  const bodyText = await textOf("body");
  ok("首页出现「今日」", /今日/.test(bodyText));
  ok("没有落进致命错误页", (await count(".fatal-box")) === 0);
  await page.screenshot({ path: path.join(SHOTS, "auth-03-unlocked.png") });

  /* ------------------------------------------- 4. 刷新后不必重输（cookie） */
  step("4. 刷新一次 → 30 天会话仍在（不该每次打开都输）");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".wrap", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  ok("刷新后直接进孩子端，没再弹口令门", !(await visible(".lk")), "又被要求输口令了");
  ok("刷新后导航仍在", (await count("nav.nav a")) >= 5);

  /* ---------------------------------- 5. 公网深链家长页：后端拒、前端不白屏 */
  step("5. 公网直接敲 /admin → 后端 403，孩子端不被锁死");
  const adminRes = await ctx.request.get(`${BASE}/api/admin/lessons`);
  ok("孩子的会话访问家长接口 → 403", adminRes.status() === 403, `status=${adminRes.status()}`);
  const adminBody = await adminRes.json().catch(() => ({}));
  ok("403 的 kind 是 auth.parentOffsite", adminBody.kind === "auth.parentOffsite", JSON.stringify(adminBody));

  /* ------------------------------------------------------------ 6. 控制台 */
  step("6. 控制台");
  // 故意输错口令（401）、故意撞家长接口（403）都会让浏览器自己记一条
  // "Failed to load resource: the server responded with a status of 401/403"。
  // 这是**预期内**的，跟业务代码无关，所以按状态码放行，其余一律不允许出现。
  const realErrors = consoleErrors.filter((t) => !/status of (401|403)/i.test(t));
  ok("除「故意打错的 401/403」外，无其它控制台错误", realErrors.length === 0, realErrors.join(" | "));
  ok("确实收到了预期内的那条 401（说明口令错误路径被真实走到了）", /status of 401/i.test(consoleErrors.join(" | ")));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
  await sleep(900);
  cleanup();
}

console.log("\n" + "=".repeat(60));
console.log(`公网口令门回归：通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log("\n失败清单：");
  for (const f of failures) console.log("  · " + f);
}
console.log("=".repeat(60));
process.exit(failures.length ? 1 : 0);
