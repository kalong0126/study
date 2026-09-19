/**
 * 「英文故事」端到端回归测试（内网共享视频 + Range 播放 + 完整看完打卡）
 *
 * 覆盖点：
 *   1. 目录扫描：能列出子目录里的视频、按集号自然排序
 *   2. 抽片：同一天反复进来给的是同一集（刷新 / 换设备不跳片）
 *   3. Range 分段：200 全量 / 206 区间 / 416 越界 —— 浏览器靠这个才能拖进度条
 *   4. 路径穿越防护：`..`、绝对路径、非白名单扩展名一律 400
 *   5. 「换一个」：换到别的集，且**当天已完成的打卡不会被抹掉**
 *   6. 计分：实看 < 90% 时长不给分；≥ 90% 才打卡 + 10 分，且重复上报不重复发
 *   7. 真实播放链路：点播放 → 播到结尾 → 卡片出现「看完啦 +10 分」
 *   8. 首页：「英文故事」是清单里的一项待办，做完自动打勾（顶栏分母 6 项）
 *   9. 全程零 console error
 *
 * 为什么用隔离实例（端口 8801 + 独立 DB + 临时视频目录）：
 *   这个测试会真的抽片、真的上报进度、真的发积分，跑在孩子的真实库上会污染数据。
 *
 * 为什么视频文件用 **wav** 而不是 mp4：
 *   我们要验的是「后端按 Range 切字节 → 浏览器能解码播放 → 前端累加实看秒数 → 打卡发分」
 *   这条链路，而 mp4 需要真正的编码器（不引入 ffmpeg）。WAV 是浏览器原生可解码的容器，
 *   用 8 秒静音 PCM 当样本既不占空间也不花时间，`timeupdate` / `ended` 都会真实触发 ——
 *   比伪造 DOM 事件更可信。所以这个测试的配置把 `.wav` 加进了 `video.exts`。
 *
 * 用法：node web/test/video.mjs      或   cd web && npm run test:video
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

// 仓库根用「脚本自身位置」推，而不是 cwd —— `npm run` 时 cwd 是 web/
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(REPO, "server");
const PORT = 8801;
const MOCK_PORT = 8802;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.videotest.yaml");
const TEST_DB = path.join(SERVER, "data", "_videotest.db");
const VIDEO_DIR = path.join(SERVER, "data", "_videotest_videos");
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

const SHOTS = path.join(REPO, "web", "test", "shots");

/* ------------------------------------------------------- 测试样本视频 */

/**
 * 生成一段静音 PCM WAV。
 * `video.exts` 里加了 `.wav`，`mimeOf` 也认 `.wav` → `audio/wav`，
 * 所以 Chrome 能真的解出时长并播到结尾（`ended` 真事件）。
 */
function wavSilence(seconds, rate = 8000) {
  const n = seconds * rate; // 8bit 单声道 = 每采样 1 字节
  const buf = Buffer.alloc(44 + n, 0x80); // 0x80 = 8bit PCM 的静音
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); // byteRate
  buf.writeUInt16LE(1, 32); // blockAlign
  buf.writeUInt16LE(8, 34); // bitsPerSample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n, 40);
  return buf;
}

/** 三集样本：两集在根目录，一集在子目录（顺带验证 maxDepth 与自然排序） */
const FILES = [
  { rel: "Ep 1.wav", sec: 8 },
  { rel: "Ep 2.wav", sec: 8 },
  { rel: path.join("season2", "E10.wav"), sec: 6 },
];

function makeVideoDir() {
  fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
  for (const f of FILES) {
    const abs = path.join(VIDEO_DIR, f.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, wavSilence(f.sec));
  }
}

/* ------------------------------------------------------- 隔离实例的配置 */
// video.dir 指向临时目录；exts 加上 .wav（见文件头说明）
const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_videotest.db }
llm:
  baseUrl: https://api.deepseek.com
  apiKey: test-key-not-used
  storyModel: mock-story
  storyBaseUrl: http://127.0.0.1:${MOCK_PORT}/v1
  storyApiKey: test-key-for-mock
  markModel: mock-mark
  suggestModel: mock-story
  timeoutMs: { story: 60000, mark: 90000, suggest: 45000 }
  retries: 0
  temperature: { story: 0.9, mark: 0, suggest: 0.5 }
tts:
  provider: edge
  voice: zh-CN-XiaoyiNeural
  rate: "-12%"
  cacheDir: ./data/_videotest_tts
imagegen:
  enabled: false
  model: mock-image
  baseUrl: http://127.0.0.1:${MOCK_PORT}/__image
  apiKey: test-key-for-image
  size: 1328*1328
  dir: ./data/_videotest_images
  timeoutMs: 20000
video:
  enabled: true
  dir: ./data/_videotest_videos
  exts: [.wav, .mp4]
  maxDepth: 2
backup:
  enabled: false
  dir: ./data/_videotest_backup
`;

function startMock() {
  return spawn(NODE, ["node_modules/tsx/dist/cli.mjs", "test/mock-llm.ts"], {
    cwd: SERVER,
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

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

/** 方便起见：GET / POST JSON */
const get = async (p) => (await fetch(`${BASE}/api${p}`)).json();
const post = async (p, body) => {
  const r = await fetch(`${BASE}/api${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");

let mock;
let server;
let browser;
let page;

fs.mkdirSync(SHOTS, { recursive: true });
const shot = (name) => page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {});

/** 和前端 store 一样按天算；这里只用来给「过去某天」的接口测试造数据 */
const PAST = "2019-05-05";

try {
  console.log(`\n=== 准备隔离实例（端口 ${PORT} + 临时视频目录 + 独立 DB）===`);
  makeVideoDir();
  fs.writeFileSync(TEST_CONFIG, TEST_CONFIG_YAML, "utf8");
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  mock = startMock();
  server = startServer();
  const healthy = await waitHealthy();
  ok("隔离实例已就绪", healthy);
  if (!healthy) throw new Error("实例没起来，看 server/logs/app-*.log");

  /* ————————————————————————————— 1. 扫描与抽片（纯接口） */
  step("1. 目录扫描与抽片");
  const t1 = await get("/video/today");
  ok("读到 3 个视频（含子目录里的那一集）", t1.total === 3, `total=${t1.total} problem=${t1.problem}`);
  ok("problem 为空（共享正常）", !t1.problem, String(t1.problem));
  ok("给出了当天要播的一集", !!t1.item && !!t1.item.id, JSON.stringify(t1.item));
  ok("片名 = 文件名去掉扩展名", t1.item?.title === t1.item?.name.replace(/\.[^.]+$/, ""), `${t1.item?.title} / ${t1.item?.name}`);
  ok("抽到的确实是目录里的一集（含子目录那一集）", ["Ep 1", "Ep 2", "E10"].includes(t1.item?.title), String(t1.item?.title));
  ok("watch.hasItem 为 true", t1.watch?.hasItem === true);
  ok("三集都没看过时 unwatched = 3", t1.unwatched === 3, String(t1.unwatched));

  const t1b = await get("/video/today");
  ok("同一天再进来还是同一集（不跳片）", t1b.item?.id === t1.item?.id, `${t1b.item?.id} vs ${t1.item?.id}`);

  const rs = await post("/video/rescan", {});
  ok("重扫仍是 3 个", rs.json.total === 3, JSON.stringify(rs.json));

  /* ————————————————————————————— 2. Range 分段 */
  step("2. 视频流 + HTTP Range");
  // 当天抽到哪一集是**随机的**（`pickVideoItem` 用 `Math.floor(rnd()*n)`），
  // 所以基准文件必须从抽到的这一集推，不能写死 "Ep 1.wav" ——
  // 写死的话，抽到 Ep 2 / E10 的那一天，下面五条字节数断言会集体假失败
  // （现象是 served 48044 vs disk 64044，看着像 Range 实现坏了，其实抽的不是同一集）。
  // 接口只回 `{id,title,name,ext,sizeMB}`（`publicItem` 不吐相对路径），
  // 所以按服务端同一套编解码把 id 还原成相对路径；反过来也顺带验了 id ↔ 文件是对得上的。
  const rel = Buffer.from(String(t1.item.id), "base64url").toString("utf8");
  const pickedAbs = path.join(VIDEO_DIR, ...rel.split("/"));
  ok("id 解出来就是抽到的那一集的文件", fs.existsSync(pickedAbs), `${rel} → ${pickedAbs}`);
  const size = fs.statSync(pickedAbs).size;
  const full = await fetch(`${BASE}/api/video/stream/${t1.item.id}`);
  ok("不带 Range → 200", full.status === 200, `status=${full.status}`);
  ok("声明 Accept-Ranges: bytes", full.headers.get("accept-ranges") === "bytes");
  ok("Content-Type 是 audio/wav（配的 .wav 有对应 MIME）", full.headers.get("content-type") === "audio/wav", String(full.headers.get("content-type")));
  ok("Content-Length = 文件大小", Number(full.headers.get("content-length")) === size, `${full.headers.get("content-length")} vs ${size}`);
  const fullBuf = Buffer.from(await full.arrayBuffer());
  ok("整份字节数对得上", fullBuf.length === size, `${fullBuf.length} vs ${size}`);
  ok("确实是 WAV（RIFF 开头）", fullBuf.subarray(0, 4).toString("ascii") === "RIFF", fullBuf.subarray(0, 4).toString("ascii"));

  const part = await fetch(`${BASE}/api/video/stream/${t1.item.id}`, { headers: { Range: "bytes=0-99" } });
  ok("Range: bytes=0-99 → 206", part.status === 206, `status=${part.status}`);
  ok("Content-Range 正确", part.headers.get("content-range") === `bytes 0-99/${size}`, String(part.headers.get("content-range")));
  ok("只回了 100 字节", (await part.arrayBuffer()).byteLength === 100);

  const tail = await fetch(`${BASE}/api/video/stream/${t1.item.id}`, { headers: { Range: "bytes=-50" } });
  ok("Range: bytes=-50 → 206 且是最后 50 字节", tail.status === 206 && tail.headers.get("content-range") === `bytes ${size - 50}-${size - 1}/${size}`, String(tail.headers.get("content-range")));

  const over = await fetch(`${BASE}/api/video/stream/${t1.item.id}`, { headers: { Range: "bytes=99999999-" } });
  ok("越界 Range → 416", over.status === 416, `status=${over.status}`);
  ok("416 带 Content-Range: bytes */size", over.headers.get("content-range") === `bytes */${size}`, String(over.headers.get("content-range")));

  /* ————————————————————————————— 3. 路径穿越防护 */
  step("3. 路径穿越 / 非法标识防护");
  for (const [label, rel] of [
    ["相对穿越 ../secret.wav", "../secret.wav"],
    ["绝对路径 /etc/passwd.wav", "/etc/passwd.wav"],
    ["Windows 盘符 C:/x.wav", "C:/x.wav"],
    ["非白名单扩展名 notes.txt", "notes.txt"],
  ]) {
    const r = await fetch(`${BASE}/api/video/stream/${b64url(rel)}`);
    ok(`${label} → 400`, r.status === 400, `status=${r.status}`);
  }

  /* ————————————————————————————— 4. 上报：不到 90% 不给分 */
  step("4. 实看不足 90% 不打卡不发分");
  const past = await get(`/video/today?date=${PAST}`);
  const pastId = past.item?.id;
  ok("拿到「过去某天」要播的那一集", !!pastId);

  const ign = await post("/video/progress", { date: PAST, id: "bogus-id", watchedSec: 999, durationSec: 100, ended: true });
  ok("上报的不是当天在播的那一集 → ignored（不当报错）", ign.json.ignored === true, JSON.stringify(ign.json));

  const low = await post("/video/progress", { date: PAST, id: pastId, watchedSec: 50, durationSec: 100, ended: false });
  ok("实看 50% → 不算看完", low.json.watch?.complete === false, JSON.stringify(low.json.watch));
  ok("实看 50% → 任务没打勾", low.json.daily?.tasks?.video === false, JSON.stringify(low.json.daily?.tasks));
  ok("实看 50% → 不加分", low.json.balance === 0, `balance=${low.json.balance}`);

  const still = await get("/points");
  ok("/api/points 余额仍为 0", still.balance === 0, `balance=${still.balance}`);

  /* ————————————————————————————— 5. 真实播放 → 看完 → +10 */
  step("5. 浏览器里真的播到结尾");
  browser = await chromium.launch({
    executablePath: "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    args: ["--no-sandbox", "--mute-audio", "--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(`${BASE}/video`, { waitUntil: "networkidle" });
  await page.waitForSelector(".vplayer", { timeout: 20000 });
  ok("渲染出播放器", (await page.locator("video.vplayer").count()) === 1);

  const vinfo = await page.locator("video.vplayer").evaluate((el) => ({
    src: el.getAttribute("src"),
    playsinline: el.hasAttribute("playsinline"),
  }));
  ok("视频源走后端转发接口", String(vinfo.src).includes("/api/video/stream/"), String(vinfo.src));
  ok("带 playsinline（iOS 不全屏劫持）", vinfo.playsinline === true);
  ok("显示片名", (await page.locator(".vtitle").innerText()).trim().length > 0);
  ok("暂停时盖着大播放按钮", (await page.locator(".vbig").count()) === 1);
  ok("有「换一个」按钮", (await page.locator("button", { hasText: "换一个" }).count()) === 1);
  ok("开始时显示「实看 0%」", /实看\s*0%/.test((await page.locator(".vmeta").innerText()).replace(/\s+/g, " ")), await page.locator(".vmeta").innerText());
  await shot("vd-01-start.png");

  // 等元数据加载出来（duration 真值），再点播放
  await page.waitForFunction(() => {
    const v = document.querySelector("video.vplayer");
    return !!v && Number.isFinite(v.duration) && v.duration > 0;
  }, null, { timeout: 20000 });
  const dur = await page.locator("video.vplayer").evaluate((el) => el.duration);
  ok("浏览器解出了真实时长（说明 wav 是有效媒体）", dur > 4, `duration=${dur}`);

  await page.locator("button.vplay").first().click();
  await page.waitForFunction(() => !document.querySelector(".vbig"), null, { timeout: 8000 }).catch(() => {});
  ok("点播放后进入播放态（大按钮收起）", (await page.locator(".vbig").count()) === 0);
  await shot("vd-02-playing.png");

  // 播到结尾：8 秒的片子 + 上报/打卡余量
  await page.waitForSelector(".vdone", { timeout: 40000 });
  const doneText = (await page.locator(".vdone").innerText()).replace(/\s+/g, " ");
  ok("播完出现「看完啦 +10 分」角标", /看完啦.*10\s*分/.test(doneText), doneText);

  const played = await page.locator("video.vplayer").evaluate((el) => ({ t: el.currentTime, d: el.duration, ended: el.ended }));
  ok("确实播到了结尾（ended 事件真实触发）", played.ended === true, JSON.stringify(played));
  const meta = (await page.locator(".vmeta").innerText()).replace(/\s+/g, " ");
  ok("显示这一集已算完成", meta.includes("这一集已经算完成"), meta);
  await shot("vd-03-done.png");

  /* ————————————————————————————— 5b. 播放器外框 + 铺满内容区 + 一屏放得下 */
  /* 2026-09-19 用户两轮反馈：①「没有外框包围、不像嵌在页面里」；②「窗口没有铺满整个内容 div」。
     修法：浅色机身外框（.vt 包 .vscreen）+ 按屏幕形状分两套排布（竖屏上下排 / 横屏左右分栏）。
     下面这几条守住它，别再退回「深色 video 直接铺满白卡」或「居中窄缝、两边留白」。 */
  step("5b. 外框 + 铺满内容区 + 一屏放得下");
  ok("视频装在 .vscreen 里（机身包住屏幕）", (await page.locator(".vt > .vscreen > video.vplayer").count()) === 1);
  const frame = await page.locator(".vt").evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      pad: parseFloat(cs.paddingTop),
      border: parseFloat(cs.borderTopWidth),
      radius: parseFloat(cs.borderTopLeftRadius),
      w: Math.round(r.width),
    };
  });
  ok(
    "外框看得见（有内边距 + 描边 + 大圆角）",
    frame.pad >= 6 && frame.border >= 1 && frame.radius >= 16,
    JSON.stringify(frame),
  );
  const screenAspect = await page.locator(".vscreen").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return Math.round((r.width / r.height) * 100) / 100;
  });
  ok("屏幕仍是 16:9", Math.abs(screenAspect - 16 / 9) < 0.02, String(screenAspect));

  // 2026-09-19 第二轮反馈：收窄居中之后横屏平板上机身只占卡片四成宽、两边全是空白
  // （用户原话「窗口没有铺满整个内容 div」）。所以宽屏改成左右分栏：名字与进度条挪到右边一列，
  // 播放器吃满左栏。下面按「用户的平板 1080×700 / 常见 1280×800 / 竖屏 900×1200」三种尺寸守住它。
  // ⚠️ 「一屏放得下」现在量的是**整页**（documentElement）：同日定的规则③已经把 .wrap 从
  //    滚动容器改回普通块了，再量 `wrap.scrollHeight - wrap.clientHeight` 会永远等于 0（假绿）。
  const probe = async (w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
    return page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.querySelector(".vbody");
      const stage = document.querySelector(".vstage").getBoundingClientRect();
      const vt = document.querySelector(".vt").getBoundingClientRect();
      const side = document.querySelector(".vside").getBoundingClientRect();
      const range = document.querySelector(".vrange").getBoundingClientRect();
      return {
        bodyDisplay: getComputedStyle(body).display,
        stageW: Math.round(stage.width),
        vtW: Math.round(vt.width),
        vtRight: Math.round(vt.right),
        vtBottom: Math.round(vt.bottom),
        sideLeft: Math.round(side.left),
        sideW: Math.round(side.width),
        rangeW: Math.round(range.width),
        need: doc.scrollHeight - window.innerHeight,
        vh: window.innerHeight,
      };
    });
  };

  // ① 用户那台平板（横屏、可用高度只有 ~700px）
  const land = await probe(1080, 700);
  ok("横屏平板走左右分栏（.vbody 变 flex）", land.bodyDisplay === "flex", JSON.stringify(land));
  ok("播放器铺满左栏（≥ 左栏 95%）", land.vtW >= land.stageW * 0.95, JSON.stringify(land));
  ok("播放器明显变宽（不再是四成窄缝）", land.vtW >= 560, JSON.stringify(land));
  ok("横屏平板一屏放得下（整页不滚）", land.need <= 1, JSON.stringify(land));
  ok("控件排在播放器右边、不重叠", land.sideLeft >= land.vtRight + 10, JSON.stringify(land));
  // 进度条是 input（inline-block），width:auto 会退回 ~130px 的短条 —— 分栏里必须占满右栏
  ok("进度条占满右栏（不是一小截短条）", land.rangeW >= land.sideW * 0.95, JSON.stringify(land));
  await shot("vd-06-frame-landscape.png");

  // ② 常见 1280×800：也不能撑出滚动条
  const wide = await probe(1280, 800);
  ok("1280×800 一屏放得下（整页不滚）", wide.need <= 1, JSON.stringify(wide));
  ok("1280×800 播放器仍在首屏内", wide.vtBottom < wide.vh, JSON.stringify(wide));

  // ③ 竖屏平板：回到上下排，且播放器占满内容宽度
  const port = await probe(900, 1200);
  ok("竖屏回到上下排（单栏）", port.bodyDisplay === "block", JSON.stringify(port));
  ok("竖屏时播放器铺满内容宽（不再左右留白）", port.vtW >= port.stageW * 0.98, JSON.stringify(port));
  ok("竖屏一屏放得下（整页不滚）", port.need <= 1, JSON.stringify(port));

  /* ————————————————————————————— 6. 打卡与积分落库 */
  step("6. 打卡 + 10 分（后端为准）");
  const pts = await get("/points");
  ok("完整看完一集 → 加 10 分", pts.balance === 10, `balance=${pts.balance}`);
  const st = await get("/state");
  ok("「英文故事」打卡已打勾", st.daily?.tasks?.video === true, JSON.stringify(st.daily?.tasks));

  // 再报一次（模拟暂停 / 切页 / 重载后的重复上报）→ 不能重复加分
  const again = await post("/video/progress", { date: st.date, id: t1.item.id, watchedSec: 99, durationSec: 100, ended: true });
  ok("重复上报不重复发分（按天幂等）", again.json.balance === 10, `balance=${again.json.balance}`);
  ok("重复上报仍保持已看完", again.json.watch?.complete === true);

  /* ————————————————————————————— 7. 「换一个」不抹掉已完成 */
  step("7. 换一个：换片但保留今天的完成");
  await page.locator("button", { hasText: "换一个" }).first().click();
  await page.waitForTimeout(1500);
  const title2 = (await page.locator(".vtitle").innerText()).trim();
  ok("换到了别的一集", title2.length > 0 && title2 !== t1.item.title, `${title2} vs ${t1.item.title}`);
  ok("换片后「看完啦」角标仍在（complete 当天不回退）", (await page.locator(".vdone").count()) === 1);
  const pts2 = await get("/points");
  ok("换片不重复发分", pts2.balance === 10, `balance=${pts2.balance}`);
  await shot("vd-04-next.png");

  /* ————————————————————————————— 8. 首页那一座岛 */
  step("8. 首页「英文小屋」已通关");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const card = (await page.locator("button.isle", { hasText: "英文小屋" }).first().innerText()).replace(/\s+/g, " ");
  ok("首页地图上有「英文小屋」这一座", card.includes("英文小屋"), card);
  // 判据是「岛带 done 类 + 状态胶囊写已通关」。别再找「已完成」——
  // 岛上那一行小字已按产品要求删掉，只剩岛名 + 一颗状态胶囊（见 HomeView 的 isle-flag）。
  const done = page.locator("button.isle.done", { hasText: "英文小屋" });
  const flag = (await done.count())
    ? (await done.locator(".isle-flag").first().innerText()).replace(/\s+/g, " ")
    : "(没找到处于已通关状态的英文小屋)";
  ok("做完后这座岛变成「已通关」", /已通关/.test(flag), flag);
  const cardCount = await page.locator("button.isle").count();
  ok("首页小岛地图共 6 座", cardCount === 6, `${cardCount} 座`);
  const headPill = (await page.locator(".stat-pill").first().innerText()).replace(/\s+/g, " ");
  ok("顶栏任务分母是 6 项", /\/ 6 项任务/.test(headPill), headPill);
  await shot("vd-05-home.png");

  /* ————————————————————————————— 9. 控制台 */
  step("9. 控制台");
  ok("零 console error / 零未捕获异常", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
} catch (e) {
  ok("执行过程无异常", false, e instanceof Error ? e.message : String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const p of [server, mock]) {
    if (p) p.kill();
  }
  await sleep(800);
  for (const f of [TEST_CONFIG, TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  for (const d of ["_videotest_videos", "_videotest_tts", "_videotest_backup", "_videotest_images"]) {
    try {
      fs.rmSync(path.join(SERVER, "data", d), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`英文故事回归：通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  console.log("=".repeat(60));
  process.exit(failures.length ? 1 : 0);
}
