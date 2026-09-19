/**
 * 童话页「今日童话 + 滚动阅读」回归（真实浏览器 + 隔离实例 + mock 大模型）
 *
 * 这一版守的是孩子端真正会走的路径，全部用真实浏览器、真实接口，不读源码断言：
 *   ① **进来就自动生成今日童话**：不点任何按钮，正文自己出来（mock 出一篇长童话）。
 *   ② **当天幂等**：刷新一次不会生成第二篇（mock 的调用次数不增加），
 *      页面拿到的还是同一篇 —— 这是「重复今天只取今天已生成的故事内容」。
 *   ③ **倒计时自动开启**，并且和「换一篇童话」按钮**在同一行**（用户明确要求）。
 *   ④ **试读示例故事已经去掉**（按钮与样例文本都不该再出现）。
 *   ⑤ **滚动阅读**：正文容器 overflow-y: auto、内容比容器高、真的能滚到下一屏；
 *      高度仍是 5 行（平板上一屏 5 行刚刚好），并且**不再有翻页条**。
 *   ⑥ 正文用站内圆体（方正准圆简体），跟其它页面一致。
 *
 * 为什么用 mock 大模型：真实接口不稳定也没法断言素材长度。mock 的 `longstory`
 * 模式专门回一篇 8 段的长童话，一屏 5 行装不下，滚动才有东西可测。
 *
 * 用法：node web/test/story-scroll.mjs   或   cd web && npm run test:story
 * 端口：8806（应用）+ 8807（mock），隔离实例禁并行，见 .workbuddy/memory/MEMORY.md
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
const PORT = 8806;
const MOCK_PORT = 8807;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.storyscroll.yaml");
const TEST_DB = path.join(SERVER, "data", "_storyscroll.db");
const TEST_TTS = path.join(SERVER, "data", "_storyscroll_tts");
const NODE = "C:/Users/kalon/.workbuddy/binaries/node/versions/22.22.2-3/node.exe";
const SHOTS = path.join(REPO, "web", "test", "shots", "story");
fs.mkdirSync(SHOTS, { recursive: true });

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
  sqlite: { file: ./data/_storyscroll.db }
llm:
  baseUrl: http://127.0.0.1:${MOCK_PORT}/v1
  apiKey: sk-test-mock-key
  storyBaseUrl: http://127.0.0.1:${MOCK_PORT}/v1
  markBaseUrl: http://127.0.0.1:${MOCK_PORT}/v1
  storyModel: mock-story
  markModel: mock-vision
  suggestModel: mock-story
  timeoutMs: { story: 8000, mark: 8000, suggest: 8000 }
  retries: 0
  temperature: { story: 0.9, mark: 0, suggest: 0.5 }
tts:
  provider: edge
  voice: zh-CN-XiaoyiNeural
  rate: "-12%"
  cacheDir: ./data/_storyscroll_tts
backup:
  enabled: false
  dir: ./data/_storyscroll_backup
`;

let server;
let mock;
let browser;

async function waitHealthy(url, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(600);
  }
  return false;
}

/**
 * 解锁到「童话」这一关为止（顺序锁：故事树是链上的第 3 关）。
 *
 * ⚠️ 只置到 reading 之前的三项，**故意不把 reading 置为完成** ——
 * 「阅读已完成就不该再自动开倒计时」是产品行为（见 StoryView.onMounted），
 * 这里如果全置成完成，那条断言就永远测不到真实状态了。
 */
async function unlockStory() {
  try {
    await fetch(`${BASE}/api/state/daily`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tasks: { math: true, dictation: true, review: true } }),
    });
  } catch {
    /* 后面 waitForSelector 会暴露问题 */
  }
}

/** 直接改今日打卡状态（用来验证「阅读已完成 → 不再自动开倒计时」） */
async function markDone(key) {
  await fetch(`${BASE}/api/state/daily`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks: { [key]: true } }),
  });
}

/** mock 被调了几次 —— 用来断言「刷新不会再生成一篇」 */
async function mockCalls() {
  const r = await fetch(`${MOCK}/__calls`);
  return (await r.json()).count;
}

function cleanup() {
  for (const f of [TEST_CONFIG, TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* 被占用就算了 */
    }
  }
  for (const d of [TEST_TTS, path.join(SERVER, "data", "_storyscroll_backup")]) {
    try {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 同上 */
    }
  }
}

try {
  console.log(`\n=== 准备隔离实例（应用 ${PORT} / mock ${MOCK_PORT}，独立 DB）===`);
  fs.writeFileSync(TEST_CONFIG, TEST_CONFIG_YAML, "utf8");
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);

  mock = spawn(NODE, ["node_modules/tsx/dist/cli.mjs", "test/mock-llm.ts"], {
    cwd: SERVER,
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const mockUp = await waitHealthy(`${MOCK}/__calls`, 40000);
  ok("mock 大模型已就绪", mockUp);
  if (!mockUp) throw new Error("mock 没起来");
  // 让它回一篇长童话（8 段）：一屏 5 行装不下，滚动才有东西可测
  await fetch(`${MOCK}/__mode`, { method: "POST", body: JSON.stringify({ mode: "longstory" }) });

  server = spawn(NODE, ["node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
    cwd: SERVER,
    env: { ...process.env, CONFIG_PATH: TEST_CONFIG, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const healthy = await waitHealthy(`${BASE}/api/health`);
  ok("隔离实例已就绪", healthy);
  if (!healthy) throw new Error("实例没起来，看 server/logs/app-*.log");

  browser = await chromium.launch({
    executablePath: "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    args: ["--no-sandbox"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  /** 量正文窗口 + 顶栏那一行：几何全从真实渲染拿 */
  const probe = () =>
    page.evaluate(() => {
      const view = document.querySelector(".story-scroll");
      const bar = document.querySelector(".story-bar");
      const chip = document.querySelector(".timer-chip");
      const btn = [...document.querySelectorAll(".story-bar .btn")].find((b) => b.textContent.includes("童话"));
      if (!view) return null;
      const cs = getComputedStyle(view);
      const vr = view.getBoundingClientRect();
      const rect = (el) => (el ? el.getBoundingClientRect() : null);
      const cr = rect(chip);
      const br = rect(btn);
      // 每个句子的**行片段**：一个句子换行会有好几段，数「显示了几行」只能用片段
      const frags = [...view.querySelectorAll(".sent")].flatMap((el) =>
        [...el.getClientRects()].map((r) => ({ top: r.top - vr.top, bottom: r.bottom - vr.top })),
      );
      return {
        clientH: view.clientHeight,
        scrollH: view.scrollHeight,
        scrollTop: view.scrollTop,
        lineH: parseFloat(cs.lineHeight),
        lines: parseInt(cs.getPropertyValue("--story-lines"), 10),
        overflowY: cs.overflowY,
        fontFamily: cs.fontFamily,
        fontSize: parseFloat(cs.fontSize),
        count: [...view.querySelectorAll(".sent")].length,
        frags,
        title: document.querySelector(".story-title")?.textContent?.trim() ?? "",
        text: (view.innerText || "").replace(/\s+/g, "").slice(0, 400),
        clock: document.querySelector(".timer-clock")?.textContent?.trim() ?? "",
        clockRun: !!document.querySelector(".timer-clock.run"),
        hasChip: !!chip,
        chipTop: cr ? Math.round(cr.top) : null,
        chipBottom: cr ? Math.round(cr.bottom) : null,
        btnTop: br ? Math.round(br.top) : null,
        btnBottom: br ? Math.round(br.bottom) : null,
        barH: bar ? Math.round(bar.getBoundingClientRect().height) : null,
        hasPager: !!document.querySelector(".story-pager"),
        sampleBtn: [...document.querySelectorAll("button")].some((b) => /试读|示例故事/.test(b.textContent)),
        bodyText: document.body.innerText || "",
      };
    });

  /** 一屏显示了几行（用行片段数，忽略完全在窗口下方的那部分） */
  const rowsOf = (m) =>
    new Set(m.frags.filter((f) => f.top < m.clientH - 1).map((f) => Math.round(f.top / 4))).size;

  // ————————————————————————————————————— 1. 进来就自动生成
  step("1. 一进 /story 就自动生成今日童话（不点任何按钮）");
  await unlockStory();
  await page.goto(`${BASE}/story`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".story-scroll .sent", { timeout: 30000 });
  await page.waitForTimeout(1200); // 等字体就位

  const before = await probe();
  ok("正文自己出来了（没点生成按钮）", !!before && before.count > 0, `句子数 ${before?.count}`);
  ok("标题是 mock 给的那一篇", before.title.includes("会飞的棉被"), before.title);
  ok("生成后 mock 被调用了一次", (await mockCalls()) === 1, `calls=${await mockCalls()}`);

  // ————————————————————————————————————— 2. 当天幂等
  step("2. 刷新页面：取当天已生成的那一篇，不重复生成");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".story-scroll .sent", { timeout: 30000 });
  await page.waitForTimeout(1200);
  const again = await probe();
  const calls = await mockCalls();
  ok("刷新后仍然有正文", again.count > 0, `句子数 ${again.count}`);
  ok("正文与刷新前是同一篇", again.text.slice(0, 60) === before.text.slice(0, 60), again.text.slice(0, 40));
  ok("刷新没有再调模型（当天只生成一次）", calls === 1, `calls=${calls}`);
  ok("当天已有童话时也没有报错文案", !/上次生成失败/.test(again.bodyText));

  // ————————————————————————————————————— 3. 倒计时自动开启 + 同一行
  step("3. 倒计时自动开启，并与生成按钮在同一行");
  ok("倒计时在走（有 .timer-clock 且带 run）", again.clockRun && /^\d\d:\d\d$/.test(again.clock), `clock=${again.clock}`);
  ok("倒计时不是停在起点（确实开始跑了）", again.clock !== "15:00", `clock=${again.clock}`);
  ok("倒计时胶囊与「换一篇童话」按钮在同一行（竖直方向重叠）",
    again.hasChip && again.chipBottom > again.btnTop && again.btnBottom > again.chipTop,
    `chip ${again.chipTop}–${again.chipBottom} / btn ${again.btnTop}–${again.btnBottom}`);
  ok("这一行里也确实装着「换一篇童话」按钮", again.btnTop !== null);

  // 阅读任务已经完成的那一天，不该再自动开一轮倒计时（白等 15 分钟没有意义）。
  // 先把正在走的那一轮停掉，再重载 —— 否则看到的还是上一轮（计时状态是存在后端的）。
  await markDone("reading");
  await fetch(`${BASE}/api/state/timer`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ running: false, endAt: 0 }),
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".story-scroll .sent", { timeout: 30000 });
  await page.waitForTimeout(1000);
  const doneDay = await probe();
  ok("阅读已完成 → 不再自动开倒计时", !doneDay.clockRun, `clock=${doneDay.clock} run=${doneDay.clockRun}`);
  ok("阅读已完成 → 也不再给「开启计时」按钮", !/开启\s*15\s*分钟计时/.test(doneDay.bodyText));
  ok("阅读已完成但童话正文还看得到", doneDay.count > 0, `句子数 ${doneDay.count}`);

  // ————————————————————————————————————— 4. 试读示例已移除
  step("4. 试读示例故事已经去掉");
  ok("页面上没有「试读示例故事」按钮", !again.sampleBtn);
  ok("正文里没有示例故事（小水珠 / 爱笑的铅笔）", !/小水珠的旅行|爱笑的铅笔/.test(again.bodyText));

  // ————————————————————————————————————— 5. 滚动阅读
  step("5. 正文是滚动阅读（不是翻页）");
  ok("容器 overflow-y 是 auto（可滚）", again.overflowY === "auto", again.overflowY);
  ok("内容比容器高（需要滚动）", again.scrollH > again.clientH, `${again.scrollH} vs ${again.clientH}`);
  ok("高度仍是 5 行（平板上一屏 5 行）", Math.abs(again.clientH - 5 * again.lineH) <= 3,
    `clientHeight=${again.clientH} 行高=${again.lineH} 5行=${5 * again.lineH}`);
  ok("不再有翻页条", !again.hasPager);
  ok("首屏显示 5 行", rowsOf(again) === 5, `${rowsOf(again)} 行`);

  // 真的滚一下：滚到底部，第一屏的内容应该被滚出去
  await page.evaluate(() => {
    const v = document.querySelector(".story-scroll");
    v.scrollTop = v.scrollHeight;
  });
  await page.waitForTimeout(400);
  const scrolled = await probe();
  ok("能滚下去（scrollTop 变大了）", scrolled.scrollTop > 0, `scrollTop=${scrolled.scrollTop}`);
  ok("滚到底后内容确实换了（不是滚不动）", scrolled.scrollTop > again.clientH * 0.5, `scrollTop=${scrolled.scrollTop}`);
  await page.screenshot({ path: path.join(SHOTS, "scroll-bottom.png"), fullPage: true });

  await page.evaluate(() => {
    const v = document.querySelector(".story-scroll");
    v.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "scroll-top.png"), fullPage: true });

  // ————————————————————————————————————— 6. 字体统一
  step("6. 正文用站内圆体（与其它页面一致）");
  ok(
    "正文首字体是方正准圆简体",
    /方正准圆简体/.test(again.fontFamily) && again.fontFamily.replace(/["']/g, "").trim().startsWith("方正准圆简体"),
    again.fontFamily.slice(0, 80),
  );
  ok("正文不再使用楷体", !/Kaiti|KaiTi|STKaiti|楷体/i.test(again.fontFamily), again.fontFamily.slice(0, 120));

  // ————————————————————————————————————— 7. 窄屏（手机）
  step("7. 窄屏仍然是 5 行 + 可滚");
  await page.setViewportSize({ width: 420, height: 780 });
  await page.waitForTimeout(900);
  const narrow = await probe();
  ok("窄屏行高按断点变小（24px × 2.6）", Math.abs(narrow.lineH - 24 * 2.6) < 1, `行高 ${narrow.lineH}（宽屏 ${again.lineH}）`);
  ok("窄屏容器仍是 5 行", Math.abs(narrow.clientH - 5 * narrow.lineH) <= 3, `clientHeight=${narrow.clientH}`);
  ok("窄屏仍能滚", narrow.scrollH > narrow.clientH, `${narrow.scrollH} vs ${narrow.clientH}`);
  ok("窄屏没有翻页条", !narrow.hasPager);
  await page.screenshot({ path: path.join(SHOTS, "scroll-narrow.png"), fullPage: true });
} catch (e) {
  failures.push(`异常中止：${e.message}`);
  console.error("\n异常：", e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const p of [server, mock]) {
    if (!p) continue;
    p.kill();
    await sleep(400);
    try {
      spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* 已经退出了 */
    }
  }
  await sleep(300);
  cleanup();
  console.log(`\n=== 童话页回归 ${pass} / ${pass + failures.length} ===`);
  if (failures.length) {
    console.log("失败：");
    for (const f of failures) console.log("  ✗ " + f);
    process.exitCode = 1;
  } else {
    console.log("全部通过 ✓");
  }
}
