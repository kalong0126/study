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
async function mockCalls(): Promise<{ count: number; calls: { model: string; prompt: string; hasImage: boolean }[] }> {
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
  for (const d of [TEST_TTS, TEST_BACKUP]) {
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

    // 打勾最后一项 review → 四项全完成，自动 +10
    await api("PATCH", "/api/state/daily", { date: today, tasks: { review: true } });
    const p4 = await api("GET", "/api/points");
    eq("P9 四项全完成再 +10", p4.json.balance, 70);

    const r1 = await api("POST", "/api/points/redeem", { reward: "screen_30min" });
    eq("P10 兑换半小时平板扣 50 分", r1.json.balance, 20);
    const rd = await api("GET", "/api/points");
    eq("P11 兑换记录可查询", (rd.json.redemptions as unknown[]).length, 1);

    const r2 = await api("POST", "/api/points/redeem", { reward: "money_1yuan" });
    eq("P12 余额不足返回 400", r2.status, 400);

    const r3 = await api("POST", "/api/points/redeem", { reward: "xxx" });
    eq("P13 未知兑换项目返回 400", r3.status, 400);

    const stP = await api("GET", "/api/state");
    eq("P14 /api/state 返回 balance", stP.json.balance, 20);
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
    group("R. 重置（resetToday 清 mastery · resetAll 不动 mastery）");
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

    // resetAll 不动 mastery（保住设计意图）
    await api("PATCH", "/api/state/mastery", { lessonId: lessonR, ch: "孩", state: 1 });
    const rAll = await api("POST", "/api/admin/reset", { scope: "all" });
    const afterR8 = (await api("GET", "/api/state")).json.mastery as Record<string, Record<string, number>>;
    eq("R8 resetAll 不动 mastery（保留长期掌握度）", afterR8[String(lessonR)]?.["孩"], 1);

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
    const rToday2 = await api("POST", "/api/admin/reset", { scope: "today" });
    ok(
      "R10 resetToday 返回含 removed.wrong 字段",
      typeof rToday2.json.removed === "object" && "wrong" in (rToday2.json.removed as Record<string, unknown>),
    );
    const wrongA2 = (await api("GET", "/api/state")).json.wrong as { math: unknown[]; chinese: unknown[] };
    eq("R11 resetToday 清空今天的错题", wrongA2.math.length + wrongA2.chinese.length, 0);

    // resetToday 撤销「今日」的积分变动：今天发放的正分、今天发生的兑换一起清掉，余额回到今天开始前。
    // 攒 50 分（math_done 10 + dictation_done 10 + reading_done 20 + all_done 10），
    // 兑一次（-50 → 0），再补一条当日发放（math_perfect +10 → 10），resetToday 后应回到 0 分 0 兑换。
    await api("PATCH", "/api/state/daily", {
      date: todayR,
      tasks: { math: true, dictation: true, reading: true, review: true },
    });
    const pBefore = await api("GET", "/api/points");
    eq("R12 重置前攒够 50 分", pBefore.json.balance, 50);
    await api("POST", "/api/points/redeem", { reward: "screen_30min" });
    await api("POST", "/api/points/award", { reason: "math_perfect" });
    const pAfterAward = await api("GET", "/api/points");
    eq("R13 兑换后再发当日积分，余额为 10", pAfterAward.json.balance, 10);
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
      tasks: { math: true, dictation: true, reading: true, review: true },
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
  for (const d of [TEST_TTS, TEST_BACKUP]) {
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
