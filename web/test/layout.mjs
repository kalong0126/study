/**
 * 布局回归：顶栏 64px + 详情页统一工具栏 + **浏览器主滚动**
 *
 * 这一版守的是 2026-09-19 用户定的四条统一规则里的前三条（第四条「每页一个主操作按钮」
 * 由各页自己的用例守，这里只量几何）：
 *   ① 全局顶栏 ≈64px；详情页工具栏 52–56px；
 *   ② 标题 / 题量 / 章节 / 状态 / 操作在**同一行**（判据：标题与右段操作的竖直中心线对齐）；
 *   ③ 页面只保留浏览器主滚动 —— 整页可以滚，但 `.wrap` 不再是滚动容器，
 *      卡片里也不许再出现第二条滚动条。
 * 反面：家长后台 /admin 不走外壳，保持普通文档流（内容长时可整页滚，不被裁掉）。
 *
 * ⚠️ 之前这一版测的是「固定视口外壳」（.kid-shell 锁 100dvh、只 .wrap 内滚、整页不滚），
 *   那套已经按用户要求拆掉了 —— 别再把它测回来。
 *
 * 用法：node web/test/layout.mjs [baseUrl]
 * 依赖：playwright-core（在 workbuddy 的 node workspace 里）
 */
import { createRequire } from "node:module";
import { ISLE_OF_PATH } from "./_kidnav.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

const BASE = process.argv[2] ?? "http://127.0.0.1:8788";
const CHROME =
  "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";

/** 顶栏与工具栏的目标高度（用户规则①：64 / 52–56） */
const TOPBAR_H = 64;
const PT_MIN = 50;
const PT_MAX = 58;

/** 孩子端的详情页：每一页都该有**且只有一个**统一工具栏 */
const DETAIL_ROUTES = ["/math", "/chinese", "/story", "/language", "/video", "/wrong"];
const KID_ROUTES = ["/", ...DETAIL_ROUTES];

const problems = [];
const ok = (m) => console.log(`  ok  ${m}`);
const bad = (m) => {
  problems.push(m);
  console.log(`  XX  ${m}`);
};
const note = (m) => console.log(`  -   ${m}`);

/**
 * 把今日六项置为已完成。
 *
 * 为什么进「应用内点击切页」之前必须重来一遍：
 * 下面那圈 `goto` 会真的访问 `/language` 和 `/video`，而这两个页面**一进去就会上报进度**
 * （语言 0/9、视频没看完）→ 后端把对应任务打回未完成 → 顺序锁随即把后面的页拦下来，
 * 于是点 `/video` 会被守卫挡回首页，报出「点击 /video 后 URL 是 /」。
 * 那是**产品行为正确**，跟布局无关 —— 这条测试要测的是「切页后布局仍然成立」，
 * 所以先把锁解开再点。转发给任意实例都能跑，不依赖外部脚本预先改状态。
 */
async function unlockAll(label) {
  try {
    const r = await fetch(`${BASE}/api/state/daily`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: { math: true, dictation: true, review: true, reading: true, language: true, video: true },
      }),
    });
    if (!r.ok) note(`${label} 解锁失败 HTTP ${r.status}（后面的点击断言可能因此误报）`);
  } catch (e) {
    note(`${label} 解锁请求发不出去：${e?.message ?? e}`);
  }
}

const VIEWPORTS = [
  { name: "手机", width: 390, height: 844 },
  { name: "平板", width: 820, height: 1180 },
  { name: "桌面", width: 1280, height: 800 },
];

/** 读取当前页面的布局度量 */
async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const shell = document.querySelector(".kid-shell");
    const wrap = document.querySelector(".wrap");
    const topbar = document.querySelector(".topbar");
    const hd = document.querySelector(".hd");
    const back = document.querySelector(".hd-back");
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    const cs = (el) => (el ? getComputedStyle(el) : null);

    // 卡片里的嵌套滚动条：中文名对不上，直接扫「有滚动能力的元素」
    const nested = [];
    for (const el of document.querySelectorAll("main.wrap *")) {
      const s = getComputedStyle(el);
      if (!/^(auto|scroll)$/.test(s.overflowY)) continue;
      if (el.scrollHeight - el.clientHeight > 1) {
        nested.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}`);
      }
    }

    const tools = [...document.querySelectorAll(".pt")];
    const tool = tools[0] ?? null;
    // 「标题与操作在同一行」的判据：两者竖直中心线对齐
    const titleEl = tool?.querySelector(".pt-title");
    const lastBtn = tool ? [...tool.querySelectorAll(".pt-act button")].pop() ?? null : null;
    const centerY = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? Math.round(r.top + r.height / 2) : null;
    };

    return {
      pageOverflow: doc.scrollHeight - window.innerHeight,
      innerH: window.innerHeight,
      htmlOverflow: getComputedStyle(doc).overflowY,
      bodyOverflow: getComputedStyle(document.body).overflowY,
      hasShell: !!shell,
      wrapOverflowY: wrap ? getComputedStyle(wrap).overflowY : "",
      wrapScrollable: wrap ? wrap.scrollHeight - wrap.clientHeight : -1,
      topbarPos: topbar ? getComputedStyle(topbar).position : "",
      topbarTop: topbar ? Math.round(rect(topbar).top) : null,
      hdH: hd ? Math.round(rect(hd).height) : -1,
      // 「回小岛」按钮是否在视口里（底栏去掉后它就是回家的路）
      backBottom: back ? Math.round(rect(back).bottom) : null,
      hasNav: !!document.querySelector(".nav"),
      nested,
      toolCount: tools.length,
      toolH: tool ? Math.round(rect(tool).height) : -1,
      toolWrap: tool ? Math.round(rect(tool).width) : -1,
      // 工具栏里有多少个「主操作」按钮（.btn 里带颜色类的那一个）
      primaryCount: tool
        ? tool.querySelectorAll(".btn.primary, .btn.green, .btn.yellow, .btn.purple, .btn.pink").length
        : 0,
      titleCenter: centerY(titleEl),
      actCenter: centerY(lastBtn),
    };
  });
}

function checkViewport(m, label, { expectTool }) {
  if (!m.hasShell) bad(`${label} 缺少 .kid-shell 外壳`);
  else ok(`${label} 有 .kid-shell 外壳`);

  // ③ 浏览器主滚动：顶层不许被锁死
  if (m.htmlOverflow === "hidden" || m.bodyOverflow === "hidden")
    bad(`${label} 整页被锁死（html/body overflow:hidden）—— 用户要求只保留浏览器主滚动`);
  else ok(`${label} 浏览器主滚动可用`);

  if (m.wrapOverflowY === "auto" || m.wrapOverflowY === "scroll")
    bad(`${label} .wrap 又是滚动容器了 (overflow-y=${m.wrapOverflowY}) —— 会变成「滚错层」`);
  else ok(`${label} .wrap 不是滚动容器`);

  if (m.nested.length) bad(`${label} 卡片里还有嵌套滚动条：${m.nested.join("、")}`);
  else ok(`${label} 卡片里没有嵌套滚动条`);

  // ① 顶栏
  if (m.topbarPos !== "sticky" && m.topbarPos !== "fixed")
    bad(`${label} 顶栏不是 sticky/fixed (${m.topbarPos}) —— 整页滚动后它会跟着滚走`);
  else ok(`${label} 顶栏吸附在视口顶部 (${m.topbarPos})`);

  if (Math.abs(m.hdH - TOPBAR_H) > 4) bad(`${label} 顶栏高度 ${m.hdH} != ${TOPBAR_H}px`);
  else ok(`${label} 顶栏高度 ${m.hdH}px`);

  if (m.topbarTop !== null && m.topbarTop < -1) bad(`${label} 顶栏被推出视口 (top=${m.topbarTop})`);

  if (m.hasNav) bad(`${label} 又出现了底部导航（已按用户要求去掉）`);

  if (m.backBottom !== null && m.backBottom > m.innerH + 1)
    bad(`${label} 「回小岛」被推出视口 (bottom=${m.backBottom} > ${m.innerH})`);

  // ①② 详情页工具栏
  if (expectTool) {
    if (m.toolCount !== 1) bad(`${label} 应该有且只有一个工具栏 .pt，实际 ${m.toolCount} 个`);
    else ok(`${label} 有且只有一个统一工具栏`);

    // 「一行装下 52–56px」是宽屏上的要求：内容区够宽（≥1000px）时必须真的一行装下。
    // 窄屏（手机 / 平板竖屏）东西摆不开，允许折行 —— 那时只要求「不超过三行」。
    // 360px 的手机上 标题 + 中段控件 + 主操作 + ⓘ 物理上塞不进两行（实测最少 3 行），
    // 拿宽屏那条判据卡窄屏会变成「逼着把信息删掉」，不是用户要的。
    // 一行 53px、每多一行 +46px（36 控件 + 8 行距）→ 三行 ≈145，留点余量给 165。
    if (m.toolWrap >= 1000) {
      if (m.toolH < PT_MIN || m.toolH > PT_MAX) bad(`${label} 工具栏高度 ${m.toolH}px 不在 ${PT_MIN}–${PT_MAX}px（宽 ${m.toolWrap}）`);
      else ok(`${label} 工具栏高度 ${m.toolH}px（用户要求 52–56）`);

      if (m.titleCenter !== null && m.actCenter !== null && Math.abs(m.titleCenter - m.actCenter) > 10)
        bad(`${label} 标题与操作不在同一行（中心差 ${Math.abs(m.titleCenter - m.actCenter)}px）`);
      else if (m.titleCenter !== null) ok(`${label} 标题与操作在同一行`);
    } else {
      if (m.toolH > 165) bad(`${label} 工具栏在窄屏折了不止三行（高 ${m.toolH}px，宽 ${m.toolWrap}）`);
      else ok(`${label} 窄屏工具栏 ${m.toolH}px（允许折行）`);
    }

    if (m.primaryCount > 1) bad(`${label} 工具栏里有 ${m.primaryCount} 个主操作按钮（每页只留一个）`);
    else ok(`${label} 工具栏主操作按钮 ${m.primaryCount} 个`);
  } else if (m.toolCount > 0) {
    bad(`${label} 首页不该有详情页工具栏（.pt）`);
  }
}

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

for (const vp of VIEWPORTS) {
  console.log(`\n=== 视口 ${vp.name} ${vp.width}x${vp.height} ===`);
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    hasTouch: true,
  });
  const page = await ctx.newPage();

  for (const route of KID_ROUTES) {
    await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".kid-shell", { timeout: 8000 }).catch(() => {});
    // 详情页得等引导完成、路由视图真的挂上 —— 引导期间只有一张 loading 卡，还没有工具栏
    if (route === "/") await page.waitForSelector("button.isle", { timeout: 12000 }).catch(() => {});
    else await page.waitForSelector(".pt, .fatal-box", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(400);
    let m = await measure(page);
    console.log(`\n-- ${route} --`);
    checkViewport(m, route, { expectTool: route !== "/" });

    if (route === "/") continue;

    // 滚到底：顶栏必须还贴在视口顶部（sticky 真的生效，不是被 position:relative 蒙过去）
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    m = await measure(page);
    if (Math.abs(m.topbarTop) > 1) bad(`${route} 滚到底后顶栏不在视口顶部 (top=${m.topbarTop})`);
    else ok(`${route} 滚到底后顶栏仍在视口顶部`);
    if (m.backBottom === null || m.backBottom > m.innerH + 1)
      bad(`${route} 滚到底后「回小岛」不在视口里（bottom=${m.backBottom}）`);
    else ok(`${route} 滚到底后「回小岛」仍可点`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
  }

  // 应用内点击切页：切完布局仍必须成立（整页加载不经过路由 Transition，会掩盖问题）
  // 底部导航已去掉 → 出去靠「点小岛」，回来靠顶栏「回小岛」；整条链路都在应用内完成。
  console.log(`\n-- 应用内点击切页（${vp.name}）--`);
  await unlockAll(`点击前（${vp.name}）`);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("button.isle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);

  for (const route of DETAIL_ROUTES) {
    const isle = ISLE_OF_PATH[route];
    await page.locator("button.isle", { hasText: isle }).first().click();
    await page.waitForSelector(".pt", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(520);
    let m = await measure(page);
    let url = new URL(page.url()).pathname;
    if (url !== route) {
      // 被守卫拦下时 URL 不变、只会弹 toast —— 把 toast 一起打出来，
      // 否则「点不动」和「点错了」在日志里长得一模一样。
      const toast = await page
        .locator("#toast")
        .innerText()
        .catch(() => "");
      bad(`点小岛「${isle}」后 URL 是 ${url}${toast ? `（提示：${toast.replace(/\s+/g, " ")}）` : ""}`);
    }
    checkViewport(m, `点小岛→${route}`, { expectTool: true });

    const back = page.locator(".hd-back").first();
    if (!(await back.count())) {
      bad(`${route} 页找不到「回小岛」按钮（底栏去掉后就没路回首页了）`);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      continue;
    }
    await back.click();
    await page.waitForTimeout(520);
    m = await measure(page);
    url = new URL(page.url()).pathname;
    if (url !== "/") bad(`从 ${route} 点「回小岛」后 URL 是 ${url}（期望 /）`);
    checkViewport(m, `${route}→回小岛`, { expectTool: false });
  }

  await ctx.close();
}

// 家长后台：不走外壳，普通文档流
console.log("\n=== 家长后台 /admin（应保持普通文档流）===");
{
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  for (const route of ["/admin", "/admin/system"]) {
    await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => ({
      hasShell: !!document.querySelector(".kid-shell"),
      hasAdminBody: !!document.querySelector(".admin-body"),
      bodyOverflow: getComputedStyle(document.body).overflowY,
    }));
    console.log(`\n-- ${route} --`);
    if (m.hasShell) bad(`${route} 不应有 .kid-shell 外壳`);
    else ok(`${route} 无外壳（普通文档流）`);
    if (!m.hasAdminBody) bad(`${route} 缺少 .admin-body`);
    else ok(`${route} 有 .admin-body`);
    if (m.bodyOverflow === "hidden") bad(`${route} body overflow:hidden 会裁掉后台内容`);
    else ok(`${route} body 未锁定，可整页滚动`);
  }
  await ctx.close();
}

await browser.close();

console.log("\n========================================");
if (problems.length) {
  console.log(`布局回归失败：${problems.length} 处问题`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
} else {
  console.log("布局回归通过：顶栏 64px + 统一工具栏 + 浏览器主滚动");
}
