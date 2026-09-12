/**
 * 回归测试：「结束朗读」必须结束**整条**语音，而不是只掐掉当前这一句。
 *
 * 曾经的 bug
 * ----------
 * stopAudio() 只是 pause() 当前 <audio> 元素，但 playSequence 循环里那句
 * `await playOne(...)` 还挂在半空：它要等自己的超时定时器（timeoutMs = 2500 + 字数*700，
 * 长句可达几十秒）才会 resolve。醒来后循环令牌没变，于是若无其事地读下一句 ——
 * 用户看到的就是「点了停止，停了一下又接着往后读」。
 *
 * 测试策略
 * --------
 * 真实浏览器 + 拦截 /api/tts 返回自造 WAV，精确控制「每段音频有多长」：
 *   · 控制组（1 秒短音频，不点停止）→ 断言队列**确实会**自动往后推进，证明探针有效
 *   · 回归组（30 秒长音频）→ 朗读中途点「停止朗读」，然后一直等到**旧实现的超时点之后**，
 *     断言：高亮不再出现、没有再发出任何一句新的 /api/tts 请求。
 *
 * 回归组为什么要等那么久？因为旧实现的「复活」正是发生在那个超时点上，
 * 早于它去断言就是假绿。所以先按所点句子的真实字数算出超时点，再等过去。
 *
 * 用法：node web/test/stop.mjs [baseUrl]     或   cd web && npm run test:stop
 * 依赖：playwright-core（在 workbuddy 的 node workspace 里）
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  chromium,
} = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

const BASE = process.argv[2] ?? "http://127.0.0.1:8788";
const OUT = path.resolve("web/test/shots");
mkdirSync(OUT, { recursive: true });

let passed = 0;
let failed = 0;

function ok(label, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}${extra ? `（${extra}）` : ""}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${extra ? `（${extra}）` : ""}`);
  }
}

function step(name) {
  console.log(`\n=== ${name} ===`);
}

/** 造一段静音 WAV（8kHz / 8bit / 单声道），用来精确控制「这一段音频有多长」 */
function silentWav(seconds) {
  const sampleRate = 8000;
  const samples = Math.max(1, Math.round(sampleRate * seconds));
  const buf = Buffer.alloc(44 + samples, 128);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + samples, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28); // byteRate
  buf.writeUInt16LE(1, 32); // blockAlign
  buf.writeUInt16LE(8, 34); // bitsPerSample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(samples, 40);
  return buf;
}

const WAV_SHORT = silentWav(1); // 会自然播完 → 队列必须往后走
const WAV_LONG = silentWav(30); // 整场都播不完 → 只能靠「停止」收尾

let serveLong = false;
let ttsHits = 0;

/** 页面探针：句子列表 + 当前高亮 + 按钮状态。注意剥离 <rt> 拼音 */
const PROBE = () => {
  const strip = (el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll("rt").forEach((r) => r.remove());
    return (c.textContent || "").replace(/\s+/g, "");
  };
  const all = [...document.querySelectorAll(".story-text .sent")];
  const texts = all.map(strip);
  const cur = document.querySelector(".story-text .sent.cur");
  const i = cur ? all.indexOf(cur) : -1;
  return {
    total: all.length,
    curIndex: i,
    curText: i >= 0 ? texts[i] : "",
    lens: texts.map((t) => t.length),
    speakable: texts.map((t) => /[\p{L}\p{N}]/u.test(t)),
    stopBtn: [...document.querySelectorAll("button")].some(
      (b) => /停止朗读/.test(b.innerText) && !b.disabled,
    ),
  };
};

/** 轮询直到「高亮下标 === want」或超时；返回实际下标（-1 = 没有高亮） */
async function untilIndex(want, timeoutMs, intervalMs = 100) {
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < timeoutMs) {
    last = (await page.evaluate(PROBE)).curIndex;
    if (last === want) return last;
    await page.waitForTimeout(intervalMs);
  }
  return last;
}

/** 轮询直到「高亮下标 > start」或超时；返回实际下标（-1 = 没等到） */
async function untilAdvanced(start, timeoutMs, intervalMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const i = (await page.evaluate(PROBE)).curIndex;
    if (i > start) return i;
    await page.waitForTimeout(intervalMs);
  }
  return -1;
}

const browser = await chromium.launch({
  executablePath:
    "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
const page = await context.newPage();

// 屏蔽真实 TTS：所有请求回自造 WAV，并统计请求次数（这是「有没有继续往后读」的旁证）
await page.route("**/api/tts**", async (route) => {
  ttsHits += 1;
  await route.fulfill({
    status: 200,
    contentType: "audio/wav",
    body: serveLong ? WAV_LONG : WAV_SHORT,
  });
});

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

console.log(`朗读停止回归 → ${BASE}`);

/* ———————————————————————————— 0. 载入示例故事（不花 token）
 */
step("0. 载入示例故事");
await page.goto(`${BASE}/story`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.locator("button", { hasText: "试读示例故事" }).first().click();
await page.waitForTimeout(800);
const base = await page.evaluate(PROBE);
ok("示例故事已渲染出句子", base.total >= 5, `${base.total} 句`);
if (base.total < 5) {
  console.log("\n示例故事没出来，后续断言无法进行。");
  await browser.close();
  process.exit(1);
}

// 挑两个最短的可朗读句：超时点最小 → 测试等待最短；且两句不同 → 第二句必然要新发一次请求
const ranked = base.lens
  .map((len, i) => ({ len, i }))
  .filter((x) => base.speakable[x.i] && x.len > 0)
  .sort((a, b) => a.len - b.len);
ok("找到足够的可朗读句", ranked.length >= 2, `最短 ${ranked[0]?.len} 字 / 次短 ${ranked[1]?.len} 字`);
const A = ranked[0];
const B = ranked[1];
const timeoutOf = (len) => 2500 + len * 700; // 复刻 useAudio 里的超时估算

/* ———————————————————————————— 1. 控制组：不点停止时，队列确实会自动往后推进
 */
step("1. 控制组：正常朗读会自动往后推进（校准探针）");
serveLong = false;
await page.locator(".story-text .sent").nth(A.i).click();
const started = await untilIndex(A.i, 6000);
ok("点句子后开始朗读并高亮", started === A.i, `高亮 index=${started}`);
const advanced = await untilAdvanced(A.i, 10000);
ok("控制组：队列自动推进到下一句（探针有效）", advanced > A.i, `推进到 index=${advanced}`);
await page.locator("button", { hasText: "停止朗读" }).first().click();
await page.waitForTimeout(400);
const afterCtrl = await page.evaluate(PROBE);
ok("控制组收尾：点停止后高亮清空", afterCtrl.curIndex === -1);

/* ———————————————————————————— 2. 回归组：朗读中途点「停止」，整条队列必须立刻作废
 */
step("2. 回归组：朗读中途点「停止朗读」→ 不应再继续往后读");
serveLong = true; // 这一句 30 秒都播不完，任何「继续往后读」都只能来自超时定时器
ttsHits = 0;
await page.locator(".story-text .sent").nth(B.i).click();
const playing = await untilIndex(B.i, 6000);
ok("起播（高亮落在被点的句子上）", playing === B.i, `index=${playing}`);
ok("起播确实新发了一次 TTS 请求（请求计数探针有效）", ttsHits === 1, `hits=${ttsHits}`);

await page.waitForTimeout(900); // 稳稳处在「正在朗读这一句」的中间
const hitsBeforeStop = ttsHits;
const stateBeforeStop = await page.evaluate(PROBE);
ok("停止前确实在朗读", stateBeforeStop.stopBtn === true && stateBeforeStop.curIndex === B.i);

await page.locator("button", { hasText: "停止朗读" }).first().click();
await page.waitForTimeout(500);
const justStopped = await page.evaluate(PROBE);
ok("点停止后高亮立刻消失", justStopped.curIndex === -1, `curIndex=${justStopped.curIndex}`);
ok("点停止后按钮变回「朗读故事」", justStopped.stopBtn === false);
ok("停止瞬间没有新的 TTS 请求", ttsHits === hitsBeforeStop, `新增 ${ttsHits - hitsBeforeStop} 次`);

// 关键等待：必须跨过「旧实现的复活时刻」，否则是假绿
const waitMs = timeoutOf(B.len) + 3000;
console.log(
  `  · 等待 ${Math.round(waitMs / 1000)}s（跨过旧实现对该句的超时点 ${Math.round(
    timeoutOf(B.len) / 1000,
  )}s）…`,
);
await page.waitForTimeout(waitMs);

const after = await page.evaluate(PROBE);
ok(
  "停止后不再自动继续朗读（没有高亮冒出来）",
  after.curIndex === -1,
  `curIndex=${after.curIndex}${after.curText ? ` 文本=「${after.curText}」` : ""}`,
);
ok(
  "停止后没有发出任何新的 TTS 请求（没有偷偷读下一句）",
  ttsHits === hitsBeforeStop,
  `停止后新增 ${ttsHits - hitsBeforeStop} 次`,
);
ok("停止后按钮仍停在「朗读故事」", after.stopBtn === false);
ok("停止后句子总数不变（视图没被破坏）", after.total === base.total, `${after.total} 句`);
await page.screenshot({ path: path.join(OUT, "stop-after.png") });

/* ———————————————————————————— 3. 停止之后仍能重新开始
 */
step("3. 停止之后重新朗读仍然可用");
serveLong = false;
await page.locator("button", { hasText: "朗读故事" }).first().click();
const restarted = await untilIndex(0, 8000);
ok("重新朗读可以立即从第一句开始", restarted === 0, `高亮 index=${restarted}`);
await page.locator("button", { hasText: "停止朗读" }).first().click();
await page.waitForTimeout(500);
const back = await page.evaluate(PROBE);
ok("再次停止后高亮也清空", back.curIndex === -1);

/* ———————————————————————————— 4. 控制台
 */
step("4. 控制台");
ok("零 console error / 零未捕获异常", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();

console.log(`\n${"=".repeat(52)}`);
console.log(`朗读停止回归：${passed} 通过 / ${failed} 失败`);
console.log(`${"=".repeat(52)}`);
process.exit(failed === 0 ? 0 : 1);
