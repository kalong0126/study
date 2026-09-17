/**
 * 「每日口算自动计时」端到端回归测试
 *
 * 需求：进口算页自动开始计时，20 题做完后统计一个用时，显示在首页。
 *
 * 为什么要用隔离实例（端口 8798 + 独立 DB）：
 *   这个测试会把当天 20 道口算全部填上答案（= 真的会完成任务、写错题本）。
 *   跑在孩子的真实库上会污染他的学习数据，所以单开一份临时 DB，跑完即删。
 *
 * 覆盖点：
 *   1. 进页面**自动**开始计时（不需要点任何按钮）
 *   2. 「换一批题目」→ 计时归零
 *   3. 离开页面自动暂停（离开的那几分钟不算用时）
 *   4. 20 题做完 → 计时停住，不再增长
 *   5. 首页「每日口算」任务卡上显示用时，且与计时器一致
 *   6. 刷新后用时还在（说明确实存到了服务端，不是只活在内存里）
 *   7. 服务端对用时值做了校验（负数拒绝、超大值钳住）
 *
 * 用法：node web/test/math-timer.mjs     或   cd web && npm run test:mathtimer
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
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.mathtimer.yaml");
const TEST_DB = path.join(SERVER, "data", "_mathtimer.db");
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

/* ------------------------------------------------------- 隔离实例的配置 */
// 不调用任何大模型，所以 llm 段填占位值即可（只为让 config schema 通过）
const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_mathtimer.db }
llm:
  baseUrl: https://api.deepseek.com
  apiKey: test-key-not-used
  storyModel: deepseek-chat
  markModel: deepseek-chat
  suggestModel: deepseek-chat
  timeoutMs: { story: 60000, mark: 90000, suggest: 45000 }
  retries: 0
  temperature: { story: 0.9, mark: 0, suggest: 0.5 }
tts:
  provider: edge
  voice: zh-CN-XiaoyiNeural
  rate: "-12%"
  cacheDir: ./data/_mathtimer_tts
backup:
  enabled: false
  dir: ./data/_mathtimer_backup
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

/* --------------------------------------------------------------- 小工具 */
/** 从题干 "7 × 8 =" 算出答案 */
function answerOf(text) {
  const m = /(\d+)\s*([×+\-])\s*(\d+)/.exec(text || "");
  if (!m) return NaN;
  const a = Number(m[1]);
  const b = Number(m[3]);
  return m[2] === "×" ? a * b : m[2] === "+" ? a + b : a - b;
}

/** "3 分 12 秒" / "45 秒" → 秒 */
function parseDuration(s) {
  let m = /用时\s*(\d+)\s*分\s*(\d+)\s*秒/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /用时\s*(\d+)\s*分(?!\s*\d)/.exec(s);
  if (m) return Number(m[1]) * 60;
  m = /用时\s*(\d+)\s*秒/.exec(s);
  if (m) return Number(m[1]);
  return -1;
}

let server;
let browser;
let page;

/** 当前计时器秒数（读 "MM:SS"） */
async function clockSec() {
  const t = await page.locator(".timer-clock").first().innerText();
  const m = /(\d+):(\d+)/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}
const isRunning = () => page.locator(".timer-clock").first().evaluate((el) => el.classList.contains("run"));
async function gotoNav(label) {
  await page.locator("nav.nav a", { hasText: label }).first().click();
  await page.waitForTimeout(1400);
}

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

  browser = await chromium.launch({
    executablePath:
      "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  /* ————————————————————————————— 0. 打开口算页 */
  step("0. 打开口算页");
  await page.goto(`${BASE}/math`, { waitUntil: "networkidle" });
  await page.waitForSelector(".m-row", { timeout: 20000 });
  const rows = await page.locator(".m-row").count();
  ok("20 道题已渲染", rows === 20, `${rows} 行`);
  ok("计时器已出现在页面上", (await page.locator(".timer-clock").count()) === 1);

  /* ————————————————————————————— 1. 自动计时 */
  step("1. 自动计时：进页面就开始走（不用点任何按钮）");
  const t0 = await clockSec();
  ok("计时器处于「计时中」样式", await isRunning());
  await page.waitForTimeout(3500);
  const t1 = await clockSec();
  ok("计时自动往前走", t1 >= t0 + 2, `${t0}s → ${t1}s`);

  /* ————————————————————————————— 2. 换一批 → 归零 */
  step("2.「换一批题目」→ 计时归零");
  await page.locator("button", { hasText: "换一批题目" }).click();
  await page.waitForTimeout(1500);
  const t2 = await clockSec();
  ok("换题后计时归零", t2 <= 2, `clock=${t2}s（换之前是 ${t1}s）`);
  const answeredText = (await page.locator(".progress-line").first().innerText()).replace(/\s+/g, " ");
  ok("换题后回到 0 / 20", /已作答\s*0\s*\/\s*20/.test(answeredText), answeredText);

  /* ————————————————————————————— 3. 离开页面暂停 */
  step("3. 离开页面自动暂停（离开的时间不算用时）");
  await page.waitForTimeout(2500); // 先在页面上正常跑 2.5 秒
  const before = await clockSec();
  await gotoNav("今日");
  await page.waitForTimeout(6000); // 在首页停留 6 秒（这段时间不该被计入）
  await gotoNav("口算");
  const after = await clockSec();
  ok(
    "离开的那 6 秒没有被计入用时",
    after - before < 4,
    `离开前 ${before}s → 回来后 ${after}s（相隔约 ${after - before}s，若把 6 秒算进去会 ≥6）`,
  );

  /* ————————————————————————————— 4. 做完 → 停表 */
  step("4. 20 题全部做完 → 计时停住");
  const questions = await page
    .locator(".m-row .m-q")
    .evaluateAll((els) => els.map((e) => (e.textContent || "").trim()));
  for (let i = 0; i < questions.length; i++) {
    const ans = answerOf(questions[i]);
    if (!Number.isFinite(ans)) {
      ok(`第 ${i + 1} 题能算出答案`, false, `题干=${questions[i]}`);
      break;
    }
    await page.locator(".m-row").nth(i).locator("input.m-in").fill(String(ans));
    await page.waitForTimeout(90);
  }
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector(".progress-line");
        return /已作答\s*20\s*\/\s*20/.test(el ? el.textContent || "" : "");
      },
      { timeout: 30000 },
    )
    .catch(() => undefined);
  const doneText = (await page.locator(".progress-line").first().innerText()).replace(/\s+/g, " ");
  ok("20 题全部作答", /已作答\s*20\s*\/\s*20/.test(doneText), doneText);

  const t3 = await clockSec();
  await page.waitForTimeout(3500);
  const t4 = await clockSec();
  ok("做完后计时停住、不再增长", t4 === t3, `${t3}s → ${t4}s`);
  ok("做完后计时器不再是「计时中」样式", (await isRunning()) === false);
  const timerBox = (await page.locator(".timer-box").first().innerText()).replace(/\s+/g, " ");
  ok("口算页上显示「用时」", /用时/.test(timerBox), timerBox.slice(0, 70));

  /* ————————————————————————————— 5. 首页显示用时 */
  step("5. 首页「口算岛」显示用时");
  await gotoNav("今日");
  const mathCard = (await page.locator("button.isle").first().innerText()).replace(/\s+/g, " ");
  ok("首页口算岛上出现「用时」", /用时/.test(mathCard), mathCard);
  const homeSec = parseDuration(mathCard);
  ok(
    "首页用时与口算页计时一致",
    homeSec >= 0 && Math.abs(homeSec - t3) <= 2,
    `首页 ${homeSec}s vs 计时器 ${t3}s`,
  );

  /* ————————————————————————————— 6. 刷新后仍在（服务端持久化） */
  step("6. 刷新后用时仍在（说明存在服务端）");
  // 回写是异步的，给它最多 6 秒落地（正常情况 1 次就够）
  let snap = null;
  for (let i = 0; i < 20; i++) {
    snap = await (await fetch(`${BASE}/api/state`)).json();
    if (Number.isFinite(snap.mathElapsedMs) && snap.mathElapsedMs > 0) break;
    await sleep(300);
  }
  ok(
    "/api/state 里带 mathElapsedMs",
    Number.isFinite(snap.mathElapsedMs) && snap.mathElapsedMs > 0,
    `ms=${snap.mathElapsedMs}`,
  );
  await page.goto(`${BASE}/math`, { waitUntil: "networkidle" });
  await page.waitForSelector(".m-row", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const t5 = await clockSec();
  ok("整页刷新后用时保持不变", Math.abs(t5 - t3) <= 1, `刷新前 ${t3}s → 刷新后 ${t5}s`);

  /* ————————————————————————————— 7. 服务端校验 */
  step("7. 服务端的用时校验（负数拒绝 / 超大值钳住）");
  const badRes = await fetch(`${BASE}/api/state/math/elapsed`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ms: -1 }),
  });
  ok("负数用时被拒绝（400）", badRes.status === 400, `HTTP ${badRes.status}`);
  await fetch(`${BASE}/api/state/math/elapsed`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ms: 999999999 }),
  });
  const afterHuge = await (await fetch(`${BASE}/api/state`)).json();
  ok(
    "超大用时被钳到 6 小时以内",
    afterHuge.mathElapsedMs <= 6 * 60 * 60 * 1000,
    `ms=${afterHuge.mathElapsedMs}`,
  );

  /* ————————————————————————————— 8. 控制台 */
  step("8. 控制台");
  ok("零 console error / 零未捕获异常", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
} catch (e) {
  ok("执行过程无异常", false, e instanceof Error ? e.message : String(e));
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
  for (const d of ["_mathtimer_tts", "_mathtimer_backup"]) {
    try {
      fs.rmSync(path.join(SERVER, "data", d), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`口算计时回归：通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  console.log("=".repeat(60));
  process.exit(failures.length ? 1 : 0);
}
