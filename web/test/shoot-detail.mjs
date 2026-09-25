import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "douyin-shots");
mkdirSync(OUT, { recursive: true });
const BASE = "http://127.0.0.1:8788";

const browser = await chromium.launch({
  executablePath: "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
  args: ["--no-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5, locale: "zh-CN" });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(OUT, n + ".png") });

await page.goto(BASE + "/language", { waitUntil: "networkidle", timeout: 25000 });
await page.waitForTimeout(2500);
const n = await page.locator("button.lg-cell").count();
console.log("cards:", n);
for (let i = 0; i < Math.min(n, 9); i++) {
  await page.locator("button.lg-cell").nth(i).click();
  await page.waitForTimeout(2000);
  await shot(`lang-${i+1}`);
  console.log("shot lang-" + (i+1));
  await page.click("text=九宫格", { timeout: 3000 });
  await page.waitForTimeout(800);
}

await page.goto(BASE + "/chinese", { waitUntil: "networkidle", timeout: 25000 });
await page.waitForTimeout(1500);
await page.click("text=生字听写");
await page.waitForTimeout(1000);
await shot("dictation-tab");
await page.click("text=开始听写");
await page.waitForTimeout(2500);
await shot("dictation-board");

await browser.close();
console.log("DONE");
