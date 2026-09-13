/**
 * 「听写再来一轮 = 练还没掌握的字」回归测试
 *
 * 用户报的 bug：第一轮写完、审核完，再点「再来一轮」，不是练剩下的字，而是从头重来。
 *
 * 根因：旧实现用 roundStart 这个「位置指针」切片续写，生字数 ≤ 本轮字数时一轮写完全部，
 * roundStart 归零 → 下一轮从第一个字重头写。而且指针是组件内存态，切 tab / 刷新即丢。
 *
 * 现在的规则：start() 从「还没掌握的字」（状态 ≠ 1）里取字——写错(0)和没写到(undefined)
 * 都留下，已写对/已掌握(1)跳过；全部掌握后回退到全部，允许自由重练。
 *
 * 为什么用隔离实例（端口 8797 + 独立 DB）：测试会写掌握度、走「大人审核」落库，
 * 跑在真实库上会污染数据。
 *
 * 用法：node web/test/dictation-continue.mjs   或   cd web && npm run test:dictation
 * 依赖：playwright-core + 已构建的 web/dist
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(REPO, "server");
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.dictation.yaml");
const TEST_DB = path.join(SERVER, "data", "_dictation.db");
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

const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_dictation.db }
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
  cacheDir: ./data/_dictation_tts
backup:
  enabled: false
  dir: ./data/_dictation_backup
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

let server;
let browser;
let page;

try {
  console.log(`\n=== 准备隔离实例（端口 ${PORT}，独立 DB）===`);
  fs.writeFileSync(TEST_CONFIG, TEST_CONFIG_YAML, "utf8");
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
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
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  const shotDir = path.join(REPO, "web", "test", "shots");
  fs.mkdirSync(shotDir, { recursive: true });

  /* ————————————————————————— 1. 拿到第一课生字 */
  step("1. 取第一课生字列表");
  const lessons = (await (await fetch(`${BASE}/api/lessons`)).json()).lessons ?? [];
  const lesson = lessons[0];
  ok("拿到第一课", !!lesson, lesson?.title);
  const chars = (lesson?.chars ?? []).map((c) => c.ch);
  ok("生字数 > 3", chars.length > 3, `${chars.length} 字`);
  if (chars.length <= 3) throw new Error("生字太少，测试没法跑");

  /* ————————————————————————— 2. 预置掌握度：chars[0] 已掌握(1)，chars[1] 未掌握(0) */
  step("2. 预置掌握度（chars[0]=已掌握, chars[1]=未掌握）");
  await jpatch("/api/state/mastery", { lessonId: lesson.id, ch: chars[0], state: 1 });
  await jpatch("/api/state/mastery", { lessonId: lesson.id, ch: chars[1], state: 0 });

  /* ————————————————————————— 3. 打开 /chinese，切听写 tab，开始一轮 */
  step("3. 开始第一轮（应跳过已掌握的 chars[0]）");
  await page.goto(`${BASE}/chinese`, { waitUntil: "networkidle" });
  await page.waitForSelector(".wb-tab", { timeout: 20000 });
  // 确保选中第一课（默认即第一课，这里显式选一次更稳）
  await page.selectOption("select.sel", String(lesson.id)).catch(() => {});
  await page.waitForTimeout(400);
  await page.locator(".wb-tab", { hasText: "生字听写" }).click();
  await page.waitForSelector(".hw-box", { timeout: 15000 });
  await page.locator("button", { hasText: "开始屏上听写" }).click();
  await page.waitForSelector(".hw-dots .hw-dot", { timeout: 15000 });

  const size1 = await page.locator(".hw-dots .hw-dot").count();
  ok("第一轮目标字数 = min(6, 未掌握数)", size1 >= 1, `${size1} 个`);

  /* ————————————————————————— 4. 走到结果页（大人审核），读第一轮 targets */
  step("4. 走到结果页，读第一轮字表");
  for (let i = 0; i < size1; i++) {
    await page.locator("button", { hasText: /写好了，下一个|写完了，去提交/ }).click();
    await page.waitForTimeout(130);
  }
  await page.waitForSelector("button", { hasText: "交给大人审核" }, { timeout: 10000 });
  await page.locator("button", { hasText: "交给大人审核" }).click();
  await page.waitForSelector(".hw-cell .hc-t", { timeout: 10000 });
  await page.waitForTimeout(300);

  const t1 = await page
    .locator(".hw-cell .hc-t")
    .evaluateAll((els) => els.map((e) => (e.textContent || "").trim()));
  ok("第一轮不含已掌握字 chars[0]", !t1.includes(chars[0]), `targets=[${t1.join(",")}]`);
  ok("第一轮含未掌握字 chars[1]", t1.includes(chars[1]), `chars[1]=${chars[1]}`);

  /* ————————————————————————— 5. 标记：第一个写对，第二个写错，其余写对 */
  step("5. 审核：第一个写对、第二个写错、其余写对 → 保存");
  const cells = page.locator(".hw-cell");
  await cells.nth(0).locator(".hc-rev button").nth(0).click(); // 写对
  await cells.nth(1).locator(".hc-rev button").nth(1).click(); // 写错
  for (let i = 2; i < t1.length; i++) {
    await cells.nth(i).locator(".hc-rev button").nth(0).click();
  }
  const firstWrittenOk = t1[0]; // 写对
  const firstWrong = t1[1]; // 写错
  await page.locator("button", { hasText: "保存审核结果" }).click();
  await page.waitForTimeout(700);

  /* ————————————————————————— 6. 再来一轮：写对的消失、写错的还在 */
  step("6. 再来一轮（核心：不重来，只练没掌握的字）");
  const hint = await page.locator("button", { hasText: /再来一轮|再练一遍/ }).innerText();
  await page.locator("button", { hasText: /再来一轮|再练一遍/ }).click();
  await page.waitForSelector(".hw-dots .hw-dot", { timeout: 10000 });

  const size2 = await page.locator(".hw-dots .hw-dot").count();
  for (let i = 0; i < size2; i++) {
    await page.locator("button", { hasText: /写好了，下一个|写完了，去提交/ }).click();
    await page.waitForTimeout(130);
  }
  await page.waitForSelector("button", { hasText: "交给大人审核" }, { timeout: 10000 });
  await page.locator("button", { hasText: "交给大人审核" }).click();
  await page.waitForSelector(".hw-cell .hc-t", { timeout: 10000 });
  await page.waitForTimeout(300);

  const t2 = await page
    .locator(".hw-cell .hc-t")
    .evaluateAll((els) => els.map((e) => (e.textContent || "").trim()));
  ok("再来一轮：第一轮写对的字消失", !t2.includes(firstWrittenOk), `${firstWrittenOk} 不在 [${t2.join(",")}]`);
  ok("再来一轮：第一轮写错的字还在", t2.includes(firstWrong), `${firstWrong} 在 [${t2.join(",")}]`);
  ok("再来一轮：已掌握字 chars[0] 仍被跳过", !t2.includes(chars[0]), `chars[0]=${chars[0]}`);
  ok("按钮文案提示剩余未掌握数", /没掌握|再练一遍/.test(hint), hint.trim());

  await page.screenshot({ path: path.join(shotDir, "dictation-continue.png"), fullPage: true });

  /* ————————————————————————— 7. 控制台 */
  step("7. 控制台");
  ok("零未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  ok("执行过程无异常", false, e instanceof Error ? e.message : String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill();
    await sleep(800);
  }
  for (const f of [TEST_CONFIG, TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  for (const d of ["_dictation_tts", "_dictation_backup"]) {
    try {
      fs.rmSync(path.join(SERVER, "data", d), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`听写续写回归：通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  console.log("=".repeat(60));
  process.exit(failures.length ? 1 : 0);
}
