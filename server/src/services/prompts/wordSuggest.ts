/**
 * 组词候选建议 Prompt
 *
 * 背景：课文生字的「组词」是听写消歧的关键（睛/晴、洋/阳、铜/同），
 * 但也是唯一必须人工填的字段。这里让模型一次给整篇的候选，
 * 家长点选即可，避免逐字查词典。
 */
export const SUGGEST_SYSTEM = "你是一位熟悉小学语文教材的老师，非常了解小学二年级学生的词汇量。";

export function buildWordSuggestPrompt(lessonTitle: string, chars: string[]): string {
  const list = chars.join(" ");
  return [
    `课文：${lessonTitle}`,
    `需要组词的生字：${list}`,
    "",
    "请为每个生字各给出 3 个合适的组词，要求：",
    "1. 词语必须是小学二年级学生熟悉的常用词，不要生僻、不要成语、不要超过 4 个字。",
    "2. 词语中该字的读音，必须与它在课文中这句话里的读音一致（注意多音字）。",
    "3. 优先选择能区分同音字、形近字的词（例如「睛」用「眼睛」而不是「晴朗」）。",
    "",
    "严格只输出 JSON，不要任何解释或代码块标记，键名就是生字本身：",
    '{"两":["两个","两旁","两手"],"哪":["哪里","哪儿","哪个"]}',
    `必须正好包含这 ${chars.length} 个键：${list}`,
  ].join("\n");
}

/** 解析并校验：只保留请求过的字，每个字最多 3 个候选 */
export function parseWordSuggest(raw: string, chars: string[]): Record<string, string[]> {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let data: unknown = null;
  try {
    data = JSON.parse(cleaned);
  } catch {
    const s = cleaned.indexOf("{");
    const e = cleaned.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        data = JSON.parse(cleaned.slice(s, e + 1));
      } catch {
        data = null;
      }
    }
  }
  if (!data || typeof data !== "object") return {};

  const src = data as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const ch of chars) {
    const v = src[ch];
    if (!Array.isArray(v)) continue;
    const words = v
      .map((x) => String(x).trim())
      .filter((w) => w.length >= 1 && w.length <= 6 && w.includes(ch))
      .slice(0, 3);
    if (words.length) out[ch] = Array.from(new Set(words));
  }
  return out;
}
