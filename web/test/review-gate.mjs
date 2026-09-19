/**
 * 「错题复习」开闸 + 目标题数端到端回归测试
 *
 * 用户报的两个问题：
 *   1. 「明明只错了一道，却写着 3 道，把那 1 道修正了任务还是没完成」——
 *      分母写死成 3，而错题本里只有 1 道，永远凑不满。
 *   2. 「错题修复必须在口算和听写都完成之后才能进行，否则错题数量不稳定」——
 *      这两项会往错题本里加题，边做边复习的话「要复习几道」一直在变。
 *
 * 现在的规则：
 *   · 口算 + 听写都完成 → 才开闸；没开闸时错题只给看，输入框禁用
 *   · 开闸那一刻取 `min(3, 当时待复习错题数)` 当目标，并**冻结**（重复开闸不改）
 *   · 错题本被清空（家长后台清空）→ 目标 0，直接算完成，不会卡在「差几道」
 *
 * 为什么用隔离实例（端口 8796 + 独立 DB）：本测试要制造错题、还要改打卡状态，
 * 跑在孩子的真实库上会污染数据。
 *
 * 用法：node web/test/review-gate.mjs   或   cd web && npm run test:review
 * 依赖：playwright-core + 已构建的 web/dist
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

// 仓库根按「脚本自身位置」推，不能用 cwd —— `npm run` 时 cwd 是 web/
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(REPO, "server");
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.reviewgate.yaml");
const TEST_DB = path.join(SERVER, "data", "_reviewgate.db");
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
const squash = (s) => String(s || "").replace(/\s+/g, "");

const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_reviewgate.db }
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
  cacheDir: ./data/_reviewgate_tts
backup:
  enabled: false
  dir: ./data/_reviewgate_backup
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

/* ------------------------------------------------------------------ HTTP */
const jreq = (method, p, body) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const jpatch = (p, body) => jreq("PATCH", p, body);
const state = async () => (await fetch(`${BASE}/api/state`)).json();
const dailyOf = async () => (await state()).daily ?? {};
const wrongMath = async () => (await state()).wrong?.math ?? [];

/** 从题干 "7 × 8 =" 算出正确答案 */
function answerOf(text) {
  const m = /(\d+)\s*([×+\-−])\s*(\d+)/.exec(text || "");
  if (!m) return NaN;
  const a = Number(m[1]);
  const b = Number(m[3]);
  return m[2] === "×" ? a * b : m[2] === "+" ? a + b : a - b;
}

/** 位数相同但肯定不对的答案（口算页要长度对齐才判错） */
function wrongSameLen(ansStr) {
  const nines = "9".repeat(ansStr.length);
  return nines === ansStr ? "1".repeat(ansStr.length) : nines;
}

let server;
let browser;
let page;

import { goNav } from "./_kidnav.mjs";

/** 切到某个功能页：底部导航已去掉，改成「回首页 → 点对应的小岛」（见 _kidnav.mjs） */
const gotoNav = (label) => goNav(page, BASE, label, { wait: 1200 });

/** 重载错题页并等界面稳下来：客户端的 watch 会在此时自动开闸 */
async function reloadWrong() {
  // 用 goto 而不是 reload —— reload 会重载「当前所在页」，而调用点可能在首页
  await page.goto(`${BASE}/wrong`, { waitUntil: "networkidle" });
  await page.waitForSelector(".seg-btn", { timeout: 15000 });
  await page.waitForTimeout(900);
}

/** 错题页工具栏右上角那个「重新挑战 x / y」的进度胶囊（别撞上顶栏的今日进度） */
const reviewPill = () => page.locator(".pt .stat-pill").first();

/** 回首页，返回「错题修理站」那座岛 */
async function reviewIsle() {
  await gotoNav("今日");
  const el = page.locator("button.isle", { hasText: "错题修理站" }).first();
  await el.waitFor({ timeout: 15000 });
  return el;
}

/** 轮询直到 fn() 返回真值 */
async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await page.waitForTimeout(120);
  }
}

try {
  console.log(`\n=== 准备隔离实例（端口 ${PORT}，独立 DB）===`);
  fs.writeFileSync(TEST_CONFIG, TEST_CONFIG_YAML, "utf8");
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  server = startServer();
  const healthy = await waitHealthy();
  ok("隔离实例已就绪", healthy);
  if (!healthy) throw new Error("实例没起来，看 server/logs/app-*.log");

  browser = await chromium.launch({
    executablePath: "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const shotDir = path.join(REPO, "web", "test", "shots");
  fs.mkdirSync(shotDir, { recursive: true });

  /* ————————————————————————— 1. 只错 1 道（走真实链路：口算页答错） */
  step("1. 在口算页故意答错 1 题（走真实链路制造错题）");
  await page.goto(`${BASE}/math`, { waitUntil: "networkidle" });
  await page.waitForSelector(".m-row", { timeout: 20000 });
  const texts = await page
    .locator(".m-row .m-q")
    .evaluateAll((els) => els.map((e) => (e.textContent || "").trim()));
  const firstText = texts[0];
  const firstAns = answerOf(firstText);
  ok("口算页渲染出 20 道题", texts.length === 20, `${texts.length} 题`);
  ok("第一题能算出答案", Number.isFinite(firstAns), firstText);

  const firstInput = page.locator(".m-row").nth(0).locator("input.m-in");
  await firstInput.fill(wrongSameLen(String(firstAns)));
  await firstInput.press("Enter");
  await page.waitForTimeout(900);

  const seeded = await wrongMath();
  ok("错题本里正好 1 道数学错题", seeded.length === 1, `${seeded.length} 道：${seeded.map((x) => x.payload?.text).join(",")}`);
  const oneText = String(seeded[0]?.payload?.text ?? "");
  const oneAns = String(seeded[0]?.payload?.ans ?? "");
  ok("这道错题记了题干和答案", oneText.length > 0 && oneAns.length > 0, `${oneText} → ${oneAns}`);

  /* ————————————————————————— 2. 前置没做完 → 不开闸、只能看 */
  step("2. 只有口算完成（听写没做）→ 不开闸，错题只能看不能改");
  // 只把「口算」标完成，听写留白
  await jpatch("/api/state/daily", { tasks: { math: true, dictation: false } });
  await page.goto(`${BASE}/wrong`, { waitUntil: "networkidle" });
  await page.waitForSelector(".seg-btn", { timeout: 15000 });
  await page.waitForTimeout(900);

  const dClosed = await dailyOf();
  ok("服务端 reviewTarget 仍是 null（没开闸）", dClosed.reviewTarget === null, String(dClosed.reviewTarget));
  // 2026-09-19 起「为什么现在不能改」不再是一整条黄色横条（用户规则②：备注收进信息图标），
  // 改由工具栏上的状态胶囊直说 —— 拦人的话必须在明面上，长解释才收进 ⓘ。
  ok(
    "工具栏状态胶囊写明「等口算和听写做完」",
    /等口算和听写做完/.test(squash(await reviewPill().innerText())),
    squash(await reviewPill().innerText()),
  );
  ok("输入框是禁用的", await page.locator(".wb-item input.m-in").first().isDisabled());
  // 首页那座岛只写岛名 + 一颗状态胶囊（第二行小字已按产品要求删掉）。
  // 错题修理站是「随时能去的工具站」，所以闸没开时这里也不上锁：
  // 胶囊写「去看看」，而不是「待解锁」—— 孩子照样能进去看错题，只是还不能改。
  const isleClosed = await reviewIsle();
  const closedCls = (await isleClosed.getAttribute("class")) || "";
  ok("闸没好时错题修理站也不上锁（随时能进去看）", !closedCls.includes("locked"), closedCls);
  const closedGo = squash(await isleClosed.locator(".isle-go").first().innerText());
  ok("胶囊写「去看看」而不是「待解锁」", closedGo.includes("去看看"), closedGo);
  ok("岛上只有岛名（没有「先做口算和听写」这类第二行小字）", squash(await isleClosed.innerText()).startsWith("错题修理站"), squash(await isleClosed.innerText()));
  await page.goto(`${BASE}/wrong`, { waitUntil: "networkidle" });
  await page.waitForSelector(".wb-item", { timeout: 15000 });
  await page.screenshot({ path: path.join(shotDir, "review-locked.png"), fullPage: true });

  /* ————————————————————————— 3. 补上听写 → 开闸，目标 = 1（不是 3） */
  step("3. 补完听写 → 开闸，目标 = 1（核心：不再写死 3 道）");
  await jpatch("/api/state/daily", { tasks: { math: true, dictation: true } });
  await reloadWrong();

  const dOpen = await dailyOf();
  ok("开闸后 reviewTarget = 1", dOpen.reviewTarget === 1, String(dOpen.reviewTarget));
  ok("「等口算和听写做完」的状态胶囊消失", !/等口算和听写做完/.test(squash(await reviewPill().innerText())));
  ok("输入框恢复可用", !(await page.locator(".wb-item input.m-in").first().isDisabled()));
  const pill = squash(await reviewPill().innerText());
  ok("顶部进度显示 0 / 1（不是 0 / 3）", /0/.test(pill) && /1/.test(pill) && !/3/.test(pill), pill);
  console.log("  截图：web/test/shots/review-open.png");
  await page.screenshot({ path: path.join(shotDir, "review-open.png"), fullPage: true });

  /* ————————————————————————— 4. 改对那 1 道 → 任务完成 */
  step("4. 把那 1 道改对 → 错题本清空，「错题复习」任务完成");
  const inp = page.locator(`.wb-item input.m-in[data-wc="${seeded[0].id}"]`);
  await inp.fill(oneAns);
  const gone = await waitFor(async () => (await wrongMath()).length === 0, 10000);
  ok("填对后错题本清空", gone === true, `剩 ${(await wrongMath()).length} 道`);

  // 计数与打勾都是「发出去就不管」的异步写，得等它落地再断言（不然是在测竞态）
  const counted = await waitFor(async () => (await dailyOf()).reviewCount === 1, 6000);
  ok("重新挑战计数 = 1", counted === true, String((await dailyOf()).reviewCount));
  const dDone = await dailyOf();
  ok("「错题复习」任务已打勾", dDone.tasks?.review === true, JSON.stringify(dDone.tasks));
  // 首页那座岛的状态胶囊换成「已通关」（岛上不再有「已完成 1 / 1 道」那种进度小字，
  // 进度改在错题本页顶部那颗 pill 上看 —— 上面第 4 步已经断言过页面上的计数）
  const isleDone = await reviewIsle();
  const doneCls = (await isleDone.getAttribute("class")) || "";
  ok("首页错题修理站变成已通关状态", doneCls.includes("done"), doneCls);
  const doneFlag = squash(await isleDone.locator(".isle-flag").first().innerText());
  ok("状态胶囊写「已通关」", /已通关/.test(doneFlag), doneFlag);

  /* ————————————————————————— 5. 错 5 道 → 封顶 3，做完 3 道才完成 */
  step("5. 错 5 道 → 目标封顶 3；且中途错题本变长，分母不跟着变");
  await jpatch("/api/state/daily", {
    tasks: { math: true, dictation: true, review: false },
    reviewCount: 0,
    reviewTarget: null,
  });
  for (const t of ["11 × 2 =", "12 × 2 =", "13 × 2 ="]) {
    await jreq("POST", "/api/state/wrong", { type: "math", refKey: t, payload: { text: t, ans: 1 } });
  }
  await reloadWrong();
  const d5 = await dailyOf();
  ok("5 道错题 → 目标封顶 3", d5.reviewTarget === 3, String(d5.reviewTarget));

  // 开闸之后错题本又长了 2 道 → 分母必须冻住
  for (const t of ["14 × 2 =", "15 × 2 ="]) {
    await jreq("POST", "/api/state/wrong", { type: "math", refKey: t, payload: { text: t, ans: 1 } });
  }
  await reloadWrong();
  const d5b = await dailyOf();
  ok("错题本涨到 5 道后分母仍是 3（冻结，不漂）", d5b.reviewTarget === 3, String(d5b.reviewTarget));

  // 做掉 3 道（错题本里还有 2 道）→ 任务应完成
  const list = await wrongMath();
  for (let i = 0; i < 3; i++) {
    const it = list[i];
    const el = page.locator(`.wb-item input.m-in[data-wc="${it.id}"]`);
    if (!(await el.count())) continue;
    await el.fill(String(it.payload?.ans ?? ""));
    await page.waitForTimeout(900);
  }
  const done5 = await waitFor(async () => (await dailyOf()).tasks?.review === true, 8000);
  ok("做满 3 道后任务完成", done5 === true, JSON.stringify(await dailyOf()));
  ok("错题本还剩 2 道（目标封顶后不用全清）", (await wrongMath()).length === 2, `${(await wrongMath()).length} 道`);

  /* ————————————————————————— 6. 错题本被清空 → 目标 0 → 不用动手就算完成 */
  step("6. 错题本被清空（家长后台清理）→ 目标 0，任务自动完成，不会卡住");
  await jpatch("/api/state/daily", {
    tasks: { math: true, dictation: true, review: false },
    reviewCount: 0,
    reviewTarget: null,
  });
  await jreq("POST", "/api/state/wrong/clear", { all: true });
  await reloadWrong();
  await page.waitForTimeout(600);
  const d6 = await dailyOf();
  ok("错题本空 → 目标 0", d6.reviewTarget === 0, String(d6.reviewTarget));
  const autoDone = await waitFor(async () => (await dailyOf()).tasks?.review === true, 8000);
  ok("任务自动打勾（没有要复习的）", autoDone === true, JSON.stringify(await dailyOf()));
  // 「错题本是空的」这句提示现在只活在错题本页里（首页那座岛只有岛名一行）
  await reloadWrong();
  const emptyText = squash(await page.locator(".wb-empty").first().innerText());
  ok("错题本页说明「数学错题本是空的」", emptyText.includes("错题本是空的"), emptyText);
  const isleEmpty = await reviewIsle();
  ok(
    "错题本空 → 那座岛也算通关",
    ((await isleEmpty.getAttribute("class")) || "").includes("done"),
    (await isleEmpty.getAttribute("class")) || "",
  );

  /* ————————————————————————— 7. 控制台 */
  step("7. 控制台");
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
  for (const d of ["_reviewgate_tts", "_reviewgate_backup"]) {
    try {
      fs.rmSync(path.join(SERVER, "data", d), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`错题复习开闸回归：通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  console.log("=".repeat(60));
  process.exit(failures.length ? 1 : 0);
}
