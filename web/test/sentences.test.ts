/**
 * 句子切分单元测试（纯函数，无需浏览器、无需起服务）
 *
 * 用法：从仓库根目录执行
 *   server/node_modules/.bin/tsx web/test/sentences.test.ts
 *
 * 背景：`“我不怕。”` 曾被切成 `["“我不怕。", "”"]`，孤立的 `”` 被送去 TTS 合成，
 * Edge 返回空音频 → /api/tts 503 → 前端永久降级成浏览器语音。这个测试守住这条线。
 */
import { isSpeakable, joinSentences, speakableSentences, splitSentences } from "../src/utils/sentences.ts";

let pass = 0;
const fails: string[] = [];

function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  [PASS] ${name}${extra ? "  " + extra : ""}`);
  } else {
    fails.push(name);
    console.log(`  [FAIL] ${name}${extra ? "  " + extra : ""}`);
  }
}

function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(name, g === w, g === w ? g : `得到 ${g}，期望 ${w}`);
}

console.log("\n=== A. 收尾引号必须黏在上一句 ===");
eq("“我不怕。” 不被切碎", splitSentences("“我不怕。”"), ["“我不怕。”"]);
eq("对话中两句都完整", splitSentences("他说：“行。”小蝌蚪说。"), ["他说：“行。”", "小蝌蚪说。"]);
eq("感叹号+右引号", splitSentences("“真的吗！”"), ["“真的吗！”"]);
eq("问号+右引号", splitSentences("“你是谁？”"), ["“你是谁？”"]);
eq("右括号收尾", splitSentences("（见第 3 页。）"), ["（见第 3 页。）"]);
eq("书名号收尾", splitSentences("《小蝌蚪找妈妈》很好看。"), ["《小蝌蚪找妈妈》很好看。"]);

console.log("\n=== B. 切分无损（拼回去等于原文）===");
// 注意：splitSentences 只处理「一行」。换行由调用方先切（StoryReader 用 split(/\n+/)），
// 所以拼回来时换行会被去掉 —— 这里按同样方式构造期望值。
const samples = [
  "“我不怕。”小蝌蚪说。他游啊游。",
  "……\n“妈妈，你在哪儿？”\n……",
  "好。。。嗯！",
  "第一句；第二句！第三句？",
  "没有标点的一句话",
];
for (const s of samples) {
  const lineByLine = s.split(/\n+/).flatMap((l) => splitSentences(l));
  eq(`无损：${JSON.stringify(s).slice(0, 24)}`, joinSentences(lineByLine), s.replace(/\n+/g, "").trim());
}

console.log("\n=== C. isSpeakable：纯标点/符号不算可朗读 ===");
for (const t of ["……", "…", "——", "“”", "“", "”", "，。", "、；", "！！！", "（）", " ", ""]) {
  ok(`不可朗读 ${JSON.stringify(t)}`, isSpeakable(t) === false);
}
for (const t of ["好。", "天", "abc", "第 3 页", "A1", "妈妈"]) {
  ok(`可朗读 ${JSON.stringify(t)}`, isSpeakable(t) === true);
}

console.log("\n=== D. 回归：朗读队列里不该出现纯标点片段 ===");
// 这是本次 bug 的直接回归断言。
// 设计约定：splitSentences 保留全部片段（否则故事里单独一行的 `……` 会从正文消失），
//           过滤只发生在**朗读队列**上，即 speakableSentences / isSpeakable。
const storyText = [
  "“我不怕。”小蝌蚪说。",
  "……",
  "“妈妈，你在哪儿？”他一边游一边喊。",
  "“我在这儿！”妈妈笑着回答。",
].join("\n");
const storyLines = storyText.split(/\n+/).filter((l) => l.trim());

const queue = storyLines.flatMap((l) => speakableSentences(l));
const badQueue = queue.filter((s) => !isSpeakable(s));
ok(
  "朗读队列里没有纯标点片段",
  badQueue.length === 0,
  badQueue.length ? `混入了 ${JSON.stringify(badQueue)}` : `队列共 ${queue.length} 段`,
);

// 最关键的一条：孤立的 `”` 绝不能出现在朗读队列里（本次 bug 的原始症状）
ok(
  "朗读队列里没有孤立的右引号",
  !queue.some((s) => s === "”" || s === "“"),
  JSON.stringify(queue),
);

// 展示层要保留 `……` 这一行，不能因为不能朗读就丢掉
const display = storyLines.flatMap((l) => splitSentences(l));
ok(
  "展示层保留了单独的 `……` 行",
  display.includes("……"),
  `展示共 ${display.length} 段`,
);
ok(
  "朗读队列丢掉了 `……`（不能朗读）",
  !queue.includes("……"),
);

// 旧写法的对照：证明这条正则会切出孤立右引号
eq("断言旧写法确实会切碎（对照）", "“我不怕。”".match(/[^。！？!?；;…]+[。！？!?；;…]*/g), ["“我不怕。", "”"]);

console.log("\n" + "=".repeat(56));
console.log(`句子切分测试：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  for (const f of fails) console.log(`  FAIL: ${f}`);
  console.log("=".repeat(56));
  process.exit(1);
}
console.log("=".repeat(56));
