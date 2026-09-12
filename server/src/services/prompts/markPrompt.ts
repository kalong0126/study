/**
 * 手写判卷 Prompt（批量 / 单字）
 *
 * 为什么做批量：
 *   8 个字逐字判 = 8 次多模态请求；拼成一张带序号的网格图后 = 1 次请求。
 *   成本差 8 倍，延迟也从 8×5s 降到 1×8s。
 *
 * 判定的关键取舍：**要宽松**。
 *   二年级孩子手写必然歪斜、大小不匀、笔画抖动，如果按「像不像印刷体」判，
 *   会把大量写对的字判错，反而打击孩子。所以 Prompt 里明确要求：
 *   只要字形结构正确、笔画不缺不多、能认出是那个字，就算对。
 */

export const MARK_SYSTEM =
  "你是一位有耐心的小学低年级语文老师，正在批改学生的田字格手写作业。你的判断标准是「对不对」而不是「好不好看」。";

export interface MarkItemResult {
  index: number;
  written: string;
  correct: boolean;
  score: number;
  comment: string;
}

/** 批量判卷：一张图上按序号排布了 N 个字 */
export function buildBatchMarkPrompt(targets: string[]): string {
  const list = targets.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return [
    `这是一张包含 ${targets.length} 个田字格的手写练习图，每个格子左上角标有红色序号。`,
    "请逐个判断每个格子里的手写字，是否与下面清单里对应序号的字一致：",
    "",
    list,
    "",
    "判断要求（请务必宽松，这是小学二年级学生的手写）：",
    "1. 只要字形结构正确、笔画不缺不多、能认出是目标字，就判 correct = true。",
    "2. 手写歪斜、大小不匀、笔画抖动、位置偏离中心、笔画粗细不一，都属于正常手写，不应因此判错。",
    "3. 只有写成了别的字、明显缺笔画、或格子空白，才判 correct = false。",
    "4. written 填你实际认出的那个字（如果认不出或空白，填 \"?\"）。",
    "5. score 给 0-100 的整数分；comment 用一句孩子能读懂的中文，20 字以内，写对了要鼓励，写错了要温和指出问题。",
    "",
    "严格只输出 JSON，不要任何解释、前后缀或代码块标记：",
    `{"items":[{"index":1,"written":"字","correct":true,"score":90,"comment":"写对啦，真棒"},{"index":2,"written":"字","correct":false,"score":40,"comment":"中间的横少了一笔，再写一次"}]}`,
    `items 必须正好 ${targets.length} 项，index 必须从 1 到 ${targets.length} 依次排列。`,
  ].join("\n");
}

/** 单字判卷（批量结果不合法时降级使用） */
export function buildSingleMarkPrompt(target: string): string {
  return [
    `这是一个田字格里的手写字，目标字是「${target}」。`,
    "请判断孩子写的是否就是「" + target + "」。",
    "",
    "判断要求（请务必宽松，这是小学二年级学生的手写）：",
    "1. 只要字形结构正确、笔画不缺不多、能认出是目标字，就判 correct = true。",
    "2. 手写歪斜、大小不匀、笔画抖动、位置偏离中心，都属于正常手写，不应因此判错。",
    "3. 只有写成了别的字、明显缺笔画、或格子空白，才判 correct = false。",
    "4. comment 用一句孩子能读懂的中文，20 字以内。",
    "",
    "严格只输出 JSON，不要任何解释或代码块标记：",
    '{"written":"字","correct":true,"score":90,"comment":"写对啦，真棒"}',
  ].join("\n");
}

/** 从模型输出里抠出 JSON（容忍 ```json 包裹、前后解释文字） */
export function extractJson(raw: string): unknown | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const cleaned = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* 继续尝试截取 */
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 解析批量判卷结果并做严格校验。
 * 只要数量不对或序号不连续，就返回 null —— 由调用方降级为逐字判卷。
 * 这一步是必须的：模型很容易漏项或合并项，直接按序赋值会导致「张冠李戴」。
 */
export function parseBatchMarkResult(raw: string, expectCount: number): MarkItemResult[] | null {
  const data = extractJson(raw);
  if (!data || typeof data !== "object") return null;
  const arr = (data as { items?: unknown }).items;
  if (!Array.isArray(arr) || arr.length !== expectCount) return null;

  const out: MarkItemResult[] = [];
  for (let i = 0; i < expectCount; i++) {
    const it = arr[i] as Record<string, unknown>;
    const idx = Number(it?.index);
    if (!Number.isFinite(idx) || idx !== i + 1) return null; // 序号必须严格连续
    out.push(normalizeItem(it, i + 1));
  }
  return out;
}

/** 解析单字判卷结果 */
export function parseSingleMarkResult(raw: string, expectedIndex = 1): MarkItemResult | null {
  const data = extractJson(raw);
  if (!data || typeof data !== "object") return null;
  const it = data as Record<string, unknown>;
  return normalizeItem(it, expectedIndex);
}

function normalizeItem(it: Record<string, unknown>, index: number): MarkItemResult {
  const correct = it.correct === true || it.correct === "true" || it.correct === 1;
  let score = Number(it.score);
  if (!Number.isFinite(score)) score = correct ? 90 : 40;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const writtenRaw = typeof it.written === "string" ? it.written.trim() : "";
  const written = writtenRaw ? Array.from(writtenRaw)[0] : "?";
  const comment = typeof it.comment === "string" ? it.comment.trim().slice(0, 60) : correct ? "写对啦" : "再写一次";
  return { index, written, correct, score, comment };
}

/** 家长改判 / 人工判定时构造结果项 */
export function makeManualItem(index: number, target: string, correct: boolean): MarkItemResult {
  return {
    index,
    written: correct ? target : "?",
    correct,
    score: correct ? 100 : 0,
    comment: correct ? "大人看过啦，写对了" : "大人看过了，再练一练",
  };
}
