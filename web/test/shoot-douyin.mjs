import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "douyin-shots");
mkdirSync(OUT, { recursive: true });

const BASE = process.argv[2] ?? "http://127.0.0.1:8788";

const browser = await chromium.launch({
  executablePath:
    "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
  args: ["--no-sandbox"],
});
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 1.5,
  locale: "zh-CN",
});
const page = await ctx.newPage();

async function shoot(name, route, waitMs = 1800) {
  console.log("→", route);
  try {
    await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 25000 });
  } catch (e) {
    console.log("  nav warn:", e.message);
    await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 25000 });
  }
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: path.join(OUT, name + ".png") });
  console.log("  saved", name);
}

await shoot("01-home", "/", 2200);
await shoot("02-math", "/math");
await shoot("03-chinese", "/chinese");
await shoot("04-story", "/story", 4000);
await shoot("05-language", "/language", 2200);
await shoot("06-video", "/video");
await shoot("07-wrong", "/wrong");
await shoot("08-points", "/points");
await shoot("09-admin", "/admin", 2200);
await shoot("10-admin-lessons", "/admin/lessons", 1500);
await shoot("11-admin-system", "/admin/system", 1500);

await browser.close();
console.log("DONE ->", OUT);
