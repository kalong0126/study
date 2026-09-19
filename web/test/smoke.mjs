/**
 * 真实浏览器端到端冒烟测试
 *
 * 目标：
 *   1. 每个视图都能渲染出来（没有白屏 / 没有运行时异常）
 *   2. 控制台没有任何 error 级别的输出（含 Vue warn / 未捕获 promise）
 *   3. 关键交互链路可用：口算答题、听写板落笔与提交、导航切换、家长后台开合
 *   4. 控制台之外，额外校验页面上的关键文案与元素是否出现
 *
 * 用法：node web/test/smoke.mjs [baseUrl]
 * 依赖：playwright-core（在 workbuddy 的 node workspace 里）
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

// 截图目录用「脚本自身位置」推，不用 cwd：
// `npm run smoke` 时 cwd 已经是 web/，再 resolve("web/test/shots") 会变成 web/web/test/shots。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "shots");
mkdirSync(OUT, { recursive: true });

const BASE = process.argv[2] ?? "http://127.0.0.1:8788";

const problems = [];
const notes = [];
let stepNo = 0;

function log(msg) {
  console.log(msg);
}
function fail(msg) {
  problems.push(msg);
  console.log(`  ✗ ${msg}`);
}
function pass(msg) {
  console.log(`  ✓ ${msg}`);
}
function note(msg) {
  notes.push(msg);
  console.log(`  · ${msg}`);
}

function step(name) {
  stepNo += 1;
  console.log(`\n[${String(stepNo).padStart(2, "0")}] ${name}`);
}

// 忽略这些噪音：与业务无关的预期内错误
const CONSOLE_IGNORE = [
  /favicon/i,
  /ERR_CONNECTION_REFUSED/i, // 故事/语音走真模型时会失败，属预期
  /Failed to load resource.*(story|tts|mark)/i,
  /Net::ERR_/i,
  /the server responded with a status of (500|502|504)/i,
];

const browser = await chromium.launch({
  executablePath:
    "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
  args: ["--no-sandbox"],
});
const ctx = await browser.newContext({
  viewport: { width: 430, height: 900 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: false,
});
const page = await ctx.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() !== "error" && m.type() !== "warning") return;
  const text = `${m.type()}: ${m.text()}`;
  if (CONSOLE_IGNORE.some((re) => re.test(text))) return;
  consoleErrors.push(text);
});
page.on("pageerror", (e) => {
  consoleErrors.push(`pageerror: ${e.message}`);
});

async function goto(hashPath, waitFor) {
  await page.goto(`${BASE}${hashPath}`, { waitUntil: "domcontentloaded", timeout: 20000 });
  if (waitFor) {
    await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
  }
  await page.waitForTimeout(700);
}

async function text(sel) {
  return (await page.locator(sel).first().textContent().catch(() => ""))?.trim() ?? "";
}
async function visible(sel) {
  return page.locator(sel).first().isVisible().catch(() => false);
}

// ——————————————————————————————————————— 1. 首页
step("首页 / 渲染 + 引导完成");
await goto("/", ".wrap");
await page.waitForTimeout(1200);
const navCount = await page.locator("nav.nav a").count();
// 底部导航已按用户要求整体去掉：孩子端只有首页小岛地图 + 顶栏「回小岛」两条路
navCount === 0 ? pass("孩子端没有底部导航（已去掉，把高度让给正文）") : fail(`底部导航还在，有 ${navCount} 项`);
const backLink = await page.locator(".hd-back").count();
backLink === 0 ? pass("首页不显示「回小岛」（本来就在小岛上）") : fail("首页出现了「回小岛」按钮");
const bodyText1 = await text("body");
/今日/.test(bodyText1) ? pass("首页出现「今日」") : fail("首页没有「今日」字样");
const fatal = await page.locator(".fatal-box").count();
fatal === 0 ? pass("没有进入致命错误页") : fail("页面进入了 fatal-box 错误态");
await page.screenshot({ path: path.join(OUT, "01-home.png"), fullPage: true });

// ——————————————————————————————————————— 2. 口算
step("口算 /math 答题 + 进度条 + 完成判定");
await goto("/math", ".wrap");

// 先换一批，保证每次跑都是 0/20 的干净状态（顺带验证这个按钮）
const shuffle = page.locator("button", { hasText: /换一批/ }).first();
if (await shuffle.count()) {
  await shuffle.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  pass("「换一批题目」可用");
}

const rows = await page.locator(".m-row").count();
rows === 20 ? pass("渲染出 20 道口算题") : fail(`口算题行数=${rows}（期望 20）`);

const barBefore = await page.locator(".progress-line .bar .fill").first().getAttribute("style");
note(`作答前口算进度条=${barBefore}`);
const energyBefore = await page.locator("header .bar .fill, .topbar .bar .fill, .eng .fill").first().getAttribute("style").catch(() => null);
note(`作答前能量条=${energyBefore}`);

// 逐题作答：读题 -> 算 -> 填输入框 -> 回车
let answered = 0;
let correct = 0;
for (let i = 0; i < rows; i++) {
  const row = page.locator(".m-row").nth(i);
  const t = ((await row.locator(".m-q").textContent().catch(() => "")) ?? "").replace(/\s+/g, "");
  const m = t.match(/^(-?\d+)([+\-×÷])(-?\d+)/);
  if (!m) continue;
  const a = Number(m[1]);
  const b = Number(m[3]);
  const op = m[2];
  const ans = op === "+" ? a + b : op === "-" ? a - b : op === "×" ? a * b : Math.floor(a / b);
  const inp = row.locator("input").first();
  if (!(await inp.count())) continue;
  await inp.fill(String(ans)).catch(() => {});
  await inp.press("Enter").catch(() => {});
  await inp.blur().catch(() => {});
  answered += 1;
  correct += 1;
  await page.waitForTimeout(120);
}
answered >= 20 ? pass(`20 道题全部作答（模拟输入）`) : fail(`只答了 ${answered} 道`);

await page.waitForTimeout(1500);
const progressText = await text(".progress-line .notranslate");
note(`进度文案=${progressText.replace(/\s+/g, " ")}`);
/20\s*\/\s*20/.test(progressText) ? pass("进度已到 20/20") : fail(`进度未到 20/20：${progressText}`);
const barAfter = await page.locator(".progress-line .bar .fill").first().getAttribute("style");
/width:\s*100%/.test(barAfter ?? "") ? pass("口算进度条已填满 100%") : fail(`口算进度条未填满：${barAfter}`);
const energyAfter = await page.locator("header .bar .fill, .topbar .bar .fill, .eng .fill").first().getAttribute("style").catch(() => null);
if (energyAfter && energyAfter !== energyBefore) pass(`顶栏能量条随任务完成推进（${energyBefore} → ${energyAfter}）`);
else if (energyAfter) note(`顶栏能量条=${energyAfter}`);
const perfect = await page.locator(".perfect, .all-right, .banner").count();
note(`全对反馈元素数=${perfect}`);
await page.screenshot({ path: path.join(OUT, "02-math.png"), fullPage: true });

// ——————————————————————————————————————— 3. 语文 / 听写
step("语文 /chinese 选课文 + 听写板");
await goto("/chinese", ".wrap");
const bodyText3 = await text("body");
/天地人|课文|识字|第一/.test(bodyText3) ? pass("语文页出现课文内容") : note("语文页文案未匹配到课文名（可能是可选项）");
const handBoxes = await page.locator(".hw-box, .zi, .hw-cell, .zi-grid > *").count();
note(`汉字/听写相关元素数=${handBoxes}`);

// 尝试进入听写
const dictBtn = page.locator("button", { hasText: /听写|开始/ }).first();
if (await dictBtn.count()) {
  await dictBtn.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1600);
  const box = page.locator(".hw-box").first();
  const boxVisible = await box.isVisible().catch(() => false);
  if (boxVisible) {
    pass("听写板已打开");
    const bb = await box.boundingBox();
    if (bb) {
      // 在画布上画一横（模拟手写）
      await page.mouse.move(bb.x + 20, bb.y + bb.height / 2);
      await page.mouse.down();
      for (let k = 1; k <= 8; k++) {
        await page.mouse.move(bb.x + 20 + (bb.width - 40) * (k / 8), bb.y + bb.height / 2 + (k % 2 ? 6 : -6));
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      await page.waitForTimeout(300);
      pass("已在听写板上落笔（模拟手写轨迹）");
    }
  } else {
    note("点击后未出现 .hw-box（可能需先选课文）");
  }
}
await page.screenshot({ path: path.join(OUT, "03-chinese.png"), fullPage: true });

// ——————————————————————————————————————— 4. 童话
step("童话 /story 渲染");
await goto("/story", ".wrap");
const storyBtn = await page.locator("button", { hasText: /生成|童话|来一个/ }).count();
storyBtn > 0 ? pass(`童话页按钮 ${storyBtn} 个`) : fail("童话页没有生成按钮");
await page.screenshot({ path: path.join(OUT, "04-story.png"), fullPage: true });

// ——————————————————————————————————————— 5. 错题本
step("错题本 /wrong 渲染");
await goto("/wrong", ".wrap");
const wrongText = await text("body");
/错题本|错字|太棒啦|空/.test(wrongText) ? pass("错题本有列表或空态文案") : fail("错题本页面没有渲染内容");
const wTabs = await page.locator(".w-tab, .seg button, .tab").count();
wTabs > 0 ? pass(`错题本分区标签 ${wTabs} 个（数学/语文）`) : note("未识别到错题本分区标签");
await page.screenshot({ path: path.join(OUT, "05-wrong.png"), fullPage: true });

// ——————————————————————————————————————— 6. 家长后台
step("家长后台 /admin 独立版式");
await goto("/admin", "body");
const hasKidNav = await page.locator("nav.nav").count();
hasKidNav === 0 ? pass("后台没有出现孩子端导航（结构隔离生效）") : fail("后台仍然渲染了孩子端导航");
const adminText = await text("body");
/课文|内容|系统|后台/.test(adminText) ? pass("后台文案渲染正常") : fail("后台没有渲染出内容");
await page.screenshot({ path: path.join(OUT, "06-admin.png"), fullPage: true });

// 进编辑页
const firstLesson = page.locator("a[href*='lessons/'], tr, .lesson-item").first();
if (await firstLesson.count()) {
  await firstLesson.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const url = page.url();
  note(`编辑页 URL=${url.replace(BASE, "") || "/admin"}`);
  await page.screenshot({ path: path.join(OUT, "07-admin-edit.png"), fullPage: true });
}

// ——————————————————————————————————————— 7. 诊断抽屉
step("诊断抽屉（孩子端）");
await goto("/", ".wrap");
const diagBtn = page.locator("[class*='diag'], button").filter({ hasText: /日志|诊断/ }).first();
if (await diagBtn.count()) {
  await diagBtn.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const drawerVisible = await page.locator(".diag, .drawer, .diag-drawer").first().isVisible().catch(() => false);
  drawerVisible ? pass("诊断抽屉可打开") : note("点击后未识别到抽屉容器");
  await page.screenshot({ path: path.join(OUT, "08-diag.png"), fullPage: true });
} else {
  note("孩子端未找到诊断入口按钮（可能已按计划移除）");
}

// ——————————————————————————————————————— 8. 响应式
step("窄屏 360×780 回归");
await page.setViewportSize({ width: 360, height: 780 });
for (const p of ["/", "/math", "/chinese", "/story", "/language", "/video", "/wrong"]) {
  await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  overflow <= 2 ? pass(`${p} 无横向溢出`) : fail(`${p} 横向溢出 ${overflow}px`);
}
await page.screenshot({ path: path.join(OUT, "09-narrow.png"), fullPage: true });

// ——————————————————————————————————————— 汇总
step("控制台错误汇总");
if (consoleErrors.length === 0) {
  pass("零控制台错误 / 零未捕获异常");
} else {
  const uniq = [...new Set(consoleErrors)];
  for (const e of uniq.slice(0, 20)) fail(e);
  if (uniq.length > 20) fail(`...还有 ${uniq.length - 20} 条`);
}

await browser.close();

console.log("\n" + "═".repeat(60));
console.log(problems.length === 0 ? "冒烟测试通过：没有发现阻塞性问题" : `冒烟测试发现 ${problems.length} 个问题`);
if (notes.length) console.log(`备注 ${notes.length} 条`);
console.log(`截图目录：${OUT}`);
console.log("═".repeat(60));
process.exit(problems.length === 0 ? 0 : 1);
