/**
 * 「语言强化」端到端回归测试（九宫格副目录 + 9 题型交互）
 *
 * 覆盖点：
 *   1. 首次进入是空状态，点「生成今日训练」后出题
 *   2. 九宫格正好 9 格，题型名与顺序与约定一致
 *   3. 词语搭配（选择题）：点对选项 → 立即判对，卡片变「已完成」
 *   4. 句子排序（排序题）：按正确顺序点句子 → 自动判对
 *   5. 每日词语（口述题）：出现「大人判定」按钮，点「通过」后记完成
 *   6. 进度汇总（完成 3/9）在刷新后依然存在（说明真的存在服务端）
 *   7. 看图观察真的展示了 AI 画出来的图片（<img> 且 naturalWidth > 0），
 *      看图说话复用同一张图；画面文字描述默认折叠（不然等于直接给答案）
 *   8. 9 道题全做完 → 语言强化作为首页的一项待办自动打勾 + 加 20 分
 *      （顶栏任务分母同时是 6 项；少做一道都不加分，这条在 api.test 里断言）
 *   9. 全程零 console error
 *
 * 为什么要用隔离实例（端口 8796 + 独立 DB + mock 大模型）：
 *   这个测试会真的出题（写 app_kv）并写作答进度，跑在孩子的真实库上会污染数据；
 *   同时把大模型指向本地 mock，避免花 token 也避免真实模型返回格式漂移导致误报。
 *
 * 用法：node web/test/language.mjs      或   cd web && npm run test:language
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

// 仓库根用「脚本自身位置」推，而不是 cwd —— `npm run` 时 cwd 是 web/
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(REPO, "server");
const PORT = 8796;
const MOCK_PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.langtest.yaml");
const TEST_DB = path.join(SERVER, "data", "_langtest.db");
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

/** 截图目录（与 smoke.mjs 共用 web/test/shots） */
const SHOTS = path.join(REPO, "web", "test", "shots");

/* ------------------------------------------------------- 隔离实例的配置 */
// story 用途指向本地 mock（storyBaseUrl 显式配置会覆盖「固定地址」）
const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_langtest.db }
llm:
  baseUrl: https://api.deepseek.com
  apiKey: test-key-not-used
  storyModel: mock-story
  storyBaseUrl: http://127.0.0.1:${MOCK_PORT}/v1
  storyApiKey: test-key-for-mock
  markModel: mock-mark
  suggestModel: mock-story
  timeoutMs: { story: 60000, mark: 90000, suggest: 45000 }
  retries: 0
  temperature: { story: 0.9, mark: 0, suggest: 0.5 }
tts:
  provider: edge
  voice: zh-CN-XiaoyiNeural
  rate: "-12%"
  cacheDir: ./data/_langtest_tts
imagegen:
  enabled: true
  model: mock-image
  baseUrl: http://127.0.0.1:${MOCK_PORT}/__image
  apiKey: test-key-for-image
  size: 1328*1328
  dir: ./data/_langtest_images
  timeoutMs: 20000
backup:
  enabled: false
  dir: ./data/_langtest_backup
`;

function startMock() {
  return spawn(NODE, ["node_modules/tsx/dist/cli.mjs", "test/mock-llm.ts"], {
    cwd: SERVER,
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

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

let mock;
let server;
let browser;
let page;

fs.mkdirSync(SHOTS, { recursive: true });
const shot = (name) => page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {});

/** mock 返回的排序题（与 server/test/mock-llm.ts 保持一致） */
const ORDER_DISPLAY = ["然后我们把风筝放上了天。", "星期天，我和爸爸去公园放风筝。", "最后我们开开心心地回家了。"];
const ORDER_CORRECT = [ORDER_DISPLAY[1], ORDER_DISPLAY[0], ORDER_DISPLAY[2]];

const TYPES = [
  "每日词语",
  "词语搭配",
  "扩句训练",
  "病句修改",
  "把话写具体",
  "句子排序",
  "看图观察",
  "看图说话",
  "简短写作",
];

try {
  console.log(`\n=== 准备隔离实例（端口 ${PORT} + mock 大模型 ${MOCK_PORT} + 独立 DB）===`);
  fs.writeFileSync(TEST_CONFIG, TEST_CONFIG_YAML, "utf8");
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  mock = startMock();
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

  /* ————————————————————————————— 0. 空状态 */
  step("0. 首次进入语言强化页");
  await page.goto(`${BASE}/language`, { waitUntil: "networkidle" });
  await page.waitForSelector(".lg-empty", { timeout: 20000 });
  ok("显示空状态引导", (await page.locator(".lg-empty").count()) === 1);
  ok("提供「生成今日训练」按钮", (await page.locator("button", { hasText: "生成今日训练" }).count()) === 1);

  /* ————————————————————————————— 1. 出题 */
  step("1. 点「生成今日训练」→ 出 9 道题");
  await page.locator("button", { hasText: "生成今日训练" }).first().click();
  await page.waitForSelector(".lg-grid", { timeout: 40000 });
  const cells = await page.locator(".lg-cell").count();
  ok("九宫格正好 9 格", cells === 9, `${cells} 格`);

  const names = await page.locator(".lg-cell .lg-name").allInnerTexts();
  ok("9 种题型名与顺序正确", names.join(",") === TYPES.join(","), names.join(","));

  const themeText = await page.locator(".lg-theme-t").first().innerText();
  ok("显示了今日主题", /今日主题：\S/.test(themeText), themeText);
  await shot("lg-01-grid.png");

  /* ————————————————————————————— 2. 选择题：自动判卷 */
  step("2. 词语搭配（选择题）→ 点对选项立即判对");
  await page.locator(".lg-cell", { hasText: "词语搭配" }).first().click();
  await page.waitForSelector(".lg-opt", { timeout: 10000 });
  ok("渲染出选择题选项", (await page.locator(".lg-opt").count()) >= 3);
  await page.locator(".lg-opt", { hasText: "温暖的阳光" }).first().click();
  await page.waitForSelector(".lg-fb.ok", { timeout: 10000 });
  ok("选中正确搭配后判定为对", (await page.locator(".lg-fb.ok").count()) === 1);
  await shot("lg-02-choice.png");

  await page.locator("button", { hasText: "九宫格" }).first().click();
  await page.waitForSelector(".lg-grid", { timeout: 10000 });
  const cell2Class = await page.locator(".lg-cell", { hasText: "词语搭配" }).first().getAttribute("class");
  ok("返回九宫格后该题标记为已完成", (cell2Class ?? "").includes("done"), String(cell2Class));

  /* ————————————————————————————— 3. 排序题：自动判卷 */
  step("3. 句子排序 → 按正确顺序点句子，自动判对");
  await page.locator(".lg-cell", { hasText: "句子排序" }).first().click();
  await page.waitForSelector(".lg-order-chip", { timeout: 10000 });
  const chips = await page.locator(".lg-order-chip").count();
  ok("未选句子时全部在候选区", chips === 3, `${chips} 句`);
  for (const s of ORDER_CORRECT) {
    await page.locator(".lg-order-chip", { hasText: s }).first().click();
    await page.waitForTimeout(220);
  }
  await page.waitForSelector(".lg-fb.ok", { timeout: 10000 });
  ok("排对顺序后自动判对", (await page.locator(".lg-fb.ok").count()) === 1);
  ok("答案区按顺序列出了 3 句", (await page.locator(".lg-slot").count()) === 3);
  await shot("lg-03-order.png");

  await page.locator("button", { hasText: "九宫格" }).first().click();
  await page.waitForSelector(".lg-grid", { timeout: 10000 });

  /* ————————————————————————————— 4. 口述题：大人判定 */
  step("4. 每日词语（口述题）→ 大人判定");
  await page.locator(".lg-cell", { hasText: "每日词语" }).first().click();
  await page.waitForSelector(".lg-word-big", { timeout: 10000 });
  ok("渲染出词语大字", (await page.locator(".lg-word-big").first().innerText()).trim().length > 0);
  ok("口述题出现「大人判定」按钮", (await page.locator("button", { hasText: "说得好，通过" }).count()) === 1);
  await page.locator("button", { hasText: "说得好，通过" }).first().click();
  await page.waitForTimeout(900);
  await page.locator("button", { hasText: "九宫格" }).first().click();
  await page.waitForSelector(".lg-grid", { timeout: 10000 });
  const firstCellClass = await page.locator(".lg-cell", { hasText: "每日词语" }).first().getAttribute("class");
  ok("判定通过后该题标记为已完成", (firstCellClass ?? "").includes("done"), String(firstCellClass));

  /* ————————————————————————————— 5. 看图观察：AI 画出来的真图 */
  step("5. 看图观察 → 展示真实图片");
  await page.locator(".lg-cell", { hasText: "看图观察" }).first().click();
  await page.waitForSelector(".lg-imgwrap", { timeout: 10000 });
  // 配图是「打开这一题」时才触发生成的，所以要等它画好
  await page.waitForSelector(".lg-img", { timeout: 40000 });
  const dim = await page.locator(".lg-img").first().evaluate((el) => ({
    w: el.naturalWidth,
    h: el.naturalHeight,
    src: el.getAttribute("src"),
  }));
  ok("展示出真实图片（不是文字描述）", (await page.locator(".lg-img").count()) === 1);
  ok("图片确实加载成功（naturalWidth > 0）", dim.w > 0, JSON.stringify(dim));
  ok("图片来自后端配图接口", String(dim.src).includes("/api/language/image/"), String(dim.src));
  ok("观察问题已渲染", (await page.locator(".lg-qs li").count()) >= 3);
  ok("画面文字描述默认折叠（不直接把答案给孩子）", (await page.locator(".lg-pic-fold:not([open])").count()) === 1);
  await shot("lg-04-observe.png");

  /* ————————————————————————————— 5b. 看图说话复用同一张图 */
  step("5b. 看图说话 → 复用同一张图");
  await page.locator("button", { hasText: "下一题" }).first().click();
  await page.waitForSelector(".lg-img", { timeout: 15000 });
  const src2 = await page.locator(".lg-img").first().getAttribute("src");
  ok("看图说话复用同一张图（不重复花钱重画）", src2 === dim.src, String(src2));
  ok("带「还是这幅图」图注", (await page.locator(".lg-imgcap").count()) === 1);
  await shot("lg-05-speaking.png");

  /* ————————————————————————————— 6. 进度汇总 + 刷新后仍在 */
  step("6. 进度汇总与持久化");
  await page.locator("button", { hasText: "九宫格" }).first().click();
  await page.waitForSelector(".lg-grid", { timeout: 10000 });
  const badge = await page.locator(".lg-theme .badge-lite", { hasText: "完成" }).first().innerText();
  ok("完成计数为 3/9", badge.replace(/\s/g, "") === "完成3/9", badge);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".lg-grid", { timeout: 20000 });
  const badge2 = await page.locator(".lg-theme .badge-lite", { hasText: "完成" }).first().innerText();
  ok("刷新后进度仍在（确实存在服务端）", badge2.replace(/\s/g, "") === "完成3/9", badge2);
  const doneCells = await page.locator(".lg-cell.done").count();
  ok("刷新后 3 个格子仍是已完成", doneCells === 3, `${doneCells} 格`);

  /* ————————————————————————————— 6b. 9 道全做完 → 首页那项待办打勾 + 加 20 分 */
  step("6b. 做完剩下 6 道 → 语言强化打卡 + 20 分");
  // 剩下的 6 道都是口述题（大人判定），一题一题点「说得好，通过」
  const REMAINING = ["扩句训练", "病句修改", "把话写具体", "看图观察", "看图说话", "简短写作"];
  for (const name of REMAINING) {
    await page.locator(".lg-cell", { hasText: name }).first().click();
    await page.waitForSelector("button:has-text('说得好，通过')", { timeout: 15000 });
    await page.locator("button", { hasText: "说得好，通过" }).first().click();
    await page.waitForTimeout(800);
    await page.locator("button", { hasText: "九宫格" }).first().click();
    await page.waitForSelector(".lg-grid", { timeout: 10000 });
  }
  const badge3 = await page.locator(".lg-theme .badge-lite", { hasText: "完成" }).first().innerText();
  ok("九宫格计数变成 9/9", badge3.replace(/\s/g, "") === "完成9/9", badge3);
  await shot("lg-06-all-done.png");

  // 积分：9 道全做完才给 20 分（少一道都不给，这里是刚好做完的那一刻）
  const pts = await (await fetch(`${BASE}/api/points`)).json();
  ok("9 道全做完 → 加 20 分", pts.balance === 20, `balance=${pts.balance}`);

  // 首页：语言练习现在是地图上的一座岛，做完要自动变成「已通关」
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const langCard = (await page.locator("button.isle", { hasText: "语言练习" }).first().innerText()).replace(/\s+/g, " ");
  ok("首页地图上有「语言练习」这一座", langCard.includes("语言练习"), langCard);
  // 判据是「岛带 done 类 + 状态胶囊写已通关」。别再找「已完成」——
  // 岛上那一行小字已按产品要求删掉，只剩岛名 + 一颗状态胶囊（见 HomeView 的 isle-flag）。
  const langDone = page.locator("button.isle.done", { hasText: "语言练习" });
  const langFlag = (await langDone.count())
    ? (await langDone.locator(".isle-flag").first().innerText()).replace(/\s+/g, " ")
    : "(没找到处于已通关状态的语言练习岛)";
  ok("做完 9 道后这座岛变成「已通关」", /已通关/.test(langFlag), langFlag);
  const cardCount = await page.locator("button.isle").count();
  ok("首页小岛地图共 6 座", cardCount === 6, `${cardCount} 座`);
  const headPill = (await page.locator(".stat-pill").first().innerText()).replace(/\s+/g, " ");
  ok("顶栏任务分母也变成 6", /\/ 6 项任务/.test(headPill), headPill);
  await shot("lg-07-home.png");

  /* ————————————————————————————— 7. 控制台 */
  step("7. 控制台");
  ok("零 console error / 零未捕获异常", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
} catch (e) {
  ok("执行过程无异常", false, e instanceof Error ? e.message : String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const p of [server, mock]) {
    if (p) p.kill();
  }
  await sleep(800);
  for (const f of [TEST_CONFIG, TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  for (const d of ["_langtest_tts", "_langtest_backup", "_langtest_images"]) {
    try {
      fs.rmSync(path.join(SERVER, "data", d), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`语言强化回归：通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  console.log("=".repeat(60));
  process.exit(failures.length ? 1 : 0);
}
