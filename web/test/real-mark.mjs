/**
 * 真实模型判卷端到端验证（会真的调用你 .env 里的模型，消耗少量 token）
 *
 * 为什么需要它：
 *   api.test.ts 用的是 mock 模型，只能证明「流程通」；
 *   这个脚本证明「真模型真的能认出手写、并且判对/判错都对」。
 *
 * 做法：
 *   1. 起一个隔离实例（独立 DB / 独立端口 8799），不碰孩子的真实数据
 *   2. 用真实 Chromium 画布，按前端 sheetDataUrl 的版式生成「田字格 + 红色序号」合成图
 *   3. POST /api/mark → 轮询 /api/mark/:taskId → 核对每个字的判定
 *
 * 关键断言：
 *   - 写字帖时给出的字，模型必须判 correct=true
 *   - 故意写错字时，模型必须判 correct=false（否则等于没在看图）
 *
 * 用法：node web/test/real-mark.mjs
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

// 仓库根用「脚本自身位置」推，而不是 cwd —— `npm run` 时 cwd 是 web/，用 cwd 会推成 web/server
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(REPO, "server");
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.realmark.yaml");
const TEST_DB = path.join(SERVER, "data", "_realmark.db");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 起服务 */
function startServer() {
  return spawn(NODE, ["node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
    cwd: SERVER,
    env: { ...process.env, CONFIG_PATH: TEST_CONFIG, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitHealthy(timeoutMs = 40000) {
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

/* ------------------------------------------------------- 生成合成练习图 */
/** 在浏览器里按前端 sheetDataUrl 的版式画图：田字格 + 红色序号 + 字 */
async function makeSheet(page, glyphs) {
  return page.evaluate((chars) => {
    const gap = 12;
    const cols = Math.max(1, Math.min(chars.length <= 4 ? chars.length : 4, chars.length));
    const rows = Math.ceil(chars.length / cols);
    const maxWidth = 1600;
    let cell = 320;
    let total = cols * cell + (cols + 1) * gap;
    if (total > maxWidth) {
      cell = Math.floor((maxWidth - (cols + 1) * gap) / cols);
      total = cols * cell + (cols + 1) * gap;
    }
    const totalH = rows * cell + (rows + 1) * gap;

    const c = document.createElement("canvas");
    c.width = total;
    c.height = totalH;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, total, totalH);

    for (let i = 0; i < chars.length; i++) {
      const x = gap + (i % cols) * (cell + gap);
      const y = gap + Math.floor(i / cols) * (cell + gap);

      ctx.save();
      ctx.strokeStyle = "#D8DEE8";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, cell, cell);
      ctx.restore();

      // 田字格：虚线十字 + 淡斜线（与前端 paintGrid 一致）
      ctx.save();
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.rect(0, 0, cell, cell);
      ctx.clip();
      ctx.strokeStyle = "#E9B8B8";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 8]);
      ctx.beginPath();
      ctx.moveTo(cell / 2, 0); ctx.lineTo(cell / 2, cell);
      ctx.moveTo(0, cell / 2); ctx.lineTo(cell, cell / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = "#F2DADA";
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(cell, cell);
      ctx.moveTo(cell, 0); ctx.lineTo(0, cell);
      ctx.stroke();
      ctx.restore();

      // 字（用楷体模拟孩子写的字形）
      ctx.save();
      ctx.fillStyle = "#1A1A1A";
      ctx.font = `${Math.round(cell * 0.68)}px "KaiTi", "楷体", "STKaiti", "SimSun", serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(chars[i], x + cell / 2, y + cell / 2 + cell * 0.03);
      ctx.restore();

      // 红色序号（左上角，批量 Prompt 明确要求）
      const label = String(i + 1);
      const fz = Math.max(16, Math.round(cell * 0.1));
      ctx.save();
      ctx.font = `700 ${fz}px -apple-system, "Segoe UI", sans-serif`;
      const tw = ctx.measureText(label).width;
      const pad = Math.round(fz * 0.35);
      const bw = tw + pad * 2;
      const bh = fz + pad;
      ctx.fillStyle = "#FFE5E5";
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(x + 6, y + 6, bw, bh, 6);
        ctx.fill();
      } else {
        ctx.fillRect(x + 6, y + 6, bw, bh);
      }
      ctx.fillStyle = "#E03131";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + 6 + pad, y + 6 + bh / 2 + 1);
      ctx.restore();
    }
    return c.toDataURL("image/png");
  }, glyphs);
}

/* ------------------------------------------------------------ 判卷并等待 */
async function markAndWait(page, targets, glyphs, lessonId = null) {
  const image = await makeSheet(page, glyphs);
  const post = await page.evaluate(
    async ([t, img, lid]) => {
      const r = await fetch("/api/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: t, image: img, mode: "composite", lessonId: lid }),
      });
      return { status: r.status, json: await r.json() };
    },
    [targets, image, lessonId],
  );
  if (!post.json?.ok) return { error: post.json?.error ?? `HTTP ${post.status}` };

  const taskId = post.json.taskId;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const got = await page.evaluate(async (id) => {
      const r = await fetch(`/api/mark/${id}`);
      return (await r.json()).task;
    }, taskId);
    if (got && got.status !== "pending" && got.status !== "running") return got;
    await sleep(1200);
  }
  return { error: "判卷超时（>120s）" };
}

/* ------------------------------------------------------------------ 主流程 */
/** 测试用配置：独立 DB、独立端口，模型走 .env 里真实的 key */
const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_realmark.db }
llm:
  baseUrl: \${LLM_BASE_URL:-https://api.deepseek.com}
  apiKey: \${LLM_API_KEY}
  storyModel: \${LLM_STORY_MODEL:-deepseek-chat}
  markModel: \${LLM_MARK_MODEL:-deepseek-chat}
  suggestModel: \${LLM_SUGGEST_MODEL:-deepseek-chat}
  # 按用途的独立 provider 必须原样透传，否则隔离实例会拿「全局 baseUrl」
  # 去调判卷模型（例如 qwen 系模型挂到 deepseek 域名），必然误报失败。
  storyBaseUrl: \${LLM_STORY_BASE_URL:-}
  storyApiKey: \${LLM_STORY_API_KEY:-}
  markBaseUrl: \${LLM_MARK_BASE_URL:-}
  markApiKey: \${LLM_MARK_API_KEY:-}
  suggestBaseUrl: \${LLM_SUGGEST_BASE_URL:-}
  suggestApiKey: \${LLM_SUGGEST_API_KEY:-}
  timeoutMs: { story: 60000, mark: 90000, suggest: 45000 }
  retries: 1
  temperature: { story: 0.9, mark: 0, suggest: 0.5 }
tts:
  provider: edge
  voice: zh-CN-XiaoyiNeural
  rate: "-12%"
  cacheDir: ./data/_realmark_tts
backup:
  enabled: false
  dir: ./data/_realmark_backup
`;

let server;
let browser;
try {
  console.log("\n=== 准备隔离实例（端口 8799，独立 DB）===");
  fs.writeFileSync(TEST_CONFIG, TEST_CONFIG_YAML, "utf8");
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  server = startServer();
  const healthy = await waitHealthy();
  ok("隔离实例已就绪", healthy);
  if (!healthy) throw new Error("实例没起来，看 server/logs/app-*.log");

  const health = await (await fetch(`${BASE}/api/health`)).json();
  const markPurpose = health?.llm?.purposes?.find((p) => p.purpose === "mark");
  console.log(`  · 判卷模型 = ${markPurpose?.model} @ ${markPurpose?.baseUrl}`);
  ok("判卷模型已配置", !!markPurpose?.model, `model=${markPurpose?.model}`);
  ok("判卷模型与厂商配套（无 400 风险）", !/qwen|glm|doubao|gpt/i.test(markPurpose?.model ?? "") || !/deepseek\.com/i.test(markPurpose?.baseUrl ?? ""), `model=${markPurpose?.model} baseUrl=${markPurpose?.baseUrl}`);

  browser = await chromium.launch({
    executablePath:
      "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(`${BASE}/chinese`, { waitUntil: "domcontentloaded" });

  // —— 用例 1：写对了，必须判对
  console.log("\n=== 用例 1：目标「天」，图上写「天」→ 期望判对 ===");
  let t = await markAndWait(page, ["天"], ["天"]);
  if (t.error) {
    ok("用例 1 调用成功", false, t.error);
  } else {
    console.log(`  · 状态=${t.status} items=${JSON.stringify(t.items?.map((i) => ({ i: i.index, w: i.written, c: i.correct, s: i.score, m: i.comment })))}`);
    const it = t.items?.find((i) => i.index === 1);
    ok("写对时判定 correct=true", it?.correct === true, `实际 correct=${it?.correct} written=${it?.written}`);
    ok("认出了字（written 命中）", String(it?.written ?? "").includes("天"), `written=${it?.written}`);
  }

  // —— 用例 2：写错了，必须判错（证明模型真在看图，而不是逢写必对）
  console.log("\n=== 用例 2：目标「天」，图上写「地」→ 期望判错 ===");
  t = await markAndWait(page, ["天"], ["地"]);
  if (t.error) {
    ok("用例 2 调用成功", false, t.error);
  } else {
    console.log(`  · 状态=${t.status} items=${JSON.stringify(t.items?.map((i) => ({ i: i.index, w: i.written, c: i.correct, s: i.score, m: i.comment })))}`);
    const it = t.items?.find((i) => i.index === 1);
    ok("写错时判定 correct=false", it?.correct === false, `实际 correct=${it?.correct} written=${it?.written}`);
  }

  // —— 用例 3：一次判多个字（合成图的关键能力）
  console.log("\n=== 用例 3：目标「口 天 目」，图上写「口 天 地」→ 期望 对 对 错 ===");
  t = await markAndWait(page, ["口", "天", "目"], ["口", "天", "地"]);
  if (t.error) {
    ok("用例 3 调用成功", false, t.error);
  } else {
    console.log(`  · 状态=${t.status} items=${JSON.stringify(t.items?.map((i) => ({ i: i.index, w: i.written, c: i.correct, s: i.score })))}`);
    const by = (n) => t.items?.find((i) => i.index === n);
    ok("第 1 格（口）判对", by(1)?.correct === true, `correct=${by(1)?.correct} written=${by(1)?.written}`);
    ok("第 2 格（天）判对", by(2)?.correct === true, `correct=${by(2)?.correct} written=${by(2)?.written}`);
    ok("第 3 格（写地、目标目）判错", by(3)?.correct === false, `correct=${by(3)?.correct} written=${by(3)?.written}`);
    ok("返回条数与提交字数一致", t.items?.length === 3, `items=${t.items?.length}`);
  }

  // —— 用例 4：判卷结果要真的写进掌握度 / 错题本（前端据此更新 UI）
  console.log("\n=== 用例 4：判卷结果落库（掌握度 / 错题本）===");
  const lessons = await page.evaluate(async () => (await (await fetch("/api/lessons")).json()).lessons);
  const lessonId = lessons?.[0]?.id;
  console.log(`  · 用第 1 篇课文做落库验证 lessonId=${lessonId} title=${lessons?.[0]?.title}`);
  ok("取到了课文 id", Number.isFinite(lessonId), `lessonId=${lessonId}`);

  // 4a：写对 → 掌握度置 1
  let r4 = await markAndWait(page, ["天"], ["天"], lessonId);
  let st = await page.evaluate(async () => await (await fetch("/api/state")).json());
  const mastery = st?.mastery?.[String(lessonId)] ?? {};
  console.log(`  · 写对「天」后 mastery[${lessonId}]=${JSON.stringify(mastery)}`);
  ok("写对后掌握度记为 1", mastery["天"] === 1, `实际=${mastery["天"]}（state=${JSON.stringify(mastery)}）`);
  const wrongAfterRight = (st?.wrong?.chinese ?? []).filter((w) => w.refKey === `${lessonId}:天`);
  ok("写对后错题本里没有这个字", wrongAfterRight.length === 0, `实际 ${wrongAfterRight.length} 条`);

  // 4b：写错 → 错题本新增，掌握度置 0
  r4 = await markAndWait(page, ["目"], ["地"], lessonId);
  st = await page.evaluate(async () => await (await fetch("/api/state")).json());
  const chineseWrong = st?.wrong?.chinese ?? [];
  const hit = chineseWrong.filter((w) => w.refKey === `${lessonId}:目`);
  const mastery2 = st?.mastery?.[String(lessonId)] ?? {};
  console.log(`  · 写错「目」后 错题本(${chineseWrong.length} 条)=${JSON.stringify(chineseWrong.map((w) => ({ ref: w.refKey, ch: w.payload?.char })))}`);
  ok("写错后错题本新增该字", hit.length === 1, `命中 ${hit.length} 条`);
  ok("错题本记录了字与课文", hit[0]?.payload?.char === "目" && Number(hit[0]?.payload?.lessonId) === lessonId, `payload=${JSON.stringify(hit[0]?.payload)}`);
  ok("写错后掌握度记为 0", mastery2["目"] === 0, `实际=${mastery2["目"]}`);
} catch (e) {
  ok("执行过程无异常", false, e instanceof Error ? e.message : String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill();
    await sleep(800);
  }
  // 清理隔离实例留下的文件
  for (const f of [TEST_CONFIG, TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  for (const d of ["_realmark_tts", "_realmark_backup"]) {
    try {
      fs.rmSync(path.join(SERVER, "data", d), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`真实判卷验证：通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  console.log("=".repeat(60));
  process.exit(failures.length ? 1 : 0);
}
