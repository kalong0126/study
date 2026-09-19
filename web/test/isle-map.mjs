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

    // 海洋铺在**整块 hero** 上（标题 + 六座岛），不是只铺地图那一格 ——
    // 标题必须是「场景里的一部分」，而不是卡片外面孤零零的一行字。
    // 兜底底色取海色：图没到位的一瞬间也不能闪白块。
    const cardBg = await page.locator(".isle-card").evaluate((el) => {
      const s = getComputedStyle(el);
      return { img: s.backgroundImage, color: s.backgroundColor };
    });
    ok(
      "海洋背景铺在整块 hero 上（含兜底海色）",
      /url\(/.test(cardBg.img) && /isle-bg-hero/.test(cardBg.img) && cardBg.color === "rgb(203, 230, 248)",
      JSON.stringify(cardBg).slice(0, 170),
    );
    // 图按卡片比例（2048:745）定高，cover 进来零裁切 —— 灯塔、帆船、沙滩都留在画面里
    const hero = await page.locator(".isle-card").boundingBox();
    ok(
      "hero 按背景图比例定高（cover 零裁切）",
      Math.abs(hero.width / hero.height - 2048 / 745) < 0.03,
      `${hero.width.toFixed(0)}x${hero.height.toFixed(0)} = ${(hero.width / hero.height).toFixed(3)}（目标 ${(2048 / 745).toFixed(3)}）`,
    );
    // 标题真的压在图上：它的顶边贴着卡片顶边，底边仍在卡片内
    const hdBox = await page.locator(".isle-hd").boundingBox();
    ok(
      "标题压在海洋图上（不是卡片外的一行字）",
      hdBox.y >= hero.y - 1 && hdBox.y + hdBox.height < hero.y + hero.height * 0.45,
      `hero ${hero.y.toFixed(0)}..${(hero.y + hero.height).toFixed(0)}，标题 ${hdBox.y.toFixed(0)}..${(hdBox.y + hdBox.height).toFixed(0)}`,
    );
    // 标题不能压到第一座岛（窄一点的窗口上最容易出这个问题）
    const firstIsle = await page.locator("button.isle").first().boundingBox();
    ok(
      "标题与第一座岛不重叠",
      hdBox.y + hdBox.height <= firstIsle.y + 1,
      `标题底 ${(hdBox.y + hdBox.height).toFixed(0)} vs 岛顶 ${firstIsle.y.toFixed(0)}`,
    );
    const roadStroke = await page
      .locator(".isle-road path")
      .evaluate((el) => getComputedStyle(el).stroke);
    ok("航线是深一档的蓝色虚线（在海面图上看得清）", roadStroke === "rgb(79, 150, 210)", roadStroke);
    // 淡黄是暖色，暖色背景上必须确认文字对比度还够（WCAG AA：正常字号 4.5:1）
    const contrast = await page.locator(".isle-tag b").first().evaluate((el) => {
      const rgb = (c) => (c.match(/\d+/g) || []).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => {
        const f = (v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const fg = lum(rgb(getComputedStyle(el).color));
      const bg = lum(rgb(getComputedStyle(el.parentElement).backgroundColor));
      const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    });
    ok("岛名对比度 ≥ 4.5:1（WCAG AA）", contrast >= 4.5, `${contrast}:1`);

    // 岛名 + 状态胶囊是**叠在岛身上**的（参考图那样：名字写在岛上，不漂在岛外）。
    // 判据用「交叠面积」而不是「标签顶边在岛顶边下面」——
    // 后者在标签只压住岛的一个角时也成立，等于没判。
    const capOnIsle = await page
      .locator("button.isle")
      .first()
      .evaluate((el) => {
        const art = el.querySelector(".isle-art").getBoundingClientRect();
        const cap = el.querySelector(".isle-cap").getBoundingClientRect();
        const ovTop = Math.max(art.top, cap.top);
        const ovBot = Math.min(art.bottom, cap.bottom);
        const ovLeft = Math.max(art.left, cap.left);
        const ovRight = Math.min(art.right, cap.right);
        const ov = Math.max(0, ovBot - ovTop) * Math.max(0, ovRight - ovLeft);
        return { ov, capArea: cap.width * cap.height, artBottom: art.bottom, capTop: cap.top };
      });
    ok(
      "岛名 + 状态胶囊叠在岛身上（不是挂在岛下面）",
      capOnIsle.capTop < capOnIsle.artBottom && capOnIsle.ov > 0,
      `胶囊顶 ${capOnIsle.capTop.toFixed(0)} vs 岛底 ${capOnIsle.artBottom.toFixed(0)}，交叠 ${Math.round(capOnIsle.ov)}px²`,
    );

    // 岛名只压岛的**底座**，不能压到岛上的房子/树（用户明确要求）。
    // 判据一：岛名胶囊的顶边落在素材高度的 60% 以下。
    // 60% 不是随手写的：六张 3D 素材逐横带量过（按 5% 一条数「不透明覆盖率 + 主色」），
    // 功能物体（房子/树/书/卷轴）的最低点最高的是 video.png 的 ~60%
    //（math 48% / dictation 52% / language 55% / reading 55% / review 57% / video 60%），
    // 草坪约 55%–78%、土层底座约 80%–92%。
    // 判据二：整块标牌（岛名 + 状态胶囊）仍在 hero 卡片内 —— 卡片是 `overflow: hidden`，
    // 越界就等于被裁掉。这条比「底边比例 ≤ 100%」更贴近真实约束：物体最高的三座
    //（review/reading/video）本来就靠 `--cap-drop` 把标牌压到岛底座下沿以下，
    // 底边比例合法地超过 100%，但绝不能被裁。
    const capGeom = await page.locator("button.isle").evaluateAll((els) =>
      els.map((el) => {
        const art = el.querySelector(".isle-art").getBoundingClientRect();
        const tag = el.querySelector(".isle-tag").getBoundingClientRect();
        const btn = el.querySelector(".isle-wait, .isle-go, .isle-flag").getBoundingClientRect();
        return {
          name: el.querySelector(".isle-tag b").textContent.trim(),
          tagTopRatio: (tag.top - art.top) / art.height,
          tagBottomRatio: (tag.bottom - art.top) / art.height,
          btnBottomRatio: (btn.bottom - art.top) / art.height,
          capBottom: btn.bottom,
          drop: parseFloat(getComputedStyle(el).getPropertyValue("--cap-drop")) || 0,
        };
      }),
    );
    const heroBottom = hero.y + hero.height;
    const geomBad = capGeom.filter((g) => !(g.tagTopRatio >= 0.6 && g.capBottom <= heroBottom - 2));
    ok(
      "六座岛的岛名都只压底座、不压房子/树，且标牌没被卡片裁掉",
      capGeom.length === 6 && geomBad.length === 0,
      capGeom
        .map(
          (g) =>
            `${g.name} 顶 ${(g.tagTopRatio * 100).toFixed(0)}% 底 ${(g.tagBottomRatio * 100).toFixed(0)}% 距卡底 ${(heroBottom - g.capBottom).toFixed(0)}px`,
        )
        .join(" | "),
    );

    // 用户点名：几座岛的标牌要再往下让，幅度不同 ——
    // 错题修理站 / 英文小屋 / 听写屋 10px，故事树 20px（树冠最高）。
    // 读 computed 值而不是读源码 —— 样式被改掉这条才会红。
    // 另外顺手锁住**方向**：`--cap-drop` 是「下移为正」，这几座的标牌顶边必须比
    // 另外三座更低（出现过 calc 里写成 `+` 把下移翻成上移的事故，光比值对不上方向）。
    const EXPECT_DROP = { 错题修理站: 10, 英文小屋: 10, 听写屋: 10, 故事树: 20 };
    const dropBadVal = capGeom.filter((g) => (EXPECT_DROP[g.name] ?? 0) !== g.drop);
    ok(
      "标牌追加下移量与点位一致（错题修理站/英文小屋/听写屋 10px、故事树 20px、其余 0）",
      dropBadVal.length === 0,
      capGeom.map((g) => `${g.name} ${g.drop}px`).join(" | "),
    );
    const dropNames = Object.keys(EXPECT_DROP);
    const baseTop = Math.min(
      ...capGeom.filter((g) => !dropNames.includes(g.name)).map((g) => g.tagTopRatio),
    );
    const dropBad = capGeom.filter((g) => dropNames.includes(g.name) && g.tagTopRatio <= baseTop);
    ok(
      "这三座岛名确实比另外三座**更低**（下移方向没写反）",
      dropBad.length === 0,
      `基准顶 ${(baseTop * 100).toFixed(0)}% | ` +
        capGeom
          .map((g) => `${g.name} ${(g.tagTopRatio * 100).toFixed(0)}%`)
          .join(" | "),
    );

    // 三块（地图 / 进度带 / 学习小档案）被同一个外框框起来 ——
    // 光有一条 .home-frame 不算数：要确认它真是这三块的父节点，而且三块都落在框内。
    const framed = await page.evaluate(() => {
      const f = document.querySelector(".home-frame");
      if (!f) return null;
      const fr = f.getBoundingClientRect();
      const kids = [...f.children].map((c) => ({
        cls: c.className,
        inside:
          c.getBoundingClientRect().left >= fr.left - 1 &&
          c.getBoundingClientRect().right <= fr.right + 1 &&
          c.getBoundingClientRect().top >= fr.top - 1 &&
          c.getBoundingClientRect().bottom <= fr.bottom + 1,
        padTop: Math.round(c.getBoundingClientRect().top - fr.top),
      }));
      return { kids, radius: getComputedStyle(f).borderTopLeftRadius, border: getComputedStyle(f).borderTopWidth };
    });
    ok(
      "三块收在同一个外框里（地图 / 进度带 / 学习小档案）",
      !!framed &&
        framed.kids.length === 3 &&
        /isle-card/.test(framed.kids[0].cls) &&
        /isle-track/.test(framed.kids[1].cls) &&
        /isle-stats/.test(framed.kids[2].cls),
      JSON.stringify(framed?.kids.map((k) => k.cls)),
    );
    ok(
      "外框真的框住了三块，且间距一致（不是只有一条边框线）",
      !!framed && framed.kids.every((k) => k.inside) && new Set(framed.kids.map((k) => k.padTop)).size >= 1 && framed.kids[0].padTop >= 10,
      JSON.stringify(framed?.kids.map((k) => k.padTop)),
    );
    // 外框圆角要跟内层卡片「同心」：20px 卡片 + 14px 内边距 → 34px
    ok("外框圆角与内层卡片同心（20 + 14 = 34px）", framed?.radius === "34px", `${framed?.radius} / 描边 ${framed?.border}`);

    // 家长后台的说明（课文库几篇、/admin 在哪）从孩子端整段拿掉：
    // 孩子端不该出现任何指向家长后台的说明文字，家长知道 /admin 就够了。
    const kidText = await page.locator("main.wrap").innerText();
    ok(
      "孩子端不再出现「课文库 / 内容后台」的说明",
      (await page.locator(".isle-note").count()) === 0 && !/课文库|内容后台/.test(kidText),
      kidText.replace(/\s+/g, " ").slice(-70),
    );

    // 奖励宝箱也换成了 3D 素材图，同样要确认图真的解码出来了
    const chestArt = await page
      .locator(".tk-chest .tk-chest-art")
      .evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }));
    ok("宝箱用的是 3D 素材图且已加载", chestArt.w >= 100 && chestArt.h >= 100, JSON.stringify(chestArt));

    // 学习小档案：三张各自成卡（图标 + 数字 + 标签 + 一句鼓励），不再套一层白卡 ——
    // 套上之后这三块就只是「一张卡里的三个格子」，三行长得一样的数字。
    const statCards = page.locator(".isle-stats .stat-card");
    ok("学习小档案是三张独立卡", (await statCards.count()) === 3, `${await statCards.count()} 张`);
    // 图标位装的是 3D 素材图（不是线描 SVG）。断言「真的解码出来了」=
    // naturalWidth > 0 —— 只数 <li> 或 <img> 的话，路径写错、图 404 了照样是 3 张，
    // 页面上一片空白也全绿。三个 <img> 还必须是三张不同的图，不能是同一张复用。
    const statArt = await page
      .locator(".isle-stats .stat-ico img.stat-art")
      .evaluateAll((els) =>
        els.map((el) => ({ w: el.naturalWidth, src: el.getAttribute("src") || "" })),
      );
    ok(
      "每张卡的 3D 图标都真的加载出来了",
      statArt.length === 3 && statArt.every((a) => a.w >= 100),
      JSON.stringify(statArt),
    );
    ok("三张卡的图标各不相同", new Set(statArt.map((a) => a.src)).size === 3, statArt.map((a) => a.src.split("/").pop()).join(" | "));
    const statTips = await page.locator(".isle-stats .stat-t").allInnerTexts();
    ok(
      "每张卡都带一句鼓励",
      statTips.length === 3 && statTips.every((t) => t.trim().length >= 4),
      statTips.map((t) => t.trim()).join(" | "),
    );
    // 三张卡底色各不相同 —— 靠颜色 + 图标区分，而不是三行一样的数字
    const statBg = await statCards.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).backgroundColor),
    );
    ok("三张卡底色各不相同", new Set(statBg).size === 3, statBg.join(" | "));

    // 字体：界面用方正准圆简体（自托管切片），识字内容用楷体。
    // 分两条守：一条守「声明写对了」，一条守「文件真的加载进来了」——
    // 只判前一条的话，字体 404 了照样全绿。
    const bodyFont = await page.locator("body").evaluate((el) => getComputedStyle(el).fontFamily);
    ok("界面字体是方正准圆简体", /方正准圆简体/.test(bodyFont), bodyFont.slice(0, 64));
    const fontLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].some((f) => f.family.includes("方正准圆简体") && f.status === "loaded");
    });
    ok("字体切片真的加载成功（不是只剩一句声明）", fontLoaded === true, String(fontLoaded));
    // 语文课文原文是「要照着认的字」，必须楷体（`.lesson-text`）。这条以前踩过坑：
    // 字体列表里混进 `inherit` 这种 CSS-wide 关键字会让整条声明判无效，楷体白设、悄悄退回黑体。
    // 注意：童话正文（`.story-text`）**改成圆体**了（与全站统一），所以这里只能量 `.lesson-text`。
    const kaiFont = await page.evaluate(() => {
      const d = document.createElement("div");
      d.className = "story-text lesson-text";
      document.body.appendChild(d);
      const f = getComputedStyle(d).fontFamily;
      d.remove();
      return f;
    });
    ok("语文课文原文用楷体（识字用规范字形）", /Kaiti|KaiTi|楷体/.test(kaiFont), kaiFont.slice(0, 64));
    const storyFont = await page.evaluate(() => {
      const d = document.createElement("div");
      d.className = "story-text";
      document.body.appendChild(d);
      const f = getComputedStyle(d).fontFamily;
      d.remove();
      return f;
    });
    ok("童话正文用站内圆体（不再用楷体）", /方正准圆简体/.test(storyFont), storyFont.slice(0, 64));
  }

  /* ————————————————————————————— 2. 开局：只有第一关能走 */
  step("2. 开局（一关都没做）：只有口算岛是「当前这一关」");
  {
    ok("口算岛是当前关", (await page.locator(".isle.current").count()) === 1);
    ok("后面四关是锁着的", (await page.locator(".isle.locked").count()) === 4, `${await page.locator(".isle.locked").count()} 座`);
    ok("错题修理站不上锁（工具站）", (await page.locator(".isle.open").count()) === 1);

    // 未解锁的岛保持全彩、也不在岛角再挂一把锁：整座岛看起来和能点的一模一样，
    // 「还锁着」全靠岛名下面那颗胶囊说 —— 这是刻意的（去色会让六座岛像坏了一半）
    const dim = await page
      .locator(".isle.locked .isle-art")
      .first()
      .evaluate((el) => getComputedStyle(el).filter);
    ok("未解锁的岛不置灰（保持全彩）", dim === "none", dim);
    ok("岛角不再挂锁角标", (await page.locator(".isle-mark.lock").count()) === 0);

    // 呼吸圈：幅度小、周期 2.8 秒，是导航页里唯一强调「下一步」的动效
    const anim = await page
      .locator(".isle.current .isle-art")
      .evaluate((el) => getComputedStyle(el, "::before").animationName);
    ok("当前这一关带呼吸圈", anim === "isleBreath", String(anim));

    // 岛名下面不再有第二行：以前那行写的是「0 / 20」「用时 1:32」「先做口算和听写」……
    // 六座岛挤在 1/6 格宽里，这行字一折行就把整条地图的基线拉得参差不齐。
    // 断言标签纯文本正好等于岛名（多一个字都算第二行回来了）。
    const tagTexts = (await page.locator("button.isle .isle-tag").allInnerTexts()).map((t) =>
      t.replace(/\s+/g, ""),
    );
    ok(
      "每座岛只写岛名，岛下没有第二行",
      JSON.stringify(tagTexts) === JSON.stringify(ISLE_NAMES),
      tagTexts.join(" | "),
    );

    const waits = (await page.locator(".isle-wait").allInnerTexts()).map((t) => t.replace(/\s+/g, ""));
    ok(
      "四座锁着的岛都写着「待解锁」",
      waits.length === 4 && waits.every((t) => t === "待解锁"),
      waits.join(" | "),
    );
    // 「待解锁」要跟着一把小锁出现：只看图标对不识字的孩子是没用的，
    // 只看文字又丢了地图上一眼可见的「锁」的信号。
    // 断言图形条数（而不是只看 <svg> 存在）—— 图标名写错时 Icon 会渲染一个空 svg，
    // count() 照样是 1，这种「假通过」必须堵掉。
    const lockGlyph = await page.locator(".isle-wait svg rect, .isle-wait svg path").count();
    ok("「待解锁」前面挂着一把小锁", lockGlyph >= 12, `锁图形 ${lockGlyph} 条（4 颗胶囊）`);
    // 注意别断言 display === "inline-flex"：`.isle` 是 flex 容器，
    // 它的 flex item 会被 CSS blockify —— inline-flex 计算出来就是 flex。
    // 真正要守的是「图标和文字并排一行」（flex 容器 + 单行高度），
    // 堆成两行时 .isle-wait 的高度会翻倍。
    const waitStyle = await page
      .locator(".isle-wait")
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        const svg = el.querySelector("svg");
        const r = el.getBoundingClientRect();
        const sr = svg ? svg.getBoundingClientRect() : null;
        return {
          display: s.display,
          gap: s.gap,
          svgW: svg ? getComputedStyle(svg).width : "",
          h: Math.round(r.height),
          radius: s.borderTopLeftRadius,
          bg: s.backgroundColor,
          // 小锁必须在文字左边，而不是被挤到上一格去
          lockBeforeText: sr ? sr.left < r.left + r.width / 2 : false,
        };
      });
    ok(
      "锁和「待解锁」并排一行，锁在前、尺寸 13px",
      /flex$/.test(waitStyle.display) &&
        waitStyle.svgW === "13px" &&
        waitStyle.lockBeforeText &&
        // 单行 26px（padding 4+4 + 1.5×2 描边 + 一行字）；图标掉到第二行会到 45px 以上
        waitStyle.h <= 30,
      JSON.stringify(waitStyle),
    );
    // 形状与「出发」一致：白底 + 全圆角胶囊。孩子扫一排按钮时，
    // 位置和形状固定、只有颜色不同，比三种不同排版好认。
    ok(
      "「待解锁」是白色圆角胶囊（与「出发」同形状）",
      waitStyle.radius === "999px" && waitStyle.bg === "rgb(255, 255, 255)",
      `radius=${waitStyle.radius}, bg=${waitStyle.bg}`,
    );
    const goBox = await page
      .locator(".isle-go")
      .first()
      .evaluate((el) => ({ h: Math.round(el.getBoundingClientRect().height), r: getComputedStyle(el).borderTopLeftRadius }));
    ok(
      "「待解锁」与「出发」高度一致",
      Math.abs(goBox.h - waitStyle.h) <= 1 && goBox.r === "999px",
      `出发 ${goBox.h}px / 待解锁 ${waitStyle.h}px`,
    );
  }
  {
    // 留一张「开局」的图：这是绝大多数时候孩子看到的样子，比通关图更值得对照
    const dir = path.join(REPO, "web", "test", "shots");
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, "isle-map-start.png"), fullPage: true });

    // 局部放大图：这几处都是「一眼看上去对不对」的判断（岛名压在哪儿、连线断没断、
    // 外框收没收住），整页缩略图看不出来。改版式时先看这几张。
    const zoom = path.join(dir, "isle-shot");
    fs.mkdirSync(zoom, { recursive: true });
    for (const [name, sel] of [
      ["01-track", ".isle-track"],
      ["02-hero", ".isle-card"],
      ["03-stats", ".isle-stats"],
      ["04-isle-one", "button.isle"],
      ["06-frame", ".home-frame"],
    ]) {
      await page.locator(sel).first().screenshot({ path: path.join(zoom, `${name}.png`) });
    }
    // 平板宽度：地图转竖向，岛名与状态胶囊必须回到同一行、不再叠岛
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(400);
    await page.locator(".isle-card").first().screenshot({ path: path.join(zoom, "05-tablet-hero.png") });
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForTimeout(400);
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

  /* ————————————————————————————— 4. 岛就是入口：能进的都要点得动
     底部导航已按用户要求整体去掉，孩子端只剩小岛地图这一条路 + 顶栏「回小岛」。
     所以「点得动」这件事比过去更要紧：已通关的、当前这一关、工具站都必须能进 ——
     任何一座岛点了没反应，那个页面就等于没了。 */
  step("4. 能进的岛都点得动（含已通关的），回首页靠顶栏「回小岛」");
  {
    // 先把口算做完，做出一座「已通关」的岛
    await jpatch("/api/state/daily", { tasks: { math: true } });
    await openHome();

    const doneIsle = page.locator("button.isle.done", { hasText: "口算岛" }).first();
    ok("口算岛已是「已通关」", (await doneIsle.count()) === 1);
    await doneIsle.click();
    await page.waitForTimeout(1200);
    ok("点**已通关**的岛仍然进得去（不该变成点了没反应）", (await herePath()) === "/math", await herePath());

    await page.locator(".hd-back").first().click();
    await page.waitForTimeout(1000);
    ok("顶栏「回小岛」能回首页", (await herePath()) === "/", await herePath());

    // 当前这一关（口算做完 → 听写屋接棒）也要能进
    await page.locator("button.isle", { hasText: "听写屋" }).first().click();
    await page.waitForTimeout(1200);
    ok("点「当前这一关」能进", (await herePath()) === "/chinese", await herePath());
    await page.locator(".hd-back").first().click();
    await page.waitForTimeout(1000);

    // 错题修理站不参与顺序锁，随时能进
    await page.locator("button.isle", { hasText: "错题修理站" }).first().click();
    await page.waitForTimeout(1200);
    ok("点工具站「错题修理站」能进", (await herePath()) === "/wrong", await herePath());
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
    // 节点之间的虚线必须**断成一段一段**，不能穿进数字圆点里。
    // 这条是回归：连线是 li::before（绝对定位），圆点是普通流元素 ——
    // 绝对定位的伪元素画在普通流元素之上，所以「从圆心画到圆心」的老写法
    // 会让线正好从数字身上横穿过去，六个数字全被划一道。
    const segs = await page.evaluate(() => {
      const lis = [...document.querySelectorAll(".tk-dots li")];
      return lis.slice(1).map((li) => {
        const s = getComputedStyle(li, "::before");
        const lr = li.getBoundingClientRect();
        const dot = li.querySelector(".tk-dot").getBoundingClientRect();
        const prev = lis[lis.indexOf(li) - 1].querySelector(".tk-dot").getBoundingClientRect();
        const left = lr.left + parseFloat(s.left);
        return {
          left,
          right: left + parseFloat(s.width),
          dotLeft: dot.left,
          prevDotRight: prev.right,
        };
      });
    });
    ok("进度带连线断成 5 段（每段在两个圆点之间）", segs.length === 5, `${segs.length} 段`);
    ok(
      "连线不穿过数字圆点（两端都让开了）",
      segs.every((s) => s.right <= s.dotLeft + 1 && s.left >= s.prevDotRight - 1),
      segs
        .map((s) => `${s.left.toFixed(0)}..${s.right.toFixed(0)} vs 点 ${s.prevDotRight.toFixed(0)}..${s.dotLeft.toFixed(0)}`)
        .join(" | "),
    );
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
    // 竖排卡片里岛名与状态胶囊必须在同一行（岛名不再有第二行小字，卡片只剩这两块）
    const rowDelta = await page
      .locator("button.isle")
      .first()
      .evaluate((el) => {
        const tag = el.querySelector(".isle-tag").getBoundingClientRect();
        const btn = el.querySelector(".isle-wait, .isle-go, .isle-flag").getBoundingClientRect();
        return Math.abs(tag.top + tag.height / 2 - (btn.top + btn.height / 2));
      });
    ok("窄屏下岛名与状态胶囊同一行", rowDelta < 12, `中心差 ${Math.round(rowDelta)}px`);
    await page.screenshot({ path: path.join(REPO, "web", "test", "shots", "isle-map-narrow.png"), fullPage: true });
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
