/**
 * 句子切分（朗读队列 + 注音渲染共用）
 *
 * —— 为什么需要这个文件 ——
 *
 * 原来的断句正则是「非句末标点 + 句末标点」两段拼接（`[^。！？!?；;…]+[。！？!?；;…]*`），
 * **收尾引号没有算作句末标点**，于是：
 *
 *     “我不怕。”   →   切成 ["“我不怕。", "”"] 两段
 *
 * 那个孤立的 `”` 会被当成「一句话」排进朗读队列。Edge TTS 对**纯标点**输入返回空音频，
 * 接口于是 503；前端判定「后端 TTS 不可用」后降级用浏览器语音兜底，
 * 孩子就再也听不到原来的小女孩音色了（而且那个 `”` 还会被渲染成一个独立的可点句子）。
 *
 * 实测（本机）：`……` `“”` `——` `…` `“` `”` `，。` 全部 503，`好。` 正常 200。
 *
 * 所以这里做两件事：
 *   1. **收尾符号必须黏在上一句**（右引号、右括号、书名号收尾等），不能自成一段；
 *   2. 提供 `isSpeakable()`，用来把「没有可发音字符」的片段挡在合成之前。
 */

/** 句末标点：碰到这些字符就该断句 */
const END_CHARS = "。！？!?；;…";

/**
 * 收尾符号：出现在这些字符后面时，说明句子还没真正结束（引语、括号、书名号收尾），
 * 必须跟着上一句一起走。
 * 注意只放**右半边**符号 —— 左引号/左括号不该被黏到上一句末尾。
 */
const CLOSE_CHARS = "”’」』〕〗】》〉）］｝»\"'";

/** 正则字符类内需要转义的字符 */
function reEscape(chars: string): string {
  return chars.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}

/** 断句：非句末标点的连续段 + 紧跟其后的句末标点/收尾符号 */
const SPLIT_RE = new RegExp(`[^${reEscape(END_CHARS)}]+[${reEscape(END_CHARS + CLOSE_CHARS)}]*`, "g");

/** 至少含一个「能发音的字符」（任意语言的字母或数字）才算有意义的一段 */
const SPEAKABLE_RE = /[\p{L}\p{N}]/u;

/**
 * 这段文本有没有可朗读的内容？
 * 纯标点 / 纯空白 / 纯符号 → false，不该送去 TTS 合成。
 */
export function isSpeakable(text: string): boolean {
  return SPEAKABLE_RE.test(String(text ?? ""));
}

/**
 * 切句。返回的片段**只为展示与朗读服务**，不会丢弃纯标点片段
 * （否则故事里单独一行的 `……` 会从正文里消失）。
 * 朗读前请自行用 `isSpeakable()` 过滤。
 */
export function splitSentences(text: string): string[] {
  const src = String(text ?? "").trim();
  if (!src) return [];
  const parts = src.match(SPLIT_RE);
  if (!parts) return [src];
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t) out.push(t);
  }
  return out.length ? out : [src];
}

/** 只取可朗读的句子（朗读队列用） */
export function speakableSentences(text: string): string[] {
  return splitSentences(text).filter(isSpeakable);
}

/** 把切好的句子拼回去（验证切分是否无损） */
export function joinSentences(sentences: string[]): string {
  return sentences.join("");
}
