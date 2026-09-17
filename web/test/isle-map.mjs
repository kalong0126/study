/**
 * 首页「学习小岛地图」+ 关卡顺序解锁 端到端回归
 *
 * 这一版首页把六项任务画成一条闯关路线：六座岛从左到右排开，虚线航线连起来，
 * 完成一座才解锁下一座，终点的宝箱跟着进度点亮。这个文件守住其中四条：
 *
 *   1. 地图本身：六座岛、顺序、岛名，与 TASK_DEFS 一致
 *   2. 顺序锁：只解锁到「当前这一关」，后面的岛显示锁；点锁着的岛、点底部导航，
 *      都会被挡回首页并给出「先闯过哪一关」的提示
 *   3. 错题修理站不参与顺序锁 —— 它是随时能去的工具站（闸在 WrongView 页内），
 *      所以它必须是「可点」而不是「上锁」
 *   4. 奖励与进度绑定：进度带节点、通关后的宝箱，跟着完成数走
 *
 * 为什么用隔离实例（端口 8797 + 独立 DB）：本测试要反复改打卡状态，
 * 跑在孩子的真实库上会把今天六项全置成完成。
 *
 * 用法：node web/test/isle-map.mjs   或   cd web && npm run test:isle
 * 依赖：playwright-core + 已构建的 web/dist
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

// 仓库根按「脚本自身位置」推，不能用 cwd —— `npm run` 时 cwd 是 web/
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(REPO, "server");
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.islemap.yaml");
const TEST_DB = path.join(SERVER, "data", "_islemap.db");
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

/** 首页地图上的六座岛，顺序即闯关顺序 */
const ISLE_NAMES = ["口算岛", "听写屋", "错题修理站", "故事树", "语言练习", "英文小屋"];
/** 参与顺序锁的五关（错题修理站不在其中） */
const CHAIN_NAMES = ["口算岛", "听写屋", "故事树", "语言练习", "英文小屋"];

const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_islemap.db }
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
  cacheDir: ./data/_islemap_tts
backup:
  enabled: false
  dir: ./data/_islemap_backup
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

const jpatch = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const dailyOf = async () => ((await (await fetch(`${BASE}/api/state`)).json()).daily ?? {});

let server;
let browser;
let page;

/** 重载首页，等地图画出来 */
async function openHome() {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("button.isle", { timeout: 20000 });
  await page.waitForTimeout(600);
}

/** 岛上那一行小字（岛名 + 状态提示） */
const isleTexts = () => page.locator("button.isle").allInnerTexts();

/** 当前地址栏路径（守卫拦下来时 URL 不会变，所以只靠它区分不了「没反应」和「被拦住」，
 *  每条拦截断言都要连 toast 一起看） */
const herePath = () => page.evaluate(() => location.pathname);
const toastText = () => page.locator("#toast").innerText().catch(() => "");

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
    executablePath: "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  /* ————————————————————————————— 1. 地图渲染 */
  step("1. 地图渲染：六座岛、顺序、岛名");
  await openHome();
  {
    const names = (await page.locator("button.isle .isle-tag b").allInnerTexts()).map((s) => s.trim());
    ok("地图上正好 6 座岛", names.length === 6, `${names.length} 座`);
    ok(
      "岛的排列顺序 = 闯关顺序",
      JSON.stringify(names) === JSON.stringify(ISLE_NAMES),
      JSON.stringify(names),
    );
    ok("英文小屋排在最后一座", names[names.length - 1] === "英文小屋", names.join(" / "));
    ok("航线虚线画出来了", (await page.locator(".isle-road path").count()) === 1);
    const d = await page.locator(".isle-road path").first().getAttribute("d");
    ok("航线连了 6 个点（5 段曲线）", ((d || "").match(/ C /g) || []).length === 5, String(d).slice(0, 60));
    ok("每座岛都挂着通关奖励", (await page.locator(".isle-star").count()) === 5, "错题修理站不发分，所以是 5");
  }

  /* ————————————————————————————— 2. 开局：只有第一关能走 */
  step("2. 开局（一关都没做）：只有口算岛是「当前这一关」");
  {
    ok("口算岛是当前关", (await page.locator(".isle.current").count()) === 1);
    ok("后面四关是锁着的", (await page.locator(".isle.locked").count()) === 4, `${await page.locator(".isle.locked").count()} 座`);
    ok("错题修理站不上锁（工具站）", (await page.locator(".isle.open").count()) === 1);
    ok("锁着的岛上画着锁", (await page.locator(".isle.locked .isle-mark.lock").count()) === 4);

    // 呼吸圈：幅度小、周期 2.8 秒，是导航页里唯一强调「下一步」的动效
    const anim = await page
      .locator(".isle.current .isle-art")
      .evaluate((el) => getComputedStyle(el, "::before").animationName);
    ok("当前这一关带呼吸圈", anim === "isleBreath", String(anim));

    const texts = (await isleTexts()).join(" | ");
    ok("第一关写着可做的事（20 道题）", /20 道题|0\s*\/\s*20/.test(texts), texts.slice(0, 80));
    // 锁着的岛写「这一关要做什么」（各关的短说明或真实进度），不写「还没解锁」——
    // 后者只是把右边的锁图标又说了一遍，白占一行
    const lockedTexts = await page.locator("button.isle.locked").allInnerTexts();
    ok(
      "锁着的岛写的是「这一关要做什么」，不是「还没解锁」",
      lockedTexts.length === 4 &&
        !lockedTexts.some((t) => t.includes("还没解锁")) &&
        lockedTexts.every((t) => t.includes("做完前一关才开门")),
      lockedTexts.join(" | ").replace(/\s+/g, " ").slice(0, 180),
    );
    ok("锁着的岛写着「做完前一关才开门」", texts.includes("做完前一关才开门"));
  }
  {
    // 留一张「开局」的图：这是绝大多数时候孩子看到的样子，比通关图更值得对照
    const dir = path.join(REPO, "web", "test", "shots");
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, "isle-map-start.png"), fullPage: true });
  }

  /* ————————————————————————————— 3. 点锁着的岛：拦住 + 说清先做哪一关 */
  step("3. 点锁着的岛 → 挡回首页，并点名该先闯哪一关");
  {
    await page.locator("button.isle", { hasText: "故事树" }).first().click();
    await page.waitForTimeout(700);
    ok("没有跳走（URL 仍是首页）", (await herePath()) === "/", await herePath());
    const t = await toastText();
    ok("提示里点名「口算岛」", t.includes("口算岛"), t);
  }

  /* ————————————————————————————— 4. 底部导航同样受顺序锁约束 */
  step("4. 底部导航点未解锁的页 → 同样被挡住");
  {
    await page.locator("nav.nav a", { hasText: "童话" }).first().click();
    await page.waitForTimeout(800);
    ok("童话页没进去", (await herePath()) === "/", await herePath());
    ok("同样给了提示", (await toastText()).includes("口算岛"));

    // 已有的一关（口算岛自己）必须进得去 —— 锁不能把孩子自己那一步也挡住
    await page.locator("nav.nav a", { hasText: "口算" }).first().click();
    await page.waitForTimeout(1200);
    ok("点导航「口算」能进（它是当前这一关）", (await herePath()) === "/math", await herePath());

    // 错题修理站不参与顺序锁，随时能进
    await page.locator("nav.nav a", { hasText: "错题本" }).first().click();
    await page.waitForTimeout(1200);
    ok("点导航「错题本」能进（工具站不上锁）", (await herePath()) === "/wrong", await herePath());
  }

  /* ————————————————————————————— 5. 做完一关 → 下一关解锁 */
  step("5. 口算做完 → 口算岛变「已通关」，听写屋接棒");
  {
    await jpatch("/api/state/daily", { tasks: { math: true } });
    await openHome();
    ok("口算岛变成已完成", (await page.locator(".isle.done").count()) === 1);
    ok("已完成挂上绿勾", (await page.locator(".isle.done .isle-mark.ok").count()) === 1);
    ok("已完成写「已通关」", (await isleTexts()).some((t) => t.includes("已通关")));
    ok("听写屋接过「当前这一关」", (await page.locator(".isle.current").count()) === 1);
    const cur = (await page.locator(".isle.current").first().innerText()).replace(/\s+/g, " ");
    ok("当前关是听写屋", cur.includes("听写屋"), cur);
    ok("锁只剩 3 座", (await page.locator(".isle.locked").count()) === 3, `${await page.locator(".isle.locked").count()} 座`);
    ok("进度带第一个节点打了勾", (await page.locator(".tk-dots li.done").count()) === 1);
  }

  /* ————————————————————————————— 6. 错题修理站仍然可进（不受前两关之外的影响） */
  step("6. 错题修理站始终可点");
  {
    await page.locator("button.isle", { hasText: "错题修理站" }).first().click();
    await page.waitForTimeout(1200);
    ok("点错题修理站能直接进 /wrong", (await herePath()) === "/wrong", await herePath());
  }

  /* ————————————————————————————— 7. 全部走完：无锁 + 宝箱点亮 */
  step("7. 六关全完成 → 地图无锁，宝箱点亮");
  {
    await jpatch("/api/state/daily", {
      tasks: { math: true, dictation: true, review: true, reading: true, language: true, video: true },
    });
    await openHome();
    ok("六座岛都是已完成", (await page.locator(".isle.done").count()) === 6);
    ok("一把锁都不剩", (await page.locator(".isle.locked").count()) === 0);
    ok("没有「出发」按钮了", (await page.locator(".isle-go").count()) === 0);
    ok("进度带 6 个节点全打勾", (await page.locator(".tk-dots li.done").count()) === 6);
    ok("宝箱已点亮", (await page.locator(".tk-chest.on").count()) === 1);
    const chest = (await page.locator(".tk-chest").first().innerText()).replace(/\s+/g, " ");
    ok("宝箱文案变成「宝箱开了」", chest.includes("宝箱开了"), chest);
    const count = (await page.locator(".tk-count").first().innerText()).replace(/\s+/g, " ");
    ok("今天完成 6 / 6", /6\s*\/\s*6/.test(count), count);
    const sub = (await page.locator(".isle-hd .sub").first().innerText()).replace(/\s+/g, " ");
    ok("副标题变成通关文案", sub.includes("全部走完"), sub);
  }

  /* ————————————————————————————— 8. 窄屏：横排换成竖向路线 */
  step("8. 窄屏（390px）：六座岛改成竖向路线，一个都不能少");
  {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(500);
    ok("六座岛仍全部渲染", (await page.locator("button.isle").count()) === 6);
    const pos = await page.locator("button.isle").first().evaluate((el) => getComputedStyle(el).position);
    ok("岛屿改成文档流（不再是绝对定位的横排）", pos === "static", pos);
    const dir = await page.locator("button.isle").first().evaluate((el) => getComputedStyle(el).flexDirection);
    ok("岛屿内部改成横向（岛在左、文字在右）", dir === "row", dir);
    const roadHidden = await page.locator(".isle-road").first().evaluate((el) => getComputedStyle(el).display);
    ok("窄屏收起横排航线（竖排里它只会添乱）", roadHidden === "none", roadHidden);
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    ok("窄屏没有横向溢出", overflows <= 1, `溢出 ${overflows}px`);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForTimeout(400);
  }

  /* ————————————————————————————— 9. 控制台 */
  step("9. 控制台");
  ok("零 console error / 零未捕获异常", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const shot = path.join(REPO, "web", "test", "shots", "isle-map.png");
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`\n截图：${shot}`);
} catch (e) {
  failures.push(`抛出异常：${e?.message ?? e}`);
  console.error(e);
} finally {
  try {
    await browser?.close();
  } catch {
    /* 忽略 */
  }
  try {
    server?.kill();
  } catch {
    /* 忽略 */
  }
  for (const f of [TEST_CONFIG, TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* 忽略 */
    }
  }
}

console.log("\n" + "═".repeat(60));
console.log(failures.length === 0 ? `小岛地图回归通过：${pass} 项断言全绿` : `小岛地图回归发现 ${failures.length} 个问题`);
for (const f of failures) console.log(`  ✗ ${f}`);
console.log("═".repeat(60));
process.exit(failures.length === 0 ? 0 : 1);
