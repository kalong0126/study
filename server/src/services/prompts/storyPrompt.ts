/**
 * 童话生成 Prompt
 *
 * 与旧版（浏览器里那段）相比有一处实质改进：
 *   旧版让模型只输出正文，然后前端**截取正文前 12 个字当标题**——
 *   所以「标题」其实是正文开头，读起来很怪，用它做「已读去重」也不可靠。
 *   现在让模型第一行显式给出《标题》，正文从第二行开始，
 *   标题变成真标题，去重列表也有意义了。
 */

export const STORY_SYSTEM = "你是一位擅长写儿童文学的语文老师，作品专门给小学二年级学生阅读。";

export function buildStoryPrompt(avoidTitles: string[] = []): string {
  const lines = [
    "请为小学二年级学生创作一篇生动有趣的童话故事。要求：",
    "1. 字数严格控制在 500-600 字之间。",
    "2. 情节富有教育意义，语言充满童趣，多用短句，读起来朗朗上口。",
    "3. 第一行只写故事标题，用《》括起来，不超过 12 个字。",
    "4. 从第二行开始写故事正文，每段之间空一行。",
    "5. 正文直接输出纯文本，不要包含任何前言、后缀或标点符号以外的修饰语。",
    "6. 只用小学二年级学生认识的常用汉字，不要出现生僻字、英文单词、表情符号或数字。",
  ];
  const avoid = avoidTitles.filter((t) => t && !t.startsWith("示例：")).slice(-40);
  if (avoid.length) {
    lines.push("");
    lines.push(`请不要创作以下主题：[${avoid.join("、")}]`);
  }
  return lines.join("\n");
}

export interface ParsedStory {
  title: string;
  text: string;
}

/**
 * 解析模型输出。
 * 正常情况：第一行是《标题》，其余是正文。
 * 兜底：万一模型没按格式来（直接写正文），沿用旧行为——截取开头 12 字当标题。
 */
export function parseStory(raw: string): ParsedStory {
  const text = String(raw || "").trim();
  if (!text) return { title: "", text: "" };

  const lines = text.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx < 0) return { title: "", text: "" };

  const first = lines[firstIdx].trim();
  const rest = lines
    .slice(firstIdx + 1)
    .join("\n")
    .trim();

  // 形如 《小水滴的旅行》
  const m = first.match(/^[#\s]*[《【\[]?\s*([^》】\]]{1,20})\s*[》】\]]?$/);
  if (rest && first.includes("《") && m) {
    return { title: m[1].trim(), text: rest };
  }
  // 形如 "标题：小水滴的旅行"
  const m2 = first.match(/^(?:标题|题目)[:：]\s*(.+)$/);
  if (rest && m2) {
    return { title: m2[1].replace(/[《》]/g, "").trim(), text: rest };
  }

  // 兜底：模型没给标题，沿用旧版逻辑
  const flat = text.replace(/\s+/g, "");
  const title = flat.slice(0, 12) + (flat.length > 12 ? "…" : "");
  return { title, text };
}
