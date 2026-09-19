/**
 * 孩子端导航 helper（测试共用）
 *
 * ⚠️ 底部导航（`.nav`）已按用户要求**整体去掉**，孩子端只剩一个入口：首页那张小岛地图。
 * 所以测试里那个「点导航切页」的动作，现在要写成「回首页 + 点对应的小岛」——
 * 对功能页来说等价（都落在同一个路由上），而且仍然是**应用内点击**（不整页刷新），
 * nav.mjs / layout.mjs 关心的 Transition 链路照样测得到。
 *
 * 被点的小岛必须是「能进的」（当前这一关 / 已通关 / 错题修理站），
 * 想测被锁的岛请直接用 `button.isle` + 断言留在首页。
 */

/** 顶栏「回小岛」按钮（功能页回首页的唯一按钮） */
export const BACK = ".hd-back";

/** 旧导航文案 → 小岛名（岛名是地图上唯一稳定的标识） */
const ISLE_OF = {
  口算: "口算岛",
  语文: "听写屋",
  童话: "故事树",
  语言: "语言练习",
  英文: "英文小屋",
  错题本: "错题修理站",
};

const PATH_OF = {
  今日: "/",
  口算: "/math",
  语文: "/chinese",
  童话: "/story",
  语言: "/language",
  英文: "/video",
  错题本: "/wrong",
};

/** 路由 → 小岛名（应用内切页时点哪一座岛） */
export const ISLE_OF_PATH = {
  "/math": "口算岛",
  "/chinese": "听写屋",
  "/story": "故事树",
  "/language": "语言练习",
  "/video": "英文小屋",
  "/wrong": "错题修理站",
};

export const pathOfNav = (label) => PATH_OF[label] ?? "/";

/**
 * 切到某个功能页（应用内点击）。
 * label 用旧导航的写法：今日 / 口算 / 语文 / 童话 / 语言 / 英文 / 错题本。
 */
export async function goNav(page, base, label, { wait = 1400, timeout = 20000 } = {}) {
  const isle = ISLE_OF[label];
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("button.isle", { timeout });
  await page.waitForTimeout(500);
  if (!isle) {
    // 「今日」＝就在首页
    await page.waitForTimeout(wait - 500);
    return;
  }
  const card = page.locator("button.isle", { hasText: isle }).first();
  if (!(await card.count())) throw new Error(`首页找不到小岛「${isle}」`);
  await card.click();
  await page.waitForTimeout(wait);
}

/**
 * 在应用内回首页：点顶栏「回小岛」。
 * 已经在首页时什么都不做（那个按钮此时不存在）。
 */
export async function goHome(page, base, { wait = 1200 } = {}) {
  const back = page.locator(BACK).first();
  if (await back.count()) {
    await back.click();
    await page.waitForTimeout(wait);
    return;
  }
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("button.isle", { timeout: 20000 });
  await page.waitForTimeout(wait);
}
