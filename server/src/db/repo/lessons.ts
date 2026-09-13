/**
 * 仓储：课文与生字
 */
import { db, nowIso } from "../index.js";
import { charPinyin } from "../../services/pinyin.js";

export interface CharInput {
  ch: string;
  word?: string;
  pinyin?: string;
  hidden?: boolean;
}

export interface LessonChar {
  ch: string;
  word: string;
  pinyin: string;
  sortNo: number;
  hidden: boolean;
}

export interface Lesson {
  id: number;
  title: string;
  unit: string;
  note: string;
  /** 课文原文全文（第 1 页展示 + 朗读 + 生字红标用）。可能为空（家长尚未录入）。 */
  content: string;
  sortNo: number;
  chars: LessonChar[];
}

interface LessonRow {
  id: number;
  title: string;
  unit: string | null;
  note: string | null;
  content: string | null;
  sort_no: number;
}

interface CharRow {
  ch: string;
  word: string | null;
  pinyin: string | null;
  sort_no: number;
  hidden: number;
}

function mapChar(r: CharRow): LessonChar {
  return {
    ch: r.ch,
    word: r.word ?? "",
    pinyin: r.pinyin ?? "",
    sortNo: Number(r.sort_no),
    hidden: Number(r.hidden) === 1,
  };
}

export async function listLessons(withChars = true): Promise<Lesson[]> {
  const d = db();
  const rows = await d.all<LessonRow>("SELECT id, title, unit, note, content, sort_no FROM lessons ORDER BY sort_no, id");
  const lessons: Lesson[] = rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    unit: r.unit ?? "",
    note: r.note ?? "",
    content: r.content ?? "",
    sortNo: Number(r.sort_no),
    chars: [],
  }));
  if (!withChars || !lessons.length) return lessons;

  const allChars = await d.all<CharRow & { lesson_id: number }>(
    "SELECT lesson_id, ch, word, pinyin, sort_no, hidden FROM lesson_chars ORDER BY lesson_id, sort_no",
  );
  const byLesson = new Map<number, LessonChar[]>();
  for (const c of allChars) {
    const key = Number(c.lesson_id);
    if (!byLesson.has(key)) byLesson.set(key, []);
    byLesson.get(key)!.push(mapChar(c));
  }
  for (const l of lessons) l.chars = byLesson.get(l.id) ?? [];
  return lessons;
}

export async function getLesson(id: number): Promise<Lesson | undefined> {
  const d = db();
  const row = await d.get<LessonRow>("SELECT id, title, unit, note, content, sort_no FROM lessons WHERE id = ?", [id]);
  if (!row) return undefined;
  const chars = await d.all<CharRow>(
    "SELECT ch, word, pinyin, sort_no, hidden FROM lesson_chars WHERE lesson_id = ? ORDER BY sort_no",
    [id],
  );
  return {
    id: Number(row.id),
    title: row.title,
    unit: row.unit ?? "",
    note: row.note ?? "",
    content: row.content ?? "",
    sortNo: Number(row.sort_no),
    chars: chars.map(mapChar),
  };
}

export async function findLessonByTitle(title: string): Promise<Lesson | undefined> {
  const d = db();
  const row = await d.get<LessonRow>("SELECT id, title, unit, note, content, sort_no FROM lessons WHERE title = ?", [title]);
  if (!row) return undefined;
  return getLesson(Number(row.id));
}

export async function createLesson(input: {
  title: string;
  unit?: string;
  note?: string;
  content?: string;
  sortNo?: number;
}): Promise<number> {
  const d = db();
  let sortNo = input.sortNo;
  if (sortNo === undefined || sortNo === null) {
    const max = await d.get<{ m: number | null }>("SELECT MAX(sort_no) AS m FROM lessons");
    sortNo = Number(max?.m ?? 0) + 1;
  }
  const ts = nowIso();
  return d.insert(
    "INSERT INTO lessons (title, unit, note, content, sort_no, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [input.title, input.unit ?? "", input.note ?? "", input.content ?? "", sortNo, ts, ts],
  );
}

export async function updateLesson(
  id: number,
  patch: { title?: string; unit?: string; note?: string; content?: string; sortNo?: number },
): Promise<void> {
  const d = db();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.unit !== undefined) {
    sets.push("unit = ?");
    params.push(patch.unit);
  }
  if (patch.note !== undefined) {
    sets.push("note = ?");
    params.push(patch.note);
  }
  if (patch.content !== undefined) {
    sets.push("content = ?");
    params.push(patch.content);
  }
  if (patch.sortNo !== undefined) {
    sets.push("sort_no = ?");
    params.push(patch.sortNo);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  params.push(nowIso());
  params.push(id);
  await d.run(`UPDATE lessons SET ${sets.join(", ")} WHERE id = ?`, params);
}

/** 仅回填课文原文（种子数据用，避免动到其它字段） */
export async function setLessonContent(id: number, content: string): Promise<void> {
  const d = db();
  await d.run("UPDATE lessons SET content = ?, updated_at = ? WHERE id = ?", [content, nowIso(), id]);
}

export async function deleteLesson(id: number): Promise<void> {
  const d = db();
  await d.tx(async (t) => {
    await t.run("DELETE FROM lesson_chars WHERE lesson_id = ?", [id]);
    await t.run("DELETE FROM mastery WHERE lesson_id = ?", [id]);
    await t.run("DELETE FROM lessons WHERE id = ?", [id]);
  });
}

/** 用一份完整的字表替换某课的全部生字（顺序即 sort_no） */
export async function replaceChars(lessonId: number, chars: CharInput[]): Promise<void> {
  const d = db();
  const ts = nowIso();
  await d.tx(async (t) => {
    await t.run("DELETE FROM lesson_chars WHERE lesson_id = ?", [lessonId]);
    let i = 1;
    for (const c of chars) {
      const ch = String(c.ch || "").trim();
      if (!ch) continue;
      const word = (c.word ?? "").trim();
      const py = (c.pinyin || charPinyin(ch, word)).trim();
      await t.run(
        "INSERT INTO lesson_chars (lesson_id, ch, word, pinyin, sort_no, hidden, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [lessonId, ch, word, py, i++, c.hidden ? 1 : 0, ts],
      );
    }
  });
}

/**
 * 批量粘贴导入：拆字 → 去重（与已有字表比对）→ 自动注音 → 追加
 * 组词留空，由家长后续补（也可用 AI 建议接口一次生成）
 */
export async function bulkImportChars(
  lessonId: number,
  rawText: string,
): Promise<{ added: number; skipped: number; rows: LessonChar[] }> {
  const d = db();
  // 只保留汉字，其它字符（空格、逗号、换行、标点）都当分隔
  const chars = String(rawText || "")
    .split("")
    .filter((c) => /[\u4e00-\u9fa5]/.test(c));

  const existing = await d.all<{ ch: string }>("SELECT ch FROM lesson_chars WHERE lesson_id = ?", [lessonId]);
  const seen = new Set(existing.map((e) => e.ch));

  const maxRow = await d.get<{ m: number | null }>(
    "SELECT MAX(sort_no) AS m FROM lesson_chars WHERE lesson_id = ?",
    [lessonId],
  );
  let sortNo = Number(maxRow?.m ?? 0);
  const ts = nowIso();
  let added = 0;
  let skipped = 0;

  for (const ch of chars) {
    if (seen.has(ch)) {
      skipped++;
      continue;
    }
    seen.add(ch);
    sortNo++;
    const py = charPinyin(ch, "");
    await d.run(
      "INSERT INTO lesson_chars (lesson_id, ch, word, pinyin, sort_no, hidden, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
      [lessonId, ch, "", py, sortNo, ts],
    );
    added++;
  }
  await d.run("UPDATE lessons SET updated_at = ? WHERE id = ?", [nowIso(), lessonId]);

  const rows = await d.all<CharRow>(
    "SELECT ch, word, pinyin, sort_no, hidden FROM lesson_chars WHERE lesson_id = ? ORDER BY sort_no",
    [lessonId],
  );
  return { added, skipped, rows: rows.map(mapChar) };
}

/** 更新单个生字的组词（组词变了要重算拼音） */
export async function updateChar(lessonId: number, ch: string, patch: { word?: string; hidden?: boolean }): Promise<void> {
  const d = db();
  const row = await d.get<{ word: string | null }>("SELECT word FROM lesson_chars WHERE lesson_id = ? AND ch = ?", [
    lessonId,
    ch,
  ]);
  if (!row) return;
  const word = patch.word !== undefined ? patch.word.trim() : (row.word ?? "");
  const py = charPinyin(ch, word);
  const sets = ["word = ?", "pinyin = ?"];
  const params: unknown[] = [word, py];
  if (patch.hidden !== undefined) {
    sets.push("hidden = ?");
    params.push(patch.hidden ? 1 : 0);
  }
  params.push(lessonId, ch);
  await d.run(`UPDATE lesson_chars SET ${sets.join(", ")} WHERE lesson_id = ? AND ch = ?`, params);
}

/** 删除某课的某个生字（并发重整 sort_no） */
export async function deleteChar(lessonId: number, ch: string): Promise<void> {
  const d = db();
  await d.run("DELETE FROM lesson_chars WHERE lesson_id = ? AND ch = ?", [lessonId, ch]);
  const rows = await d.all<{ ch: string }>("SELECT ch FROM lesson_chars WHERE lesson_id = ? ORDER BY sort_no", [lessonId]);
  let i = 1;
  for (const r of rows) {
    await d.run("UPDATE lesson_chars SET sort_no = ? WHERE lesson_id = ? AND ch = ?", [i++, lessonId, r.ch]);
  }
}

/** 取所有课文的生字总数（健康检查用） */
export async function countChars(): Promise<number> {
  const d = db();
  const row = await d.get<{ n: number }>("SELECT COUNT(*) AS n FROM lesson_chars");
  return Number(row?.n ?? 0);
}
