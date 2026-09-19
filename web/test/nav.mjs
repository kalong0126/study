/**
 * 应用内导航回归测试（真实浏览器）
 *
 * 为什么单独有这么一个文件：
 *   smoke.mjs 全程用 page.goto 整页加载，而整页加载时 RouterView 是首次渲染、
 *   不经过 <Transition>，所以「点按钮切页白屏」这类 bug 会被完全掩盖。
 *   这个文件全程只用「应用内点击」切页，专门守住这条链路。
 *
 * 历史回归（已修复）：
 *   App.vue 里 <Transition mode="out-in"> 直接挂了 <component>，而 HomeView 等
 *   视图是多根节点（Fragment）。Transition 只认单根节点，离开钩子的 done 永不
 *   回调 → isLeaving 卡在 true → 新视图不挂载，URL 变了但页面全白，必须手刷。
 *   修复：RouterView 外包一层带 key 的单根 div。
 *
 * 默认起隔离实例（端口 8804 + 独立 DB）：首页那张小岛地图是「闯过一关才解锁下一关」的，
 * 要跑遍所有页面就得先把今日六项置为完成 —— 这种事绝不能做在孩子的真实库上。
 * 传了 baseUrl 就用外部服务（此时解锁那一步会改那份库，自己掂量）。
 *
 * 用法：node web/test/nav.mjs [baseUrl]
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ISLE_OF_PATH } from "./_kidnav.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

// 截图目录按「脚本自身位置」推仓库根，不能用 cwd —— `npm run nav` 时 cwd 是 web/，
// 用 cwd 会把截图错写到 web/web/test/shots。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(REPO, "web", "test", "shots");
mkdirSync(OUT, { recursive: true });

/* --------------------------------------------------- 隔离实例（默认走这条） */

const SERVER = path.join(REPO, "server");
const PORT = 8804;
const EXTERNAL = process.argv[2];
const BASE = EXTERNAL ?? `http://127.0.0.1:${PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.islenav.yaml");
const TEST_DB = path.join(SERVER, "data", "_islenav.db");
const NODE = "C:/Users/kalon/.workbuddy/binaries/node/versions/22.22.2-3/node.exe";

const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_islenav.db }
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
  cacheDir: ./data/_islenav_tts
backup:
  enabled: false
  dir: ./data/_islenav_backup
`;

let isolatedServer = null;

async function startIsolated() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  writeFileSync(TEST_CONFIG, TEST_CONFIG_YAML, "utf8");
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (existsSync(f)) unlinkSync(f);
  }
  isolatedServer = spawn(NODE, ["node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
    cwd: SERVER,
    env: { ...process.env, CONFIG_PATH: TEST_CONFIG, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(600);
  }
  return false;
}

function stopIsolated() {
  try {
    isolatedServer?.kill();
  } catch {
    /* 忽略 */
  }
  for (const f of [TEST_CONFIG, TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* 忽略 */
    }
  }
}

const problems = [];
let stepNo = 0;

const step = (n) => console.log(`\n[${String(++stepNo).padStart(2, "0")}] ${n}`);
const pass = (m) => console.log(`  ✓ ${m}`);
const note = (m) => console.log(`  · ${m}`);
function fail(m) {
  problems.push(m);
  console.log(`  ✗ ${m}`);
}

/** 每条路由的「内容确实渲染了」判据 */
const ROUTES = [
  { path: "/", name: "今日", nav: "今日", sel: ".isle", min: 1, what: "小岛节点" },
  { path: "/math", name: "口算", nav: "口算", sel: ".m-row", eq: 20, what: "口算题行" },
  { path: "/chinese", name: "语文", nav: "语文", sel: ".story-text", min: 1, what: "课文原文" },
  { path: "/story", name: "童话", nav: "童话", sel: ".card", min: 1, what: "卡片" },
  { path: "/language", name: "语言", nav: "语言", sel: ".card", min: 1, what: "卡片" },
  { path: "/video", name: "英文", nav: "英文", sel: ".card", min: 1, what: "卡片" },
  { path: "/wrong", name: "错题本", nav: "错题本", sel: ".seg", min: 1, what: "分区切换" },
];

// 起隔离实例（传了 baseUrl 就直接用外部服务）
if (!EXTERNAL) {
  step("准备隔离实例（端口 8804，独立 DB，不碰孩子的数据）");
  const healthy = await startIsolated();
  healthy ? pass("隔离实例已就绪") : fail("隔离实例没起来，看 server/logs/app-*.log");
  if (!healthy) {
    stopIsolated();
    process.exit(1);
  }
  process.on("exit", () => {
    if (!EXTERNAL) stopIsolated();
  });
}

const browser = await chromium.launch({
  executablePath: "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });

const consoleMsgs = [];
page.on("console", (m) => {
  if (m.type() === "warning" || m.type() === "error") consoleMsgs.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${e.message}`));

/** 视图是否真的挂上了：main.wrap 里必须有元素子节点，而不是只剩占位注释 */
async function viewState() {
  return page.evaluate(() => {
    const wrap = document.querySelector("main.wrap");
    return {
      hasWrap: !!wrap,
      childCount: wrap ? wrap.children.length : -1,
      fatal: document.querySelectorAll(".fatal-box").length,
      bodyText: (document.body.innerText || "").replace(/\s+/g, " "),
      path: location.pathname,
    };
  });
}

/** 一次完整断言：URL + 内容无白屏 + 指定元素到位 */
async function assertRoute(r, label) {
  const st = await viewState();
  const urlOk = st.path === r.path;
  urlOk ? pass(`${label}：URL = ${st.path}`) : fail(`${label}：URL = ${st.path}（期望 ${r.path}）`);

  if (st.childCount >= 1 && !st.fatal) pass(`${label}：视图已挂载（main.wrap 子节点 ${st.childCount} 个）`);
  else if (st.fatal) fail(`${label}：落到了 fatal-box 错误态`);
  else fail(`${label}：白屏！main.wrap 没有元素子节点（childCount=${st.childCount}）`);

  const n = await page.locator(`${r.sel}`).count();
  if (r.eq !== undefined) {
    n === r.eq ? pass(`${label}：${r.what} ${n} 个`) : fail(`${label}：${r.what} ${n} 个（期望 ${r.eq}）`);
  } else {
    n >= (r.min ?? 1) ? pass(`${label}：${r.what} ${n} 个`) : fail(`${label}：${r.what} 只有 ${n} 个`);
  }
}

// ————————————————————————————— 0a. 童话接口打桩
// 孩子端现在**一进 /story 就自动生成今日童话**（ensureToday）。这份隔离实例的 llm.apiKey
// 是假的，真打过去必失败 → 后端回 502 → 控制台多一条 error，把「控制台零错误」这条断言带崩。
// 这里只测导航，不该花 token 也不该依赖外网，所以直接给 `/story/today` 一篇固定小童话。
const STUB_STORY = {
  id: 9001,
  title: "《导航回归用小童话》",
  text: [
    "小水珠住在一朵软软的白云里。",
    "有一天，它听见大地在喊渴。",
    "它就和小伙伴们一起跳了下去。",
    "它落进一条小溪，溪水叮叮咚咚地唱歌。",
    "后来，它又回到了天上，变成一朵白云。",
  ].join("\n"),
};
await page.route("**/api/story/today", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ story: STUB_STORY }),
  }),
);
await page.route("**/api/story/generate", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ...STUB_STORY, charCount: 100, avoidCount: 0, ms: 0, model: "stub", cached: false }),
  }),
);

// ————————————————————————————— 0. 前置：把今日六项任务置为已完成（全部解锁）
// 首页那张小岛地图是「闯过一关才解锁下一关」的，未解锁的路由会被守卫弹回首页。
// 这份测试的职责是「跑遍所有页面、都不白屏」，不是验证解锁本身（那由 isle-map.mjs 负责），
// 所以先让每一关都开着。错题修理站本就不参与顺序锁，置不置它都进得去。
//
// 注意：这个状态会被后续访问**打回去** —— 进 /video 页会上报一次播放进度，
// 没看完一集后端就把「英文故事」改回未完成（这是对的：换了一集没看完，任务本来就没做完）。
// 所以下面每一轮点小岛之前都要重新置一遍 + 整页重载，否则会莫名卡在「英文小屋」上。
step("前置：今日六项任务置为已完成（全部解锁，便于跑遍所有页面）");
{
  const r = await fetch(`${BASE}/api/state/daily`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tasks: { math: true, dictation: true, review: true, reading: true, language: true, video: true },
    }),
  });
  r.ok ? pass("六项任务已置为完成") : fail(`置为完成失败：HTTP ${r.status}`);
}

// ————————————————————————————— 1. 首页整页加载（基线）
step("整页加载首页（基线）");
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const base = await viewState();
base.childCount >= 1 && !base.fatal
  ? pass(`首页整页加载正常（main.wrap 子节点 ${base.childCount} 个）`)
  : fail("首页整页加载就是空白，先查后端 /api/health 与 bootstrap");
if (/占位|Transition|RouterView/.test(base.bodyText)) {
  fail("页面正文里出现了模板注释文本（HTML 注释被提前闭合漏进 DOM）");
}

// ————————————————————————————— 2. 首页小岛：跑遍全部路由（应用内点击）
// 底部导航已按用户要求整体去掉 → 孩子端唯一的入口是首页那张小岛地图，
// 回首页靠顶栏「回小岛」。两段都是应用内点击，Transition 那条链路照样测得到。
step("首页小岛逐座切换 + 回小岛（应用内点击，不刷新）");
await page.locator("button.isle").first().waitFor({ timeout: 20000 });
for (const r of ROUTES) {
  const label = r.path === "/" ? "首页" : `小岛「${ISLE_OF_PATH[r.path]}」`;
  if (r.path !== "/") {
    await page.locator("button.isle", { hasText: ISLE_OF_PATH[r.path] }).first().click();
    await page.waitForTimeout(1400);
  }
  await assertRoute(r, `点${label}`);
  if (r.path === "/") continue;

  // 回首页：这一段同时守住「离开多根视图不再卡死」（原来那条 §3 的断言）
  const back = page.locator(".hd-back").first();
  if (!(await back.count())) {
    fail(`${r.path} 页找不到顶栏「回小岛」按钮（底栏去掉后就没路回首页了）`);
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    continue;
  }
  await back.click();
  await page.waitForTimeout(1200);
  const st = await viewState();
  st.path === "/" && st.childCount >= 1
    ? pass(`${label} → 回小岛：正常切回`)
    : fail(`${label} → 回小岛：白屏（childCount=${st.childCount}，path=${st.path}）`);
}

// ————————————————————————————— 4. 首页小岛地图（孩子端唯一的入口）
step("首页小岛地图 → 各功能页（应用内点击）");
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("button.isle", { timeout: 20000 });
await page.waitForTimeout(900);
{
  // 地图上共 6 座岛，按闯关顺序排：口算岛 / 听写屋 / 错题修理站 / 故事树 / 语言练习 / 英文小屋。
  // 顺序即解锁顺序（错题修理站除外，它是随时能去的工具站），英文小屋刻意排在最后。
  const cards = await page.locator("button.isle").allInnerTexts();
  const names = ["口算岛", "听写屋", "错题修理站", "故事树", "语言练习", "英文小屋"];
  const missing = names.filter((n) => !cards.some((c) => c.includes(n)));
  cards.length === 6 && missing.length === 0
    ? pass(`首页小岛地图 6 座：${names.join(" / ")}`)
    : fail(`首页小岛 ${cards.length} 座，缺 ${JSON.stringify(missing)}`);
  const header = (await page.locator(".stat-pill").first().innerText()).replace(/\s+/g, " ");
  /\/ 6 项任务/.test(header)
    ? pass("顶栏分母跟着变成 6 项")
    : fail(`顶栏任务分母不对：${header}`);
}
const shortcuts = [
  { isle: "口算岛", path: "/math", sel: ".m-row", min: 20 },
  { isle: "听写屋", path: "/chinese", sel: ".story-text", min: 1 },
  { isle: "错题修理站", path: "/wrong", sel: ".seg", min: 1 },
  { isle: "故事树", path: "/story", sel: ".card", min: 1 },
  { isle: "语言练习", path: "/language", sel: ".lg-empty, .lg-grid", min: 1 },
  { isle: "英文小屋", path: "/video", sel: ".card", min: 1 },
];
/** 把今日六项置为完成（见上面前置那段的说明） */
async function unlockAll() {
  const r = await fetch(`${BASE}/api/state/daily`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tasks: { math: true, dictation: true, review: true, reading: true, language: true, video: true },
    }),
  });
  return r.ok;
}

for (const s of shortcuts) {
  // 每一轮都从头来一遍：上一轮进的页面可能把某一项打回未完成（/video、/language 都会），
  // 那后面几座岛就被锁上了。整页重载是为了让 store 重新拉一次服务端状态。
  await unlockAll();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("button.isle", { timeout: 20000 });
  await page.waitForTimeout(700);
  const card = page.locator("button.isle", { hasText: s.isle }).first();
  if (!(await card.count())) {
    fail(`回首页后找不到小岛「${s.isle}」`);
    continue;
  }
  const cls = await card.getAttribute("class");
  await card.click();
  await page.waitForTimeout(1500);
  const st = await viewState();
  st.path === s.path && st.childCount >= 1
    ? pass(`小岛「${s.isle}」→ ${s.path}`)
    : fail(`小岛「${s.isle}」→ ${st.path}（期望 ${s.path}，childCount=${st.childCount}，岛状态=${cls}）`);
  const n = await page.locator(s.sel).count();
  n >= s.min ? pass(`  ${s.sel} = ${n}`) : fail(`  ${s.sel} = ${n}（太少，期望 ≥${s.min}）`);
}

// ————————————————————————————— 4c. 语文两页式：课文原文 + 生字红标 → 生字听写
step("语文 /chinese 两页式（课文朗读页 + 生字红标 → 生字听写页）");
await page.goto(`${BASE}/chinese`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const redCount = await page.locator(".lesson-new").count();
redCount > 0 ? pass(`课文页生字红标 ${redCount} 处`) : fail("课文页没有生字红标（.lesson-new）");
await page.locator(".seg-btn", { hasText: "生字听写" }).first().click();
await page.waitForTimeout(800);
const ziN = await page.locator(".zi-strip").count();
ziN >= 1 ? pass(`切到听写页后生字条 ${ziN} 条`) : fail("切到听写页后生字条缺失（.zi-strip）");
const ziCells = await page.locator(".zi-strip .zi").count();
ziCells >= 1 ? pass(`生字条里排出 ${ziCells} 个生字`) : fail("生字条里没有生字（.zi-strip .zi）");

// ————————————————————————————— 4d. 顶栏积分入口 → 兑换历史页（分页 + 统计）
step("顶栏积分入口 → 兑换历史页");
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1100);
const pillCnt = await page.locator(".pts-pill").count();
pillCnt === 1 ? pass("顶栏右上积分入口存在（.pts-pill）") : fail(`顶栏积分入口数量 ${pillCnt}（期望 1）`);
if (pillCnt === 1) {
  await page.locator(".pts-pill").first().click();
  await page.waitForTimeout(1100);
  const stP = await viewState();
  stP.path === "/points" && stP.childCount >= 1
    ? pass("点积分入口 → /points 已挂载")
    : fail(`点积分入口 → ${stP.path}（期望 /points，childCount=${stP.childCount}）`);
  const statCnt = await page.locator(".pts-stat").count();
  statCnt === 2 ? pass("兑换统计两块卡片（平板时长 / 现金）") : fail(`兑换统计卡片 ${statCnt} 个（期望 2）`);
  const histExists = (await page.locator(".pts-hist, .wb-empty").count()) >= 1;
  histExists ? pass("兑换历史 / 空态都正常渲染") : fail("兑换历史区未渲染");
}

// ————————————————————————————— 4b. 孩子端不得出现任何家长「可点」入口
step("孩子端不出现家长可点入口（防误点）");
// 背景：首页原来有「快速开始」卡片和「数据安全」卡片（含 导出 JSON 备份 / 导入恢复 /
// 运行诊断 / 进后台的链接）。这两块对孩子的价值是 0，风险是误点 ——
// 尤其「导入恢复」会覆盖数据。现已整体移到 /admin。
// 这条断言只盯「可点元素」（a / button）与指向 /admin 的链接；
// 正文里顺口提一句「家长可以在内容后台录课文」是可以的，不算入口。
const KID_PAGES = ["/", "/math", "/chinese", "/story", "/language", "/video", "/wrong"];
const FORBIDDEN_BTN = ["快速开始", "数据安全", "备份", "导出", "导入恢复", "导入", "运行诊断", "后台", "恢复"];
for (const p of KID_PAGES) {
  await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const hits = await page.evaluate((words) => {
    const out = [];
    for (const el of document.querySelectorAll("main.wrap a, main.wrap button")) {
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (t && words.some((w) => t.includes(w))) out.push(t.slice(0, 24));
    }
    return [...new Set(out)];
  }, FORBIDDEN_BTN);
  hits.length === 0
    ? pass(`${p}：没有家长功能的按钮 / 链接`)
    : fail(`${p}：出现了家长功能的按钮 / 链接 ${JSON.stringify(hits)}`);

  const parentLinks = await page.locator("main.wrap a[href*='/admin']").count();
  parentLinks === 0 ? pass(`${p}：没有指向 /admin 的链接`) : fail(`${p}：有 ${parentLinks} 个指向 /admin 的链接`);
}

// ————————————————————————————— 5. 返回/前进（浏览器历史）
step("浏览器后退 / 前进");
await page.goBack();
await page.waitForTimeout(1200);
let st = await viewState();
st.childCount >= 1 ? pass(`后退 → ${st.path} 已挂载`) : fail(`后退 → ${st.path} 白屏`);
await page.goForward();
await page.waitForTimeout(1200);
st = await viewState();
st.childCount >= 1 ? pass(`前进 → ${st.path} 已挂载`) : fail(`前进 → ${st.path} 白屏`);

// ————————————————————————————— 6. 家长后台（只能靠网址进入，孩子端无入口）
step("家长后台 /admin（结构隔离 + 数据安全已就位）");
await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1600);
{
  const shellCnt = await page.locator(".kid-shell").count();
  shellCnt === 0 ? pass("后台不出现孩子端外壳 / 导航（结构隔离仍生效）") : fail("后台渲染出了孩子端外壳");
  const backLink = await page.locator("a", { hasText: /返回|回到|孩子端/ }).count();
  backLink > 0 ? pass("后台有「回到孩子端」的出口") : fail("后台找不到回到孩子端的出口");
  // 数据安全（原首页那张卡）现在必须在这里找得到
  const sysTab = page.locator(".admin-tabs a", { hasText: "系统与数据" }).first();
  if (await sysTab.count()) {
    await sysTab.click();
    await page.waitForTimeout(1500);
    const body = (await page.locator(".admin-body").innerText().catch(() => "")) || "";
    const need = ["数据安全", "立即备份", "下载全量 JSON", "导入恢复"];
    const missing = need.filter((w) => !body.includes(w));
    missing.length === 0
      ? pass("系统与数据里有数据安全：备份 / 导出 / 导入都在")
      : fail(`系统与数据里缺少 ${JSON.stringify(missing)}`);
    const diag = await page.locator("button", { hasText: "运行诊断" }).count();
    diag > 0 ? pass("后台保留「运行诊断」入口") : fail("后台缺少「运行诊断」入口");
    // 点开验证抽屉真的能弹出来（此前 DiagDrawer 没在 admin 布局挂载，点了没反应）
    if (diag > 0) {
      await page.locator("button", { hasText: "运行诊断" }).click();
      await page.waitForTimeout(700);
      const drawerCnt = await page.locator("aside.drawer[aria-label='运行诊断']").count();
      drawerCnt > 0 ? pass("「打开运行诊断」能弹出抽屉") : fail("点了「打开运行诊断」但抽屉没出现");
      await page.locator("aside.drawer button", { hasText: "关闭" }).click().catch(() => {});
      await page.waitForTimeout(400);
    }
  } else {
    fail("后台找不到「系统与数据」标签页");
  }
}

// ————————————————————————————— 7. 控制台
step("控制台 warning / error");
const uniq = [...new Set(consoleMsgs)];
if (uniq.length === 0) pass("零控制台错误 / 零未捕获异常");
else for (const m of uniq.slice(0, 20)) fail(m);

await page.screenshot({ path: path.join(OUT, "nav-final.png"), fullPage: true });
await browser.close();

console.log("\n" + "═".repeat(60));
console.log(problems.length === 0 ? "导航回归通过：应用内切页全部正常" : `导航回归发现 ${problems.length} 个问题`);
console.log(`截图：${OUT}`);
console.log("═".repeat(60));
process.exit(problems.length === 0 ? 0 : 1);
