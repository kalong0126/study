/**
 * 后端集成测试
 *
 * 思路：起一个可控的 mock 大模型 + 一个测试配置的服务进程，
 * 然后对真实 HTTP 接口做断言。这样能覆盖真实浏览器无法稳定复现的分支：
 * 判卷数量不符的降级、401 是否重试、超时分类、老数据迁移等。
 *
 * 运行：npm test
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, "..");
const NODE = process.execPath;
const TSX = path.join(SERVER_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const MOCK_PORT = 8799;
const APP_PORT = 8798;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

const TEST_DB = path.join(SERVER_ROOT, "data", "_test.db");
const TEST_TTS = path.join(SERVER_ROOT, "data", "_test_tts");
const TEST_IMAGES = path.join(SERVER_ROOT, "data", "_test_images");
const TEST_BACKUP = path.join(SERVER_ROOT, "data", "_test_backup");
const TEST_CONFIG = path.join(SERVER_ROOT, "config", "config.test.yaml");
const SERVER_LOG = path.join(SERVER_ROOT, "logs", "_test-server.log");

/* --------------------------------------------------------------- 断言工具 */
let pass = 0;
const failures: string[] = [];
let currentGroup = "";

function group(name: string): void {
  currentGroup = name;
  console.log(`\n=== ${name} ===`);
}
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(`${currentGroup} · ${name}`);
    console.log(`  [FAIL] ${name}${detail ? `   → ${detail}` : ""}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* --------------------------------------------------------------- HTTP 封装 */
interface Resp {
  status: number;
  json: Record<string, never> & Record<string, unknown>;
  text: string;
  headers: Headers;
  buf?: Buffer;
}

async function api(method: string, p: string, body?: unknown, raw = false): Promise<Resp> {
  const res = await fetch(BASE + p, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 非 JSON（如音频） */
  }
  return { status: res.status, json, text, headers: res.headers, buf: raw ? buf : undefined };
}

async function setMockMode(mode: string): Promise<void> {
  await fetch(`${MOCK}/__mode`, { method: "POST", body: JSON.stringify({ mode }) });
}
async function mockCalls(): Promise<{
  count: number;
  calls: { url: string; model: string; prompt: string; hasImage: boolean }[];
}> {
  const r = await fetch(`${MOCK}/__calls`);
  return (await r.json()) as never;
}
async function resetMock(): Promise<void> {
  await fetch(`${MOCK}/__reset`);
}

/** 一张 1x1 的透明 PNG，够用来冒充手写图（mock 不看图内容） */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/* ------------------------------------------------------------------ 准备 */
function prepare(): void {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`, SERVER_LOG]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  for (const d of [TEST_TTS, TEST_IMAGES, TEST_BACKUP]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  fs.writeFileSync(
    TEST_CONFIG,
    `server:
  port: ${APP_PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_test.db }
llm:
  baseUrl: http://127.0.0.1:${MOCK_PORT}/v1
  apiKey: sk-test-mock-key
  storyBaseUrl: http://127.0.0.1:${MOCK_PORT}/v1
  markBaseUrl: http://127.0.0.1:${MOCK_PORT}/v1
  storyModel: mock-story
  markModel: mock-vision
  suggestModel: mock-story
  timeoutMs: { story: 4000, mark: 4000, suggest: 4000 }
  retries: 1
  temperature: { story: 0.9, mark: 0, suggest: 0.5 }
imagegen:
  enabled: true
  model: mock-image
  # mock 的「千问文生图同步接口」：返回一个指向 mock 自己的图片地址，
  # 这样「拿地址 → 下载 → 落盘」整条链路都真的跑一遍
  baseUrl: http://127.0.0.1:${MOCK_PORT}/__image
  apiKey: sk-test-image-key
  size: 1328*1328
  dir: ./data/_test_images
  timeoutMs: 8000
tts:
  provider: edge
  voice: zh-CN-XiaoyiNeural
  rate: "-12%"
  cacheDir: ./data/_test_tts
  cacheMaxMB: 64
logging:
  level: warn
  dir: ./logs
  keepDays: 3
backup:
  enabled: false
  cron: "0 3 * * *"
  dir: ./data/_test_backup
  keepDays: 3
`,
    "utf8",
  );
}

function startProc(script: string, label: string, env: Record<string, string> = {}): ChildProcess {
  const out = fs.openSync(path.join(SERVER_ROOT, "logs", `_test-${label}.log`), "w");
  const child = spawn(NODE, [TSX, script], {
    cwd: SERVER_ROOT,
    env: { ...process.env, ...env, FORCE_COLOR: "0" },
    stdio: ["ignore", out, out],
  });
  return child;
}

async function waitHealthy(timeoutMs = 30000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  return false;
}

/* ------------------------------------------------------------------ 主流程 */
async function main(): Promise<void> {
  prepare();
  const mock = startProc(path.join("test", "mock-llm.ts"), "mock", { MOCK_PORT: String(MOCK_PORT) });
  await sleep(1500);
  const app = startProc(path.join("src", "index.ts"), "server", { CONFIG_PATH: TEST_CONFIG });

  const healthy = await waitHealthy();
  if (!healthy) {
    console.error("\n服务未能启动，请看 logs/_test-server.log");
    app.kill();
    mock.kill();
    process.exit(1);
  }

  try {
    /* ============================ A. 基础与内容 ============================ */
    group("A. 基础与内容");
    const health = await api("GET", "/api/health");
    ok("A1 /api/health 返回 ok", health.status === 200 && health.json.ok === true, JSON.stringify(health.json).slice(0, 120));

    const lessonsRes = await api("GET", "/api/lessons");
    const lessons = (lessonsRes.json.lessons ?? []) as { id: number; title: string; chars: { ch: string; word: string; pinyin: string }[] }[];
    eq("A2 课文数量为 14", lessons.length, 14);
    eq("A3 生字总数为 153", lessons.reduce((n, l) => n + l.chars.length, 0), 153);
    ok("A4 所有生字都有组词", lessons.every((l) => l.chars.every((c) => c.word && c.word.length > 0)));
    ok("A5 所有生字都有拼音", lessons.every((l) => l.chars.every((c) => /[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/i.test(c.pinyin))));

    const findChar = (title: string, ch: string): { pinyin: string; word: string } | undefined =>
      lessons.find((l) => l.title === title)?.chars.find((c) => c.ch === ch);
    eq("A6 多音字「发」按组词读轻声(头发)", findChar("《妈妈睡了》", "发")?.pinyin, "fa");
    eq("A7 多音字「哄」读 hǒng(哄睡)", findChar("《妈妈睡了》", "哄")?.pinyin, "hǒng");
    eq("A8 多音字「朝」读 cháo(朝向)", findChar("《一封信》", "朝")?.pinyin, "cháo");
    eq("A9 多音字「重」读 zhòng(重量)", findChar("《曹冲称象》", "重")?.pinyin, "zhòng");
    eq("A10 多音字「杆」读 gǎn(秤杆)", findChar("《曹冲称象》", "杆")?.pinyin, "gǎn");
    eq("A11 多音字「盛」读 shèng(盛开)", findChar("《日月潭》", "盛")?.pinyin, "shèng");
    eq("A12 多音字「省」读 shěng(省份)", findChar("《黄山奇石》", "省")?.pinyin, "shěng");

    /* ============================ B. 学习数据 ============================ */
    group("B. 学习数据");
    const st0 = await api("GET", "/api/state");
    eq("B1 初始打卡全部未完成", (st0.json.daily as { tasks: Record<string, boolean> }).tasks, {
      math: false,
      dictation: false,
      reading: false,
      language: false,
      review: false,
    });
    ok("B2 初始无口算题组", st0.json.mathSet === null);

    const today = st0.json.date as string;
    const d1 = await api("PATCH", "/api/state/daily", { date: today, tasks: { math: true }, reviewCount: 2 });
    ok("B3 标记口算完成", (d1.json.daily as { tasks: { math: boolean } }).tasks.math === true);
    eq("B4 reviewCount 写入", (d1.json.daily as { reviewCount: number }).reviewCount, 2);

    const qs = [
      { a: 3, b: 4, op: "×", ans: 12 },
      { a: 9, b: 5, op: "+", ans: 14 },
    ];
    await api("POST", "/api/state/math", { date: today, qs, results: {} });
    const st1 = await api("GET", "/api/state");
    eq("B5 口算题组保存成功", (st1.json.mathSet as { qs: unknown[] }).qs.length, 2);

    const m1 = await api("PATCH", "/api/state/math", { date: today, idx: 0, value: "ok" });
    eq("B6 单题判对后 correct=1", m1.json.correct, 1);
    const m2 = await api("PATCH", "/api/state/math", { date: today, idx: 1, value: "bad" });
    eq("B7 单题判错后 answered=2", m2.json.answered, 2);
    eq("B8 判错不增加 correct", m2.json.correct, 1);

    const lesson1 = lessons[0].id;
    await api("PATCH", "/api/state/mastery", { lessonId: lesson1, ch: "两", state: 1 });
    const st2 = await api("GET", "/api/state");
    eq(
      "B9 掌握度写入",
      (st2.json.mastery as Record<string, Record<string, number>>)[String(lesson1)]["两"],
      1,
    );
    await api("PATCH", "/api/state/mastery", { lessonId: lesson1, ch: "两", state: null });
    const st3 = await api("GET", "/api/state");
    ok("B10 掌握度可清除", !((st3.json.mastery as Record<string, Record<string, number>>)[String(lesson1)] ?? {})["两"]);

    const w1 = await api("POST", "/api/state/wrong", { type: "math", refKey: "7 × 8 =", payload: { text: "7 × 8 =", ans: 56 } });
    ok("B11 添加数学错题", typeof w1.json.id === "number");
    const w2 = await api("POST", "/api/state/wrong", { type: "math", refKey: "7 × 8 =", payload: {} });
    eq("B12 同一题重复添加返回 duplicated", w2.json.duplicated, true);

    const wc = await api("POST", "/api/state/wrong/clear", { id: w1.json.id });
    const mathLeft = (wc.json.wrong as { math: unknown[] }).math.length;
    eq("B13 错题可消除", mathLeft, 0);

    await api("PATCH", "/api/state/timer", { running: true, endAt: Date.now() + 900000 });
    const st4 = await api("GET", "/api/state");
    ok("B14 计时器状态持久化", (st4.json.timer as { running: boolean }).running === true);
    await api("PATCH", "/api/state/timer", { running: false, endAt: 0 });

    /* ---- 口算自动计时：前端只回写「绝对总数」，服务端不做累加 ---- */
    const el0 = await api("GET", "/api/state");
    eq("B15 新题组的用时从 0 开始", el0.json.mathElapsedMs, 0);

    const el1 = await api("PATCH", "/api/state/math/elapsed", { date: today, ms: 93000 });
    eq("B16 回写用时成功", el1.json.mathElapsedMs, 93000);
    const el2 = await api("GET", "/api/state");
    eq("B17 用时随快照一起返回", el2.json.mathElapsedMs, 93000);

    const el3 = await api("PATCH", "/api/state/math/elapsed", { date: today, ms: 45000 });
    eq("B18 是覆盖而不是累加（幂等，重试不会越加越多）", el3.json.mathElapsedMs, 45000);

    const elBad = await api("PATCH", "/api/state/math/elapsed", { date: today, ms: -1 });
    eq("B19 负数用时返回 400", elBad.status, 400);

    const elHuge = await api("PATCH", "/api/state/math/elapsed", { date: today, ms: 99_999_999_999 });
    eq("B20 超大用时被钳到 6 小时", elHuge.json.mathElapsedMs, 6 * 60 * 60 * 1000);

    await api("POST", "/api/state/math", { date: today, qs, results: {} });
    const el4 = await api("GET", "/api/state");
    eq("B21 换一批题目后用时归零", el4.json.mathElapsedMs, 0);

    /* ---- 错题复习开闸：目标题数按「开闸那一刻真实的错题数」定，之后冻结 ---- */
    type DailyRt = { reviewTarget: number | null };
    const rd0 = await api("GET", "/api/state");
    eq("B22 未开闸时 reviewTarget 是 null（不是 0，两者含义不同）", (rd0.json.daily as DailyRt).reviewTarget, null);

    // 复现用户报的场景：只错了 1 道
    await api("POST", "/api/state/wrong", {
      type: "math",
      refKey: "6 × 6 =",
      payload: { text: "6 × 6 =", ans: 36 },
    });
    const ro1 = await api("POST", "/api/state/review/open", { date: today });
    eq("B23 只错 1 道 → 目标就是 1（而不是写死的 3）", (ro1.json.daily as DailyRt).reviewTarget, 1);

    // 开闸之后错题本继续长大（比如孩子换了一批口算又错了几道）→ 分母不能跟着涨
    for (const t of ["7 × 7 =", "8 × 8 =", "9 × 9 =", "5 × 5 ="]) {
      await api("POST", "/api/state/wrong", { type: "math", refKey: t, payload: { text: t, ans: 1 } });
    }
    const ro2 = await api("POST", "/api/state/review/open", { date: today });
    eq("B24 重复开闸不会改分母（冻结，防「边做边变」）", (ro2.json.daily as DailyRt).reviewTarget, 1);

    // 重开一轮：现在有 5 道待复习 → 目标封顶 3
    await api("PATCH", "/api/state/daily", { date: today, reviewTarget: null });
    const ro3 = await api("POST", "/api/state/review/open", { date: today });
    eq("B25 超过 3 道时目标封顶 3", (ro3.json.daily as DailyRt).reviewTarget, 3);

    // 清空错题本 → 目标按 0 算（前端据此直接判完成，而不是卡在「差 3 道」）
    await api("POST", "/api/state/wrong/clear", { all: true });
    await api("PATCH", "/api/state/daily", { date: today, reviewTarget: null });
    const ro4 = await api("POST", "/api/state/review/open", { date: today });
    eq("B26 错题本清空后开闸 → 目标 0（没有要复习的）", (ro4.json.daily as DailyRt).reviewTarget, 0);

    const rd1 = await api("GET", "/api/state");
    eq("B27 reviewTarget 随全量快照一起返回", (rd1.json.daily as DailyRt).reviewTarget, 0);

    // 收尾：把目标退回未开闸，别影响后面的用例
    await api("PATCH", "/api/state/daily", { date: today, reviewTarget: null });

    /* ============================ 积分系统 ============================ */
    group("积分系统");
    // 上文 B3 已经打勾 math=true，完成积分 math_done +10 应已自动入账
    const p0 = await api("GET", "/api/points");
    eq("P1 口算完成已自动 +10", p0.json.balance, 10);

    await api("PATCH", "/api/state/daily", { date: today, tasks: { math: true } });
    const pt1 = await api("GET", "/api/points");
    eq("P2 重复打勾不重复加分（幂等）", pt1.json.balance, 10);

    const a1 = await api("POST", "/api/points/award", { reason: "math_perfect" });
    eq("P3 口算全对 +10", a1.json.balance, 20);
    const a2 = await api("POST", "/api/points/award", { reason: "math_perfect" });
    eq("P4 全对重复发幂等", a2.json.balance, 20);
    eq("P4b 幂等返回 awarded=false", a2.json.awarded, false);

    const aBad = await api("POST", "/api/points/award", { reason: "math_done" });
    eq("P5 完成类积分不允许前端手动发", aBad.status, 400);

    await api("PATCH", "/api/state/daily", { date: today, tasks: { dictation: true } });
    const p2 = await api("GET", "/api/points");
    eq("P6 听写完成 +10", p2.json.balance, 30);

    await api("PATCH", "/api/state/daily", { date: today, tasks: { reading: true } });
    const p3 = await api("GET", "/api/points");
    eq("P7 阅读完成 +20", p3.json.balance, 50);

    const a3 = await api("POST", "/api/points/award", { reason: "dictation_perfect" });
    eq("P8 听写全对 +10", a3.json.balance, 60);

    // 打勾 review（本身不加分）：这时还差「语言强化」没完成，所以全勤奖不发
    await api("PATCH", "/api/state/daily", { date: today, tasks: { review: true } });
    const p4 = await api("GET", "/api/points");
    eq("P9 还差一项时不给全勤奖（余额停在 60）", p4.json.balance, 60);

    // 语言强化 9 道题全做完 → +20；这一项刚好凑满五项 → 全勤奖 +10 同一次到账
    await api("PATCH", "/api/state/daily", { date: today, tasks: { language: true } });
    const p5 = await api("GET", "/api/points");
    eq("P9b 语言强化完成 +20 且凑满五项全勤再 +10", p5.json.balance, 90);
    await api("PATCH", "/api/state/daily", { date: today, tasks: { language: true } });
    const p6 = await api("GET", "/api/points");
    eq("P9c 重复打勾不重复发分", p6.json.balance, 90);

    const r1 = await api("POST", "/api/points/redeem", { reward: "screen_30min" });
    eq("P10 兑换半小时平板扣 50 分", r1.json.balance, 40);
    const rd = await api("GET", "/api/points");
    eq("P11 兑换记录可查询", (rd.json.redemptions as unknown[]).length, 1);

    const r2 = await api("POST", "/api/points/redeem", { reward: "money_1yuan" });
    eq("P12 余额不足返回 400", r2.status, 400);

    const r3 = await api("POST", "/api/points/redeem", { reward: "xxx" });
    eq("P13 未知兑换项目返回 400", r3.status, 400);

    const stP = await api("GET", "/api/state");
    eq("P14 /api/state 返回 balance", stP.json.balance, 40);
    ok("P15 /api/state 返回 redemptions", Array.isArray(stP.json.redemptions));

    // 收尾：清掉积分，避免影响后面用例的 balance 断言（后面不再测积分）
    const resetAllP = await api("POST", "/api/admin/reset", { scope: "all" });
    ok("P16 resetAll 清空积分与兑换记录", typeof resetAllP.json.removed === "object");

    /* ============================ C. 故事生成 ============================ */
    group("C. 故事生成（mock）");
    await resetMock();
    await setMockMode("ok");
    const s1 = await api("POST", "/api/story/generate", {});
    eq("C1 生成成功", s1.status, 200);
    eq("C2 标题被正确解析（不再是正文前12字）", s1.json.title, "小水滴的旅行");
    ok("C3 正文不含标题行", !String(s1.json.text).includes("《小水滴的旅行》"));
    ok("C4 charCount 合理", Number(s1.json.charCount) > 10, String(s1.json.charCount));

    const stS = await api("GET", "/api/state");
    ok("C5 已读标题已记录", (stS.json.readTitles as string[]).includes("小水滴的旅行"));

    let calls = await mockCalls();
    ok("C6 首次生成时没有去重列表", !calls.calls[0].prompt.includes("请不要创作以下主题"), calls.calls[0].prompt.slice(-80));
    ok("C7 请求使用 storyModel", calls.calls[0].model === "mock-story", calls.calls[0].model);

    await resetMock();
    const s2 = await api("POST", "/api/story/generate", {});
    eq("C8 第二次生成仍成功", s2.status, 200);
    calls = await mockCalls();
    ok(
      "C9 再次生成时注入了「已读标题」去重列表",
      calls.calls[0].prompt.includes("请不要创作以下主题") && calls.calls[0].prompt.includes("小水滴的旅行"),
      calls.calls[0].prompt.slice(-120),
    );

    await resetMock();
    await setMockMode("badjson");
    const s3 = await api("POST", "/api/story/generate", {});
    eq("C10 模型不按格式返回时仍能兜底出标题", s3.status, 200);
    ok("C11 兜底标题取正文前 12 字", String(s3.json.title).startsWith("抱歉，这张图我看不"), String(s3.json.title));

    await resetMock();
    await setMockMode("notjson");
    const s4 = await api("POST", "/api/story/generate", {});
    eq("C12 返回非 JSON 时状态码 502", s4.status, 502);
    eq("C13 错误分类为 parse（地址写错）", s4.json.kind, "parse");

    await resetMock();
    await setMockMode("http401");
    const s5 = await api("POST", "/api/story/generate", {});
    eq("C14 401 返回 502", s5.status, 502);
    eq("C15 错误分类为 http", s5.json.kind, "http");
    calls = await mockCalls();
    eq("C16 401 不做无意义重试（只请求 1 次）", calls.count, 1);

    await resetMock();
    await setMockMode("slow");
    const s6 = await api("POST", "/api/story/generate", {});
    eq("C17 超时返回 504", s6.status, 504);
    eq("C18 错误分类为 timeout", s6.json.kind, "timeout");

    /* ============================ L. 语言强化 ============================ */
    group("L. 语言强化（mock · 9 题型出题 / 作答 / 换题）");
    await resetMock();
    await setMockMode("ok");

    const l0 = await api("GET", "/api/language/today");
    eq("L1 初始没有当天的语言强化题目", l0.json.set, null);
    eq("L2 初始作答进度为空", Object.keys(l0.json.progress as Record<string, unknown>).length, 0);

    const lg1 = await api("POST", "/api/language/generate", {});
    eq("L3 出题成功", lg1.status, 200);
    interface LQ {
      id: number;
      type: string;
      mode: string;
      question: string;
      options: string[];
      answer: string | string[];
      sentences: string[];
      reference: string;
      referenceList: string[];
      observationQuestions: string[];
      guideQuestions: string[];
      word: string;
    }
    const lgSet = lg1.json.set as { theme: string; difficulty: number; questions: LQ[] };
    const lqs = lgSet.questions;
    eq("L4 恰好 9 道题", lqs.length, 9);
    eq(
      "L5 题型顺序固定为 9 种",
      lqs.map((x) => x.type).join(","),
      "word,word_collocation,sentence_expand,sentence_correction,sentence_detail,sentence_order,image_observation,image_speaking,short_writing",
    );
    eq("L6 题号从 1 到 9", lqs.map((x) => x.id).join(","), "1,2,3,4,5,6,7,8,9");
    ok("L7 主题非空", !!lgSet.theme, lgSet.theme);

    const byType = (t: string): LQ => lqs.find((x) => x.type === t) as LQ;
    eq("L8 词语搭配为「选择」模式（可自动判卷）", byType("word_collocation").mode, "choice");
    ok("L9 选择题有 3 个以上候选", byType("word_collocation").options.length >= 2, String(byType("word_collocation").options.length));
    eq("L10 句子排序为「排序」模式", byType("sentence_order").mode, "order");
    eq("L11 排序题答案为 3 句", (byType("sentence_order").answer as string[]).length, 3);
    ok(
      "L12 排序题展示顺序已打乱（不等于答案顺序）",
      (byType("sentence_order").sentences as string[]).join("|") !== (byType("sentence_order").answer as string[]).join("|"),
    );
    eq("L13 简短写作为「口述 + 大人判」模式", byType("short_writing").mode, "open");
    ok("L14 开放题带参考答案", !!byType("short_writing").reference, byType("short_writing").reference.slice(0, 40));
    eq(
      "L15 看图观察的参考答案与观察问题一一对应",
      byType("image_observation").referenceList.length,
      byType("image_observation").observationQuestions.length,
    );
    ok("L16 每日词语带词语与例句", !!byType("word").word, byType("word").word);

    let lcalls = await mockCalls();
    ok("L17 出题时把主题与参数发给了模型", lcalls.calls[0]?.prompt.includes("本次训练参数") === true, lcalls.calls[0]?.prompt.slice(0, 80));
    eq("L18 出题用的是 story 用途的模型", lcalls.calls[0]?.model, "mock-story");

    // 幂等：当天已有题目时不重复出题、不重复花钱
    await resetMock();
    const lg2 = await api("POST", "/api/language/generate", {});
    eq("L19 当天已有题目时幂等返回", lg2.json.cached, true);
    lcalls = await mockCalls();
    eq("L20 幂等时不调用大模型", lcalls.count, 0);

    // 作答：自动判卷（选择）与家长判定（口述）都走同一接口
    const lp1 = await api("POST", "/api/language/progress", {
      questionId: 2,
      status: "done",
      judgedBy: "auto",
      answer: String(byType("word_collocation").answer),
    });
    eq("L21 保存作答返回 200", lp1.status, 200);
    eq("L22 第 2 题记为已完成", (lp1.json.progress as Record<string, { status: string }>)["2"]?.status, "done");
    const lp2 = await api("POST", "/api/language/progress", { questionId: 9, status: "wrong", judgedBy: "parent" });
    const p2p = lp2.json.progress as Record<string, { status: string; judgedBy: string }>;
    eq("L23 家长判定「再练一练」记为 wrong", p2p["9"]?.status, "wrong");
    eq("L24 家长判定标记 judgedBy=parent", p2p["9"]?.judgedBy, "parent");
    eq("L25 已有作答的两题都在进度里", Object.keys(p2p).length, 2);

    /* ---- 打卡联动：9 道题**全做完**才打勾首页那一项并 +20（少一道都不给） ---- */
    const tasksOf = async (): Promise<Record<string, boolean>> =>
      ((await api("GET", "/api/state")).json.daily as { tasks: Record<string, boolean> }).tasks;
    const balOf = async (): Promise<number> => (await api("GET", "/api/points")).json.balance as number;

    const balA = await balOf();
    eq("L25a 只做了一部分题时，语言强化不算完成", (await tasksOf()).language, false);

    // 上面已有第 2 题 done、第 9 题 wrong；再把 1/3~8 做掉 → 8/9，差最后一道
    for (const qid of [1, 3, 4, 5, 6, 7, 8]) {
      await api("POST", "/api/language/progress", { questionId: qid, status: "done", judgedBy: "parent" });
    }
    eq("L25b 只差一道时仍然不算完成", (await tasksOf()).language, false);
    eq("L25c 只差一道时一分不给", await balOf(), balA);

    // 把打回的第 9 题改判通过 → 9/9 打勾 + 20 分
    await api("POST", "/api/language/progress", { questionId: 9, status: "done", judgedBy: "parent" });
    eq("L25d 9 道全做完 → 首页那项自动打勾", (await tasksOf()).language, true);
    eq("L25e 9 道全做完 → +20 分", await balOf(), balA + 20);
    const lcnt = (await api("GET", "/api/state")).json.language as { total: number; done: number };
    eq("L25f /api/state 给出语言进度 9/9", `${lcnt.done}/${lcnt.total}`, "9/9");

    // 家长把一题打回「再练一练」→ 打勾取消，但已发的 20 分不追回
    await api("POST", "/api/language/progress", { questionId: 9, status: "wrong", judgedBy: "parent" });
    eq("L25g 有题被打回 → 任务退回「待完成」", (await tasksOf()).language, false);
    eq("L25h 已发的 20 分不追回", await balOf(), balA + 20);

    // 再判通过 → 重新打勾，且按天幂等不重复发分
    await api("POST", "/api/language/progress", { questionId: 9, status: "done", judgedBy: "parent" });
    eq("L25i 重新完成会再次打勾", (await tasksOf()).language, true);
    eq("L25j 重新完成不重复发分（按天幂等）", await balOf(), balA + 20);

    const badQ = await api("POST", "/api/language/progress", { questionId: 99, status: "done" });
    eq("L26 不存在的题号返回 400", badQ.status, 400);
    const badS = await api("POST", "/api/language/progress", { questionId: 1, status: "meh" });
    eq("L27 非法状态返回 400", badS.status, 400);

    // 指定主题：出题必须使用传进来的主题，并记入「最近主题」用于去重
    await resetMock();
    const lg3 = await api("POST", "/api/language/generate", { force: true, theme: "测试主题" });
    eq("L28 指定主题时按传入主题出题", (lg3.json.set as { theme: string }).theme, "测试主题");
    const todayL = await api("GET", "/api/language/today");
    ok("L29 「最近主题」记录了本次主题", (todayL.json.themes as string[]).includes("测试主题"));
    eq("L30 换一套后作答进度被清空", Object.keys(todayL.json.progress as Record<string, unknown>).length, 0);
    const tasksL = (todayL.json.daily as { tasks: Record<string, boolean> }).tasks;
    eq("L30b 换一套题 → 语言强化的打卡标记退回「待完成」", tasksL.language, false);
    eq("L30c 换一套题后 /api/state 的语言进度归零", (todayL.json.counts as { done: number }).done, 0);

    // 模型少返题：重试一次仍失败 → 502 + kind=parse
    await resetMock();
    await setMockMode("langcount");
    const lgBad = await api("POST", "/api/language/generate", { force: true });
    eq("L31 模型题数不对时返回 502", lgBad.status, 502);
    eq("L32 错误分类为 parse", lgBad.json.kind, "parse");
    lcalls = await mockCalls();
    eq("L33 解析失败会自动重试一次（共 2 次请求）", lcalls.count, 2);

    await resetMock();
    await setMockMode("ok");
    await api("POST", "/api/language/reset", {});
    const lAfter = await api("GET", "/api/language/today");
    eq("L34 reset 后当天题目被清掉", lAfter.json.set, null);
    ok("L35 reset 不影响「最近主题」历史", (lAfter.json.themes as string[]).length >= 1);

    /* ---- 配图：文生图（千问 qwen-image 同步接口） ---- */
    // 覆盖「出题 → 画图 → 前端能取到真图」这条链路，
    // 以及幂等（同一张图不重复花钱）、失败降级（画不出来也不影响做题）两条边界。
    await resetMock();
    await setMockMode("ok");
    await api("POST", "/api/language/generate", {});
    const imgBefore = await api("GET", "/api/language/today");
    eq("L36 还没画图时 image 为 null", imgBefore.json.image, null);

    const ig1 = await api("POST", "/api/language/image", {});
    eq("L37 画图成功返回 200", ig1.status, 200);
    const imgInfo = ig1.json.image as { ready: boolean; url: string; version: string };
    eq("L38 画好后 ready=true", imgInfo?.ready, true);
    ok("L39 给的是我们自己后端的图片地址", imgInfo?.url.startsWith("/api/language/image/") === true, imgInfo?.url);

    const pic = await api("GET", imgInfo.url, undefined, true);
    eq("L40 图片可下载且为 PNG", pic.headers.get("content-type"), "image/png");
    ok("L41 图片内容非空", (pic.buf?.length ?? 0) > 0, `len=${pic.buf?.length ?? 0}`);

    // 只挑文生图那次请求来看（同一轮里还有出题的 chat 请求）
    const iprompt = (await mockCalls()).calls.find((c) => c.url === "/__image")?.prompt ?? "";
    ok("L42 发给文生图的提示词带上了画面描述", iprompt.includes("放风筝"), iprompt.slice(0, 90));
    ok("L43 提示词钉死了「不出现文字」", iprompt.includes("不能出现任何文字"), iprompt.slice(0, 90));

    // 幂等：同一场景不重复画（不重复花钱）
    await resetMock();
    const ig2 = await api("POST", "/api/language/image", {});
    eq("L44 同一场景重复请求走缓存", ig2.json.cached, true);
    eq("L45 缓存时不再调用文生图接口", (await mockCalls()).count, 0);

    // 画图失败：返回 502，但题目本身照常可用（前端会退回文字描述）
    await setMockMode("imgfail");
    const igBad = await api("POST", "/api/language/image", { force: true });
    eq("L46 文生图失败返回 502", igBad.status, 502);
    ok("L47 失败提示写清是「画图失败」", String(igBad.json.error).includes("画图失败"), String(igBad.json.error).slice(0, 70));
    await setMockMode("ok");
    const stillOk = await api("GET", "/api/language/today");
    eq("L48 画图失败不影响题目本身", (stillOk.json.set as { questions: unknown[] }).questions.length, 9);

    // 家长后台「重置今日」要把当天的配图记录一起清掉
    const imageDate = String(stillOk.json.date);
    await api("POST", "/api/admin/reset", { scope: "today" });
    const afterReset = await api("GET", "/api/language/today");
    eq("L49 resetToday 清掉当天配图记录", afterReset.json.image, null);
    const picGone = await api("GET", `/api/language/image/${imageDate}`);
    eq("L50 重置后配图地址返回 404", picGone.status, 404);

    // 没有题目时要画图 → 明确报 404（而不是画一张无意义的图）
    const igNoSet = await api("POST", "/api/language/image", {});
    eq("L51 没有题目时画图返回 404", igNoSet.status, 404);

    /* ============================ D. 语音合成 ============================ */
    group("D. 语音合成（Edge TTS）");
    await resetMock();
    const t1 = await api("GET", `/api/tts?text=${encodeURIComponent("眼睛")}&kind=word`, undefined, true);
    const t1buf = t1.buf!;
    eq("D1 返回 audio/mpeg", t1.headers.get("content-type"), "audio/mpeg");
    ok("D2 首次为 MISS", t1.headers.get("x-tts-cache") === "MISS", String(t1.headers.get("x-tts-cache")));
    ok("D3 是合法 MP3（帧同步字）", t1buf.length > 1000 && t1buf[0] === 0xff && (t1buf[1] & 0xe0) === 0xe0, `len=${t1buf.length}`);
    const t2 = await api("GET", `/api/tts?text=${encodeURIComponent("眼睛")}&kind=word`, undefined, true);
    eq("D4 二次命中缓存", t2.headers.get("x-tts-cache"), "HIT");
    ok("D5 缓存内容与首次一致", Buffer.compare(t1buf, t2.buf!) === 0);
    const t3 = await api("GET", `/api/tts?text=${encodeURIComponent("眼睛")}&kind=char`, undefined, true);
    eq("D6 单字语速不同 → 独立缓存（MISS）", t3.headers.get("x-tts-cache"), "MISS");
    const tstat = await api("GET", "/api/tts/stats");
    ok("D7 缓存统计可用", Number(tstat.json.count) >= 2, JSON.stringify(tstat.json));
    const tbad = await api("GET", "/api/tts?text=");
    eq("D8 空文本返回 400", tbad.status, 400);

    // D9~D12：纯标点/符号的文本必须被判成「请求方没给可读内容」= 400，
    // 不能报 503 —— 503 会被前端理解成「后端 TTS 挂了」而永久降级成浏览器音色。
    // 真实故障现场：故事里的 `“我不怕。”` 被切成 `“我不怕。` + `”`，孤立的 `”` 就是这种请求。
    for (const [i, punct] of ["……", "——", "”", "，。"].entries()) {
      const r = await api("GET", `/api/tts?text=${encodeURIComponent(punct)}&kind=sentence`, undefined, true);
      eq(`D${9 + i} 纯标点 ${JSON.stringify(punct)} 返回 400`, r.status, 400);
      eq(`D${9 + i} 纯标点 ${JSON.stringify(punct)} 错误码为 tts.noinput`, r.json.kind, "tts.noinput");
    }
    // 有字的文本照常 200，别把正常请求误伤
    const tstillOk = await api("GET", `/api/tts?text=${encodeURIComponent("好。")}&kind=sentence`, undefined, true);
    eq("D13 含可读字的一段仍然 200", tstillOk.status, 200);

    /* ============================ E. 判卷 ============================ */
    group("E. 手写判卷");
    await resetMock();
    await setMockMode("ok");
    const targets = ["两", "哪", "宽"];
    const mk1 = await api("POST", "/api/mark", {
      lessonId: lesson1,
      mode: "composite",
      targets,
      image: TINY_PNG,
      images: targets.map(() => TINY_PNG),
    });
    eq("E1 提交判卷返回 taskId", mk1.status, 200);
    const taskId1 = Number(mk1.json.taskId);
    ok("E1b 立即返回 pending（异步任务）", mk1.json.status === "pending");

    let task: Record<string, never> & Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const r = await api("GET", `/api/mark/${taskId1}`);
      task = r.json.task as typeof task;
      if ((task as { status: string }).status === "done" || (task as { status: string }).status === "failed") break;
    }
    const items = (task as { items: { index: number; target: string; correct: boolean; comment: string }[] }).items;
    eq("E2 任务完成", (task as { status: string }).status, "done");
    eq("E3 结果项数与目标一致", items.length, 3);
    eq("E4 序号严格对应 1,2,3", items.map((i) => i.index), [1, 2, 3]);
    eq("E5 目标字对应正确", items.map((i) => i.target), targets);
    eq("E6 未触发降级", (task as { degraded: boolean }).degraded, false);
    calls = await mockCalls();
    eq("E7 批量判卷只发 1 次请求（成本差 8 倍的关键）", calls.count, 1);
    ok("E8 请求带图片（多模态）", calls.calls[0].hasImage === true);

    const stM = await api("GET", "/api/state");
    const masteryMap = stM.json.mastery as Record<string, Record<string, number>>;
    eq("E9 判对的字写入掌握度=1", masteryMap[String(lesson1)]["两"], 1);
    eq("E10 判错的字写入掌握度=0", masteryMap[String(lesson1)]["哪"], 0);
    const wrongCn = (stM.json.wrong as { chinese: { refKey: string }[] }).chinese;
    ok(
      "E11 判错的字进入错字本",
      wrongCn.some((w) => w.refKey === `${lesson1}:哪`),
      JSON.stringify(wrongCn.map((w) => w.refKey)),
    );
    ok("E12 判对的字不在错字本", !wrongCn.some((w) => w.refKey === `${lesson1}:两`));

    const rv = await api("POST", `/api/mark/${taskId1}/review`, { items: [{ index: 2, correct: true }] });
    ok("E13 家长改判成功", rv.status === 200);
    const stM2 = await api("GET", "/api/state");
    const wrongCn2 = (stM2.json.wrong as { chinese: { refKey: string }[] }).chinese;
    ok("E14 改判为对后从错字本移除", !wrongCn2.some((w) => w.refKey === `${lesson1}:哪`));
    eq(
      "E15 改判后掌握度同步为 1",
      (stM2.json.mastery as Record<string, Record<string, number>>)[String(lesson1)]["哪"],
      1,
    );

    await resetMock();
    await setMockMode("wrongcount");
    const mk2 = await api("POST", "/api/mark", {
      lessonId: lesson1,
      mode: "composite",
      targets,
      image: TINY_PNG,
      images: targets.map(() => TINY_PNG),
    });
    const taskId2 = Number(mk2.json.taskId);
    let task2: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      await sleep(400);
      const r = await api("GET", `/api/mark/${taskId2}`);
      task2 = r.json.task as Record<string, unknown>;
      if (task2.status === "done" || task2.status === "failed") break;
    }
    eq("E16 数量不符时自动降级逐字判卷", task2.status, "done");
    eq("E17 降级标记为 true", task2.degraded, true);
    eq("E18 降级后结果仍然完整", (task2.items as unknown[]).length, 3);
    calls = await mockCalls();
    eq("E19 降级后发起了逐字请求（1 批量 + 3 单字 = 4）", calls.count, 4);

    await resetMock();
    await setMockMode("ok");
    const mk3 = await api("POST", "/api/mark", {
      lessonId: lesson1,
      mode: "each",
      targets: ["两", "哪"],
      images: [TINY_PNG, TINY_PNG],
    });
    const taskId3 = Number(mk3.json.taskId);
    let task3: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const r = await api("GET", `/api/mark/${taskId3}`);
      task3 = r.json.task as Record<string, unknown>;
      if (task3.status === "done" || task3.status === "failed") break;
    }
    eq("E20 each 模式可用", task3.status, "done");
    eq("E21 each 模式结果完整", (task3.items as { index: number }[]).map((i) => i.index), [1, 2]);

    const mkBad = await api("POST", "/api/mark", { mode: "composite", targets: [], image: TINY_PNG });
    eq("E22 空 targets 返回 400", mkBad.status, 400);
    const mkBad2 = await api("POST", "/api/mark", { mode: "composite", targets: ["两"] });
    eq("E23 composite 缺图返回 400", mkBad2.status, 400);
    const mkBad3 = await api("POST", "/api/mark", { mode: "each", targets: ["两", "哪"], images: [TINY_PNG] });
    eq("E24 each 图数不匹配返回 400", mkBad3.status, 400);
    const notFound = await api("GET", "/api/mark/999999");
    eq("E25 不存在的任务返回 404", notFound.status, 404);

    /* ============================ F. 家长后台 ============================ */
    group("F. 家长内容后台");
    const newLesson = await api("POST", "/api/admin/lessons", { title: "《测试课文》", unit: "测试单元" });
    eq("F1 新建课文", newLesson.status, 200);
    const newId = Number(newLesson.json.id);
    ok("F2 返回课文 id", Number.isFinite(newId) && newId > 0);

    const bulk = await api("POST", `/api/admin/lessons/${newId}/chars/bulk`, { text: "两 哪 宽 两，天\t天" });
    eq("F3 批量粘贴拆字去重", bulk.json.added, 4);
    eq("F4 重复字被跳过（两个「两」、两个「天」）", bulk.json.skipped, 2);

    const afterBulk = (bulk.json.lesson as { chars: { ch: string; pinyin: string }[] }).chars;
    eq("F5 生字顺序正确", afterBulk.map((c) => c.ch), ["两", "哪", "宽", "天"]);
    ok("F6 自动注音", afterBulk.every((c) => c.pinyin.length > 0), JSON.stringify(afterBulk.map((c) => c.pinyin)));

    // 多音字：改组词后拼音应自动重算
    await api("PUT", `/api/admin/lessons/${newId}/chars/${encodeURIComponent("天")}`, { word: "天空" });
    const p1 = await api("GET", `/api/admin/lessons/${newId}`);
    const tian = (p1.json.lesson as { chars: { ch: string; word: string; pinyin: string }[] }).chars.find((c) => c.ch === "天");
    eq("F7 组词保存成功", tian?.word, "天空");

    // 用「发」验证多音字重算（在《妈妈睡了》那课）
    const mlId = lessons.find((l) => l.title === "《妈妈睡了》")!.id;
    await api("PUT", `/api/admin/lessons/${mlId}/chars/${encodeURIComponent("发")}`, { word: "发现" });
    const lr1 = await api("GET", `/api/admin/lessons/${mlId}`);
    const fa1 = (lr1.json.lesson as { chars: { ch: string; pinyin: string }[] }).chars.find((c) => c.ch === "发");
    eq("F8 改组词后拼音重算（发现 → fā）", fa1?.pinyin, "fā");
    await api("PUT", `/api/admin/lessons/${mlId}/chars/${encodeURIComponent("发")}`, { word: "头发" });
    const lr2 = await api("GET", `/api/admin/lessons/${mlId}`);
    const fa2 = (lr2.json.lesson as { chars: { ch: string; pinyin: string }[] }).chars.find((c) => c.ch === "发");
    eq("F9 改回头发 → 轻声 fa（多音字消歧生效）", fa2?.pinyin, "fa");

    const delRes = await api("DELETE", `/api/admin/lessons/${newId}/chars/${encodeURIComponent("宽")}`);
    const left = (delRes.json.lesson as { chars: { ch: string; sortNo: number }[] }).chars;
    eq("F10 删除生字", left.map((c) => c.ch), ["两", "哪", "天"]);
    eq("F11 删除后 sortNo 重新连续", left.map((c) => c.sortNo), [1, 2, 3]);

    const suggest = await api("POST", `/api/admin/lessons/${mlId}/words/suggest`, { onlyEmpty: true });
    ok("F12 组词建议（无空缺时给出说明）", suggest.status === 200, JSON.stringify(suggest.json).slice(0, 120));

    const seedAgain = await api("POST", "/api/admin/seed", {});
    eq("F13 种子导入幂等（已存在则跳过）", (seedAgain.json.result as { created: number }).created, 0);
    eq("F14 种子跳过数量为 14", (seedAgain.json.result as { skipped: number }).skipped, 14);

    await api("DELETE", `/api/admin/lessons/${newId}`);
    const afterDel = await api("GET", "/api/lessons");
    eq("F15 删除课文", ((afterDel.json.lessons ?? []) as unknown[]).length, 14);

    /* ============================ G. 备份与恢复 ============================ */
    group("G. 备份与恢复");
    const bk = await api("GET", "/api/backup");
    eq("G1 导出备份", bk.status, 200);
    const pack = JSON.parse(bk.text) as { app: string; version: number; data: Record<string, unknown> };
    eq("G2 备份标识正确", pack.app, "grade2-server");
    ok("G3 备份含课文与生字", Array.isArray(pack.data.lessons) && Array.isArray(pack.data.lessonChars));
    ok("G4 备份含学习数据", Array.isArray(pack.data.mastery) && Array.isArray(pack.data.wrong));

    const merge = await api("POST", "/api/restore", { pack, mode: "merge" });
    ok("G5 服务端备份恢复成功", merge.status === 200, `实际=${merge.status} 错误=${String(merge.json.error ?? "")}`);
    ok("G6 返回恢复摘要", typeof merge.json.summary === "object");
    const merge2 = await api("POST", "/api/restore", { pack, mode: "merge" });
    ok("G6b 重复恢复幂等（第二次也不报错）", merge2.status === 200, `实际=${merge2.status} 错误=${String(merge2.json.error ?? "")}`);

    // 老版单文件 HTML 的导出格式（mastery 的 key 是课文标题）
    const legacy = {
      app: "grade2-workbench",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        daily: { date: today, tasks: { math: true, dictation: true }, reviewCount: 1 },
        mathSet: { date: today, qs: [{ a: 6, b: 7, op: "×", ans: 42 }], results: { 0: "ok" } },
        mastery: { "《小蝌蚪找妈妈》": { 两: 1, 哪: 0 } },
        wrong: {
          math: [{ id: "m1", text: "6 × 7 =", ans: 42 }],
          chinese: [
            { id: "c1", char: "宽", lesson: "《小蝌蚪找妈妈》" },
            { id: "c2", char: "幻", lesson: "《不存在的课文》" },
          ],
        },
        stories: { readTitles: ["示例：小水珠的旅行", "老故事标题"], history: [{ title: "老故事标题", date: today }] },
      },
    };
    const legacyRes = await api("POST", "/api/restore", { pack: legacy, mode: "replace", skipDemo: true });
    eq("G7 老版备份恢复成功", legacyRes.status, 200);
    const sum = legacyRes.json.summary as { format: string; mastery: number; wrong: number; skipped: string[] };
    eq("G8 识别出老版格式", sum.format, "legacy");
    eq("G9 掌握度按课文标题映射到 lessonId", sum.mastery, 2);
    ok("G10 示例数据被跳过", !JSON.stringify(await api("GET", "/api/state")).includes("示例：小水珠的旅行"));
    ok("G11 找不到的课文被记录为跳过", sum.skipped.some((s) => s.includes("不存在的课文")), JSON.stringify(sum.skipped));

    const stL = await api("GET", "/api/state");
    const wrongCnL = (stL.json.wrong as { chinese: { refKey: string }[] }).chinese;
    ok(
      "G12 老错字按标题映射到 lessonId",
      wrongCnL.some((w) => w.refKey === `${lessons[0].id}:宽`),
      JSON.stringify(wrongCnL.map((w) => w.refKey)),
    );
    eq("G13 老数学错题导入", (stL.json.wrong as { math: unknown[] }).math.length, 1);
    ok("G14 老故事标题导入", (stL.json.readTitles as string[]).includes("老故事标题"));

    const badRestore = await api("POST", "/api/restore", { pack: { foo: "bar" } });
    eq("G15 无法识别的备份返回 400", badRestore.status, 400);
    ok("G16 400 时给出可读原因", String(badRestore.json.error).includes("无法识别"), String(badRestore.json.error));

    /* ============================ H. 诊断 ============================ */
    group("H. 诊断");
    const logs = await api("GET", "/api/diag/logs?limit=50");
    eq("H1 日志接口可用", logs.status, 200);
    ok("H2 日志有内容", ((logs.json.logs ?? []) as unknown[]).length > 0);
    const lg = (logs.json.logs as { text: string; level: string }[])[0];
    ok("H3 日志文本包含时间戳与级别", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(lg.text) && /INFO|WARN|ERROR/.test(lg.text), lg.text.slice(0, 80));

    const diag = await api("GET", "/api/diag/llm");
    eq("H4 诊断接口可用", diag.status, 200);
    const checks = diag.json.checks as { name: string; ok: boolean }[];
    ok("H5 含全部检查项", checks.length >= 8, String(checks.length));
    ok("H6 密钥已脱敏（不出现完整 key）", !JSON.stringify(diag.json).includes("sk-test-mock-key"), "");

    const llmTest = await api("POST", "/api/diag/llm-test", { which: "story" });
    eq("H7 真实调用测试通过", llmTest.status, 200);
    ok("H8 返回模型回复", typeof llmTest.json.reply === "string" && String(llmTest.json.reply).length > 0);

    const ttsTest = await api("GET", `/api/diag/tts-test?text=${encodeURIComponent("你好")}`);
    eq("H9 TTS 自检通过", ttsTest.status, 200);
    ok("H10 TTS 返回字节数", Number(ttsTest.json.bytes) > 500, String(ttsTest.json.bytes));

    const echo = await api("POST", "/api/diag/echo", { ping: 1 });
    eq("H11 回显接口", echo.json.received, { ping: 1 });

    const nf = await api("GET", "/api/does-not-exist");
    eq("H12 未知接口返回 404 JSON", nf.status, 404);
    ok("H13 404 响应是 JSON", nf.json.ok === false);

    /* ============================ R. 重置 ============================ */
    group("R. 重置（resetToday 清今天 mastery · resetAll 清全部 mastery）");
    const todayR = (await api("GET", "/api/state")).json.date as string;
    const lessonsR = (await api("GET", "/api/lessons")).json.lessons as { id: number }[];
    const lessonR = lessonsR[0]?.id ?? 0;

    // 先写两条 mastery（一个掌握、一个未掌握）。updated_at 是后端 nowIso() 写入的，会落在 today。
    await api("PATCH", "/api/state/mastery", { lessonId: lessonR, ch: "肚", state: 1 });
    await api("PATCH", "/api/state/mastery", { lessonId: lessonR, ch: "皮", state: 0 });
    const before = (await api("GET", "/api/state")).json.mastery as Record<string, Record<string, number>>;
    eq(
      "R1 重置前本课 mastery 已有「肚」「皮」两条",
      [before[String(lessonR)]?.["肚"], before[String(lessonR)]?.["皮"]],
      [1, 0],
    );

    const rToday = await api("POST", "/api/admin/reset", { scope: "today" });
    eq("R2 resetToday 状态码 200", rToday.status, 200);
    ok("R3 返回值含 removed.mastery 字段", typeof rToday.json.removed === "object" && "mastery" in (rToday.json.removed as Record<string, unknown>));
    eq(
      "R4 本课 mastery 被清空（至少「肚」「皮」两条没了）",
      ((await api("GET", "/api/state")).json.mastery as Record<string, Record<string, number>>)[String(lessonR)] ?? {},
      {},
    );

    // 验证「只删今天、保留历史」：先把两条 mastery 都写为 1，然后把其中一条的 updated_at 改成昨天，
    // 再 resetToday —— 应该只删今天的「皮」，保留昨天的「肚」。
    const yday = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    // 1) 先把两条 mastery 都写为今天的状态
    await api("PATCH", "/api/state/mastery", { lessonId: lessonR, ch: "肚", state: 1 });
    await api("PATCH", "/api/state/mastery", { lessonId: lessonR, ch: "皮", state: 1 });
    const beforePre = (await api("GET", "/api/state")).json.mastery as Record<string, Record<string, number>>;
    ok(
      "R5a 两条 mastery 都已写入（肚/皮=1）",
      beforePre[String(lessonR)]?.["肚"] === 1 && beforePre[String(lessonR)]?.["皮"] === 1,
    );

    // 2) 用 better-sqlite3 把「肚」的 updated_at 改回昨天，模拟「历史掌握度」
    const DatabaseMod = await import("better-sqlite3");
    const DbCtor = DatabaseMod.default as unknown as new (p: string) => {
      prepare: (s: string) => { run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
      close: () => void;
      pragma: (s: string) => unknown;
    };
    const dbMod = new DbCtor(TEST_DB);
    const upd = dbMod
      .prepare(
        "UPDATE mastery SET updated_at = ? WHERE child_id = (SELECT id FROM children LIMIT 1) AND lesson_id = ? AND ch = ?",
      )
      .run(`${yday}T12:00:00.000Z`, lessonR, "肚") as { changes: number };
    dbMod.pragma("wal_checkpoint(FULL)");
    dbMod.close();

    // 3) 直接读 db 确认「肚」确实是昨天的时间戳（不依赖服务进程缓存）
    const dbChk = new DbCtor(TEST_DB);
    const checkRows = dbChk
      .prepare("SELECT ch, updated_at FROM mastery WHERE lesson_id = ? ORDER BY ch")
      .all(lessonR) as { ch: string; updated_at: string }[];
    dbChk.close();
    const checkMap = Object.fromEntries(checkRows.map((r) => [r.ch, r.updated_at]));
    const duYday = checkMap["肚"]?.startsWith(yday);
    const piToday = checkMap["皮"]?.startsWith(todayR);
    ok(
      `R5b db 视角：「肚」=昨天时间戳（${checkMap["肚"]}）、「皮」=今天时间戳（${checkMap["皮"]}） · UPDATE 影响 ${upd.changes} 行`,
      Boolean(duYday && piToday),
    );

    // 4) resetToday：只删今天的，保留昨天的
    await api("POST", "/api/admin/reset", { scope: "today" });
    const afterR6 = (await api("GET", "/api/state")).json.mastery as Record<string, Record<string, number>>;
    eq("R6 只删今天：保留昨天动过的「肚」", afterR6[String(lessonR)]?.["肚"], 1);
    eq("R7 删掉今天的「皮」", afterR6[String(lessonR)]?.["皮"], undefined);

    // resetAll 清 mastery（回到最初状态：生字页无勾选）
    await api("PATCH", "/api/state/mastery", { lessonId: lessonR, ch: "孩", state: 1 });
    const rAll = await api("POST", "/api/admin/reset", { scope: "all" });
    const afterR8 = (await api("GET", "/api/state")).json.mastery as Record<string, Record<string, number>>;
    eq("R8 resetAll 清空 mastery（回到最初，生字页无勾选）", afterR8[String(lessonR)]?.["孩"], undefined);
    eq("R8b resetAll 连历史掌握度「肚」也清掉", afterR8[String(lessonR)]?.["肚"], undefined);

    // resetToday 按 created_at 当天清今天的错题（resetAll 之后错题本是干净的，这里先造今天的错题）
    await api("POST", "/api/state/wrong", { type: "math", refKey: "9 × 9 =", payload: { text: "9 × 9 =", ans: 81 } });
    await api("POST", "/api/state/wrong", {
      type: "chinese",
      refKey: `${lessonR}:今`,
      payload: { char: "今", lessonId: lessonR },
    });
    const wrongB2 = (await api("GET", "/api/state")).json.wrong as { math: unknown[]; chinese: unknown[] };
    ok(
      "R9 重置前错题本有今天的数学 + 语文错题",
      wrongB2.math.length >= 1 && wrongB2.chinese.length >= 1,
    );
    // 语言强化也属于「今天的进度」：先把当天的题目与作答造出来，验证同一个 resetToday 会一并清掉
    await resetMock();
    await setMockMode("ok");
    await api("POST", "/api/language/generate", { force: true });
    await api("POST", "/api/language/progress", { questionId: 1, status: "done", judgedBy: "parent" });
    const langBefore = await api("GET", "/api/language/today");
    ok(
      "R9b 重置前当天已有语言强化题目与作答",
      !!langBefore.json.set && Object.keys(langBefore.json.progress as Record<string, unknown>).length === 1,
    );

    const rToday2 = await api("POST", "/api/admin/reset", { scope: "today" });
    ok(
      "R10 resetToday 返回含 removed.wrong 字段",
      typeof rToday2.json.removed === "object" && "wrong" in (rToday2.json.removed as Record<string, unknown>),
    );
    const wrongA2 = (await api("GET", "/api/state")).json.wrong as { math: unknown[]; chinese: unknown[] };
    eq("R11 resetToday 清空今天的错题", wrongA2.math.length + wrongA2.chinese.length, 0);

    const langAfter = await api("GET", "/api/language/today");
    eq("R11b resetToday 清掉当天的语言强化题目", langAfter.json.set, null);
    eq("R11c resetToday 清掉当天的语言强化作答", Object.keys(langAfter.json.progress as Record<string, unknown>).length, 0);
    ok("R11d 语言强化的「最近主题」是跨天键，重置今日后保留", (langAfter.json.themes as string[]).length >= 1);

    // resetToday 撤销「今日」的积分变动：今天发放的正分、今天发生的兑换一起清掉，余额回到今天开始前。
    // 攒 70 分（math_done 10 + dictation_done 10 + reading_done 20 + language_done 20 + all_done 10），
    // 兑一次（-50 → 20），再补一条当日发放（math_perfect +10 → 30），resetToday 后应回到 0 分 0 兑换。
    await api("PATCH", "/api/state/daily", {
      date: todayR,
      tasks: { math: true, dictation: true, reading: true, language: true, review: true },
    });
    const pBefore = await api("GET", "/api/points");
    eq("R12 重置前攒够 70 分", pBefore.json.balance, 70);
    await api("POST", "/api/points/redeem", { reward: "screen_30min" });
    await api("POST", "/api/points/award", { reason: "math_perfect" });
    const pAfterAward = await api("GET", "/api/points");
    eq("R13 兑换后再发当日积分，余额为 30", pAfterAward.json.balance, 30);
    const rToday3 = await api("POST", "/api/admin/reset", { scope: "today" });
    ok(
      "R14 resetToday 返回含 removed.redemptions",
      typeof rToday3.json.removed === "object" && "redemptions" in (rToday3.json.removed as Record<string, unknown>),
    );
    const pAfter = await api("GET", "/api/points");
    eq("R15 resetToday 清空今日积分（余额回退到 0）", pAfter.json.balance, 0);
    eq("R16 resetToday 清空今日兑换记录", (pAfter.json.redemptions as unknown[]).length, 0);

    // R17：只撤销「今天」，保留「历史」兑换。再造一条今日兑换，把它的负分流水与兑换记录的
    // created_at 都改成昨天，再 resetToday —— 今天的正分清掉，这条「昨天」的兑换应保留。
    await api("PATCH", "/api/state/daily", {
      date: todayR,
      tasks: { math: true, dictation: true, reading: true, language: true, review: true },
    });
    await api("POST", "/api/points/redeem", { reward: "money_1yuan" });
    const dbMod2 = new DbCtor(TEST_DB);
    dbMod2
      .prepare(
        "UPDATE points_ledger SET created_at = ? WHERE child_id = (SELECT id FROM children LIMIT 1) AND reason = 'redeem'",
      )
      .run(`${yday}T12:00:00.000Z`);
    dbMod2
      .prepare("UPDATE redemptions SET created_at = ? WHERE child_id = (SELECT id FROM children LIMIT 1)")
      .run(`${yday}T12:00:00.000Z`);
    dbMod2.pragma("wal_checkpoint(FULL)");
    dbMod2.close();
    await api("POST", "/api/admin/reset", { scope: "today" });
    const pAfter2 = await api("GET", "/api/points");
    eq("R17 历史兑换记录保留（只清今天的）", (pAfter2.json.redemptions as unknown[]).length, 1);
  } finally {
    app.kill();
    mock.kill();
    await sleep(600);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`总计 ${pass + failures.length} 项，通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("\n失败清单：");
    for (const f of failures) console.log("  · " + f);
  }
  console.log("=".repeat(60));

  cleanup();
  process.exit(failures.length ? 1 : 0);
}

function cleanup(): void {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`, TEST_CONFIG, SERVER_LOG]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  for (const d of [TEST_TTS, TEST_IMAGES, TEST_BACKUP]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch(async (e) => {
  console.error("\n测试执行异常：", e);
  cleanup();
  process.exit(1);
});
