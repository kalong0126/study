/**
 * 固定视口布局回归
 *
 * 目标：孩子端（/ /math /chinese /story /language /wrong）在任何视口下都满足
 *   1. 整页不滚动（document 高度 == 视口高度，没有整页滚动条）
 *   2. .kid-shell 外壳高度 == 视口高度
 *   3. 顶栏、底栏都在视口内（不被推出屏幕）
 *   4. 内容区 .wrap 是独立滚动容器（overflow-y: auto）
 * 反面：家长后台 /admin 不走外壳，保持普通文档流（内容长时可整页滚，不被裁掉）。
 *
 * 用法：node web/test/layout.mjs [baseUrl]
 * 依赖：playwright-core（在 workbuddy 的 node workspace 里）
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

const BASE = process.argv[2] ?? "http://127.0.0.1:8788";
const CHROME =
  "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";

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
 * 上面那圈 `goto` 会真的访问 `/language` 和 `/video`，而这两个页面**一进去就会上报进度**
 * （语言 0/9、视频没看完）→ 后端把对应任务打回未完成 → 顺序锁随即把后面的页拦下来，
 * 于是点 `/video` 会被守卫挡回首页，报出「点击 /video 后 URL 是 /」。
 * 那是**产品行为正确**，跟布局无关 —— 这条测试要测的是「切页后整页不滚动」，
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

const KID_ROUTES = ["/", "/math", "/chinese", "/story", "/language", "/video", "/wrong"];

/** 读取当前页面的布局度量 */
async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const shell = document.querySelector(".kid-shell");
    const wrap = document.querySelector(".wrap");
    const topbar = document.querySelector(".topbar");
    const nav = document.querySelector(".nav");
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    return {
      pageOverflow: doc.scrollHeight - window.innerHeight,
      innerH: window.innerHeight,
      hasShell: !!shell,
      shellH: shell ? Math.round(shell.getBoundingClientRect().height) : -1,
      wrapOverflowY: wrap ? getComputedStyle(wrap).overflowY : "",
      wrapScrollable: wrap ? wrap.scrollHeight - wrap.clientHeight : -1,
      topbarTop: topbar ? Math.round(rect(topbar).top) : null,
      navBottom: nav ? Math.round(rect(nav).bottom) : null,
    };
  });
}

function checkViewport(m, label) {
  if (!m.hasShell) bad(`${label} 缺少 .kid-shell 外壳`);
  else ok(`${label} 有固定视口外壳`);

  if (m.hasShell && Math.abs(m.shellH - m.innerH) > 1)
    bad(`${label} 外壳高度 ${m.shellH} != 视口 ${m.innerH}`);
  else if (m.hasShell) ok(`${label} 外壳高度 == 视口 (${m.innerH}px)`);

  if (m.pageOverflow > 1) bad(`${label} 整页仍可滚动，多出 ${m.pageOverflow}px`);
  else ok(`${label} 整页不滚动`);

  if (m.wrapOverflowY !== "auto") bad(`${label} .wrap 不是滚动容器 (overflow-y=${m.wrapOverflowY})`);
  else ok(`${label} 内容区独立滚动 (overflow-y: auto)`);

  if (m.topbarTop !== null && m.topbarTop < -1) bad(`${label} 顶栏被推出视口 (top=${m.topbarTop})`);
  else if (m.topbarTop !== null) ok(`${label} 顶栏在视口内 (top=${m.topbarTop})`);

  if (m.navBottom !== null && m.navBottom > m.innerH + 1)
    bad(`${label} 底栏被推出视口 (bottom=${m.navBottom} > ${m.innerH})`);
  else if (m.navBottom !== null) ok(`${label} 底栏在视口内 (bottom=${m.navBottom})`);

  if (m.wrapScrollable > 0) note(`${label} 内容区可滚 ${m.wrapScrollable}px（内容比一屏长，属正常）`);
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
    await page.waitForTimeout(350);
    const m = await measure(page);
    console.log(`\n-- ${route} --`);
    checkViewport(m, route);
  }

  // 应用内点击切页：切完仍必须不滚动（整页加载不经过路由 Transition，会掩盖问题）
  console.log(`\n-- 应用内点击切页（${vp.name}）--`);
  await unlockAll(`点击前（${vp.name}）`);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".kid-shell", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  for (const route of ["/math", "/chinese", "/story", "/language", "/video", "/wrong", "/"]) {
    await page.click(`.nav a[href="${route}"]`);
    await page.waitForTimeout(420);
    const m = await measure(page);
    const url = new URL(page.url()).pathname;
    if (url !== route) {
      // 被守卫拦下时 URL 不变、只会弹 toast —— 把 toast 一起打出来，
      // 否则「点不动」和「点错了」在日志里长得一模一样。
      const toast = await page
        .locator("#toast")
        .innerText()
        .catch(() => "");
      bad(`点击 ${route} 后 URL 是 ${url}${toast ? `（提示：${toast.replace(/\s+/g, " ")}）` : ""}`);
    }
    checkViewport(m, `点击→${route}`);
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
  console.log("布局回归通过：整页不滚动，三段式固定正常");
}
