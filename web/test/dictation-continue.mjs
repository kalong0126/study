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
 * 2026-09-19 再改（用户要求「不交大模型判卷了，做成一轮全部写完，然后交由大人审核」）：
 *   · 一轮＝这一轮要练的**全部**字，不再按 `ROUND_SIZE = 6` 切片（切轮本就是为迁就
 *     多模态判卷「一次最多 6 格」）；
 *   · 写到最后一个字点「全部写完了，交给大人」→ **直接进审核页**，
 *     中间的「待提交」确认页已删，所以本测试不再点「交给大人审核」。
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
  await page.waitForSelector(".seg-btn", { timeout: 20000 });
  // 确保选中第一课（默认即第一课，这里显式选一次更稳）
  await page.selectOption("select.sel", String(lesson.id)).catch(() => {});
  await page.waitForTimeout(400);
  await page.locator(".seg-btn", { hasText: "生字听写" }).click();
  // 听写板默认隐藏：工具栏上的「开始听写」是唯一入口，点它直接进书写阶段（没有中间落地页）
  await page.waitForSelector(".zi-strip .zi", { timeout: 15000 });
  await page.locator(".pt button", { hasText: "开始听写" }).click();
  await page.waitForSelector(".hw-box", { timeout: 15000 });
  await page.waitForSelector(".hw-dots .hw-dot", { timeout: 15000 });

  const mask = await page.locator(".zi-strip").evaluate((el) => ({
    masked: el.classList.contains("masked"),
    charVisibility: getComputedStyle(el.querySelector(".zi-char")).visibility,
  }));
  ok("听写中生字条遮上（.zi-strip.masked，字与拼音隐藏）", mask.masked && mask.charVisibility === "hidden", JSON.stringify(mask));

  const size1 = await page.locator(".hw-dots .hw-dot").count();
  ok(
    "第一轮＝全部未掌握生字（不再按 6 个切片）",
    size1 === chars.length - 1,
    `本轮 ${size1} 个 / 整课 ${chars.length} 个（chars[0] 已掌握）`,
  );

  /* ————————————————————————— 4. 写完最后一个字 → 直接进审核页，读第一轮 targets */
  step("4. 写完最后一个字 → 直接进大人审核页，读第一轮字表");
  for (let i = 0; i < size1; i++) {
    await page.locator("button", { hasText: /写好了，下一个|全部写完了，交给大人/ }).click();
    await page.waitForTimeout(130);
  }
  // 没有中间「待提交」页：最后一击直接落到审核页
  await page.waitForSelector(".hw-cell .hc-t", { timeout: 10000 });
  await page.waitForTimeout(300);
  ok(
    "写完最后一个字直接进审核页（无中间提交页）",
    (await page.locator("button", { hasText: "保存审核结果" }).count()) > 0,
  );

  // 这个测试从不落笔，所以每个格子都该是「（空着）」+ 一个「去补写」入口
  const emptyCells = await page.locator(".hw-cell .hc-w").count();
  const refillBtns = await page.locator(".hw-cell button", { hasText: "去补写" }).count();
  ok(
    "没写的字标「（空着）」并给「去补写」",
    emptyCells === size1 && refillBtns === size1,
    `${emptyCells} 个空 / ${refillBtns} 个补写按钮`,
  );

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
  ok("第二轮也一次写完全部未掌握字", size2 >= 1 && size2 < size1, `第二轮 ${size2} 个（第一轮 ${size1} 个）`);
  for (let i = 0; i < size2; i++) {
    await page.locator("button", { hasText: /写好了，下一个|全部写完了，交给大人/ }).click();
    await page.waitForTimeout(130);
  }
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

  /* ————————————————————————— 7. 结束听写 → 面板收起、生字条恢复 */
  step("7. 结束听写 → 面板收起、生字条恢复显示");
  await page.locator(".pt button", { hasText: "结束听写" }).click();
  await page.waitForTimeout(600);
  ok("屏上听写面板收起（.hw-box 消失）", (await page.locator(".hw-box").count()) === 0);
  ok(
    "生字条恢复显示（.masked 已摘掉）",
    await page.locator(".zi-strip").evaluate((el) => !el.classList.contains("masked")),
  );

  /* ————————————————————————— 8. 控制台 */
  step("8. 控制台");
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
