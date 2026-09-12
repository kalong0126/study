/**
 * 「数学错题区不显示正确答案 + 直接填答案重算」端到端回归测试
 *
 * 需求：数学错题卡片上不能出现正确答案（孩子会照着抄）；
 *       重试就是题干旁边直接给一个可以填答案的输入框，填对了擦掉这题。
 *
 * 为什么用隔离实例（端口 8797 + 独立 DB）：
 *   这个测试要先在口算页**故意答错**几题来制造错题，跑在孩子的真实库上
 *   会往他的错题本里塞假数据，所以单开一份临时 DB，跑完即删。
 *
 * 覆盖点：
 *   1. 数学错题卡片上**完全看不到正确答案**（没有 .w-py、没有「正确答案」字样、
 *      卡片文字 = 题干 + 提示，一字不多）
 *   2. 输入框**直接就在**卡片上（不用先点「重新挑战」）
 *   3. 填错 → 不擦掉，输入框给红框提示
 *   4. 填对 → 这题从错题本擦掉，今日「重新挑战」计数 +1
 *   5. **门控**：口算 / 听写没做完时输入框是禁用的（否则错题数会边做边变）；
 *      两项都做完后自动开闸，分母取真实错题数
 *
 * 用法：node web/test/wrong-answer.mjs   或   cd web && npm run test:wrong
 * 依赖：playwright-core（在 workbuddy 的 node workspace 里）+ 已构建的 web/dist
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  chromium,
} = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

// 仓库根用「脚本自身位置」推，而不是 cwd —— `npm run` 时 cwd 是 web/，用 cwd 会推成 web/server
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(REPO, "server");
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.wrongview.yaml");
const TEST_DB = path.join(SERVER, "data", "_wrongview.db");
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

/* ------------------------------------------------------- 隔离实例的配置 */
const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_wrongview.db }
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
  cacheDir: ./data/_wrongview_tts
backup:
  enabled: false
  dir: ./data/_wrongview_backup
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

/* --------------------------------------------------------------- 小工具 */
/** 从题干 "7 × 8 =" 算出正确答案 */
function answerOf(text) {
  const m = /(\d+)\s*([×+\-−])\s*(\d+)/.exec(text || "");
  if (!m) return NaN;
  const a = Number(m[1]);
  const b = Number(m[3]);
  const op = m[2];
  return op === "×" ? a * b : op === "+" ? a + b : a - b;
}

/**
 * 造一个「位数相同但肯定不对」的答案。
 * 口算页只有在「输入长度 ≥ 答案长度」时才判错，所以位数必须对齐。
 */
function wrongSameLen(ansStr) {
  const nines = "9".repeat(ansStr.length);
  return nines === ansStr ? "1".repeat(ansStr.length) : nines;
}

const squash = (s) => String(s || "").replace(/\s+/g, "");

let server;
let browser;
let page;

async function gotoNav(label) {
  await page.locator("nav.nav a", { hasText: label }).first().click();
  await page.waitForTimeout(1200);
}

/** 轮询直到 fn() 返回真值，返回该真值；超时返回 null */
async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await page.waitForTimeout(120);
  }
}

/** 按题干精确定位行下标（用 === 比较，避免「7 × 8 =」误配到「17 × 8 =」） */
function rowIndexOf(q) {
  return page.evaluate((qq) => {
    const rows = [...document.querySelectorAll(".wb-item")];
    return rows.findIndex((r) => ((r.querySelector(".w-q")?.textContent ?? "").trim()) === qq);
  }, q);
}

/** 行下标 → 该行的 innerText / 输入框 */
const rowInfo = (i) =>
  page.evaluate((idx) => {
    const rows = [...document.querySelectorAll(".wb-item")];
    const r = rows[idx];
    if (!r) return null;
    const inp = r.querySelector("input.m-in");
    return {
      text: (r.innerText || "").replace(/\s+/g, ""),
      hasInput: !!inp,
      placeholder: inp ? inp.getAttribute("placeholder") : null,
      value: inp ? inp.value : null,
    };
  }, i);

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
    executablePath:
      "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  /* ————————————————————————— 0. 造错题：在口算页故意答错前 3 题 */
  step("0. 先在口算页故意答错 3 题（制造数学错题）");
  await page.goto(`${BASE}/math`, { waitUntil: "networkidle" });
  await page.waitForSelector(".m-row", { timeout: 20000 });

  const texts = await page
    .locator(".m-row .m-q")
    .evaluateAll((els) => els.map((e) => (e.textContent || "").trim()));
  ok("口算页渲染出 20 道题", texts.length === 20, `${texts.length} 题`);

  let seededCount = 0;
  for (let i = 0; i < 3; i++) {
    const ans = answerOf(texts[i]);
    if (!Number.isFinite(ans)) {
      ok(`第 ${i + 1} 题能算出答案`, false, `题干=${texts[i]}`);
      break;
    }
    const input = page.locator(".m-row").nth(i).locator("input.m-in");
    await input.fill(wrongSameLen(String(ans)));
    await input.press("Enter");
    seededCount++;
    await page.waitForTimeout(250);
  }
  ok("3 道错题都已提交", seededCount === 3, `提交 ${seededCount} 道`);

  /* ————————————————————————— 1. 错题落库，且带着答案（判分依据） */
  step("1. 错题落库：payload 里必须带答案（否则没法判分）");
  const st = await (await fetch(`${BASE}/api/state`)).json();
  const mathWrong = st.wrong?.math ?? [];
  ok("错题本里有 3 道数学题", mathWrong.length === 3, `实际 ${mathWrong.length} 道`);
  const items = mathWrong.map((it) => ({
    id: it.id,
    text: String(it.payload?.text ?? ""),
    ans: String(it.payload?.ans ?? ""),
  }));
  ok(
    "每道错题都记了正确答案",
    items.every((x) => x.ans.length > 0),
    JSON.stringify(items.map((x) => x.ans)),
  );

  /* ————————————————————————— 1b. 未开闸：错题只能看、不能改 */
  step("1b. 口算/听写没做完时禁止重做（否则错题数会边做边变）");
  await gotoNav("错题本");
  await page.waitForSelector(".wb-item", { timeout: 15000 });
  const stClosed = await (await fetch(`${BASE}/api/state`)).json();
  ok("未开闸：服务端 reviewTarget 仍是 null", stClosed.daily?.reviewTarget === null, String(stClosed.daily?.reviewTarget));
  ok("未开闸：页面上出现提示条", (await page.locator(".wb-lock").count()) === 1);
  ok("未开闸：输入框是禁用的", await page.locator(".wb-item input.m-in").first().isDisabled());

  /* ————————————————————————— 1c. 补完前置任务 → 开闸，目标 = 真实错题数 */
  step("1c. 前置任务做完后开闸，分母取真实错题数（3 道）");
  await fetch(`${BASE}/api/state/daily`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date: stClosed.date, tasks: { math: true, dictation: true } }),
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".wb-item", { timeout: 15000 });
  await page.waitForTimeout(600);
  const stOpen = await (await fetch(`${BASE}/api/state`)).json();
  ok("开闸后 reviewTarget = 3", stOpen.daily?.reviewTarget === 3, String(stOpen.daily?.reviewTarget));
  ok("开闸后提示条消失", (await page.locator(".wb-lock").count()) === 0);
  ok("开闸后输入框可用", !(await page.locator(".wb-item input.m-in").first().isDisabled()));

  /* ————————————————————————— 2. 打开错题本：答案不能出现 */
  step("2. 打开错题本 → 数学错题区看不到任何答案");
  await gotoNav("错题本");
  await page.waitForSelector(".wb-item", { timeout: 15000 });
  const rows = await page.locator(".wb-item").count();
  ok("数学 tab 下渲染出 3 张错题卡片", rows === 3, `${rows} 张`);

  ok(
    "没有任何 .w-py（旧版用来显示答案的元素）",
    (await page.locator(".wb-list .w-py").count()) === 0,
  );
  const listText = await page.locator(".wb-list").innerText();
  ok("整块区域不出现「正确答案」字样", !/正确答案/.test(listText), listText.slice(0, 80));

  // 最强的一条：卡片文字必须恰好等于「题干 + 再算一次」，多一个字符都说明混进了别的东西
  let extraLeak = "";
  for (const it of items) {
    const i = await rowIndexOf(it.text);
    if (i < 0) {
      extraLeak = `找不到题干「${it.text}」的卡片`;
      break;
    }
    const info = await rowInfo(i);
    const expect = squash(it.text + "再算一次");
    if (info.text !== expect) extraLeak = `题干「${it.text}」→ 卡片文字「${info.text}」，期望「${expect}」`;
  }
  ok("卡片文字 = 题干 + 提示，一个多余字符都没有", extraLeak === "", extraLeak);

  // 留一张截图当证据（肉眼确认版式：卡片上只有题干 + 输入框，没有任何答案）
  const shotDir = path.join(REPO, "web", "test", "shots");
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, "wrong-math.png"), fullPage: true });
  console.log("  截图：web/test/shots/wrong-math.png");

  /* ————————————————————————— 3. 输入框直接可用 */
  step("3. 输入框直接就在卡片上（不用先点「重新挑战」）");
  const inputCount = await page.locator(".wb-item .wb-ans input.m-in").count();
  ok("每张卡片都有一个输入框", inputCount === 3, `${inputCount} 个`);
  ok("页面上没有「重新挑战」按钮（数学不需要先点一下）", (await page.locator(".wb-item button", { hasText: "重新挑战" }).count()) === 0);
  const first = items[0];
  const i0 = await rowIndexOf(first.text);
  const info0 = await rowInfo(i0);
  ok("第一个输入框可见、且是空的", info0.hasInput && info0.value === "" && info0.placeholder === "?", JSON.stringify(info0));

  /* ————————————————————————— 4. 填错不通过 */
  step("4. 填错 → 不擦掉，给红框提示");
  const tInput = page.locator(".wb-item").nth(i0).locator("input.m-in");
  await tInput.fill(wrongSameLen(first.ans));
  await tInput.press("Enter");
  const badSeen = await waitFor(() => tInput.evaluate((el) => el.classList.contains("bad")), 1500);
  ok("算错时输入框出现红框提示（.bad）", badSeen !== null);
  await page.waitForTimeout(600);
  ok("算错后这道题仍在错题本里", (await rowIndexOf(first.text)) >= 0, "卡片没被误删");

  /* ————————————————————————— 5. 填对才擦掉 */
  step("5. 填对 → 这道题从错题本擦掉，计数 +1");
  const reviewBefore = st.daily?.reviewCount ?? 0;
  await tInput.fill(first.ans);
  const gone = await waitFor(async () => (await rowIndexOf(first.text)) < 0, 8000);
  ok("填对后这道题从列表消失", gone === true);
  const rowsAfter = await page.locator(".wb-item").count();
  ok("剩余 2 道错题", rowsAfter === 2, `${rowsAfter} 道`);

  const st2 = await (await fetch(`${BASE}/api/state`)).json();
  ok("服务端也擦掉了（只剩 2 道）", (st2.wrong?.math ?? []).length === 2, `${(st2.wrong?.math ?? []).length} 道`);
  ok(
    "今日「重新挑战」计数 +1",
    (st2.daily?.reviewCount ?? 0) === reviewBefore + 1,
    `${reviewBefore} → ${st2.daily?.reviewCount}`,
  );
  const listText2 = await page.locator(".wb-list").innerText();
  ok("擦掉后剩下的卡片依然不泄露答案", !/正确答案/.test(listText2));

  /* ————————————————————————— 6. 控制台 */
  step("6. 控制台");
  ok("零 console error / 零未捕获异常", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
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
  for (const d of ["_wrongview_tts", "_wrongview_backup"]) {
    try {
      fs.rmSync(path.join(SERVER, "data", d), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`错题区不泄答案回归：通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  console.log("=".repeat(60));
  process.exit(failures.length ? 1 : 0);
}
