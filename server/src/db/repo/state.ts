/**
 * 仓储：学习数据（打卡进度 / 口算 / 掌握度 / 错题本 / 故事 / 零散键值）
 */
import { db, nowIso, type Driver } from "../index.js";
import { parseJson, upsertSql } from "../sql.js";

const DRIVER: () => Driver = () => db().driver;
const up = (table: string, cols: string[], keys: string[]) => upsertSql(DRIVER(), table, cols, keys);

/* ------------------------------------------------------------------ 打卡进度 */
export const TASK_KEYS = ["math", "dictation", "reading", "review"] as const;
export type TaskKey = (typeof TASK_KEYS)[number];

export interface DailyState {
  date: string;
  tasks: Record<string, boolean>;
  reviewCount: number;
  /**
   * 错题复习这一轮要重做几道。三态，别用 `?? 0` 糊过去：
   *   · `null` —— 还没开闸（口算 / 听写没做完），此时不该显示「0 / 0」也不该判定完成
   *   · `0`    —— 已开闸但错题本是空的 → 不用复习，直接算完成
   *   · `n>0`  —— 需要重做 n 道
   * 开闸那一刻由前端算好并写回来（`min(3, 当时待复习的错题数)`），之后**冻结**不再变，
   * 这样分母就不会因为「边做口算边往错题本里加题」而漂移。
   */
  reviewTarget: number | null;
}

/** 错题复习一轮最多做几道 */
export const REVIEW_MAX = 3;

export async function getDaily(childId: number, date: string): Promise<DailyState> {
  const d = db();
  const rows = await d.all<{ task_key: string; done: number }>(
    "SELECT task_key, done FROM daily_progress WHERE child_id = ? AND date = ?",
    [childId, date],
  );
  const tasks: Record<string, boolean> = {};
  for (const k of TASK_KEYS) tasks[k] = false;
  for (const r of rows) tasks[r.task_key] = Number(r.done) === 1;

  const [rc, rt] = await Promise.all([
    d.get<{ v: string | null }>("SELECT v FROM app_kv WHERE child_id = ? AND k = ?", [
      childId,
      `reviewCount:${date}`,
    ]),
    kvGet<{ target: number | null }>(childId, `reviewTarget:${date}`),
  ]);

  const raw = rt?.target;
  const reviewTarget =
    raw === null || raw === undefined || !Number.isFinite(Number(raw)) ? null : Math.max(0, Math.trunc(Number(raw)));

  return { date, tasks, reviewCount: Number(rc?.v ?? 0) || 0, reviewTarget };
}

export async function setTaskDone(childId: number, date: string, key: string, done: boolean): Promise<void> {
  const d = db();
  await d.run(
    up("daily_progress", ["child_id", "date", "task_key", "done", "updated_at"], ["child_id", "date", "task_key"]),
    [childId, date, key, done ? 1 : 0, nowIso()],
  );
}

export async function setReviewCount(childId: number, date: string, n: number): Promise<void> {
  await kvSet(childId, `reviewCount:${date}`, n);
}

/**
 * 写入错题复习目标（开闸那一刻调用，之后不再动）。
 * 传 `null` 表示「回到未开闸状态」（换题组 / 重来一天时用得到）。
 */
export async function setReviewTarget(childId: number, date: string, target: number | null): Promise<void> {
  await kvSet(childId, `reviewTarget:${date}`, { target });
}

/** 待复习的错题总数（数学 + 语文，未擦除的） */
export async function countPendingWrong(childId: number): Promise<number> {
  const d = db();
  const row = await d.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM wrong_items WHERE child_id = ? AND cleared_at IS NULL",
    [childId],
  );
  return Math.max(0, Math.trunc(Number(row?.n ?? 0) || 0));
}

/* ---------------------------------------------------------------------- 口算 */
export interface MathQuestion {
  a: number;
  b: number;
  op: string;
  ans: number;
}
export interface MathSetState {
  date: string;
  qs: MathQuestion[];
  results: Record<string, string>;
}

export async function getMathSet(childId: number, date: string): Promise<MathSetState | null> {
  const d = db();
  const row = await d.get<{ questions: string | null; results: string | null }>(
    "SELECT questions, results FROM math_sets WHERE child_id = ? AND date = ? ORDER BY id DESC LIMIT 1",
    [childId, date],
  );
  if (!row) return null;
  const qs = parseJson<MathQuestion[]>(row.questions, []);
  if (!qs.length) return null;
  return { date, qs, results: parseJson<Record<string, string>>(row.results, {}) };
}

export async function insertMathSet(
  childId: number,
  date: string,
  qs: MathQuestion[],
  results: Record<string, string> = {},
): Promise<number> {
  const d = db();
  return d.insert(
    "INSERT INTO math_sets (child_id, date, questions, results, created_at) VALUES (?, ?, ?, ?, ?)",
    [childId, date, JSON.stringify(qs), JSON.stringify(results), nowIso()],
  );
}

/** 覆写当天最新一组的作答结果 */
export async function saveMathResults(childId: number, date: string, results: Record<string, string>): Promise<void> {
  const d = db();
  const row = await d.get<{ id: number }>(
    "SELECT id FROM math_sets WHERE child_id = ? AND date = ? ORDER BY id DESC LIMIT 1",
    [childId, date],
  );
  if (!row) return;
  await d.run("UPDATE math_sets SET results = ? WHERE id = ?", [JSON.stringify(results), Number(row.id)]);
}

/** 只更新单题结果（避免整组回写） */
export async function setMathResult(
  childId: number,
  date: string,
  idx: number,
  value: string,
): Promise<Record<string, string> | null> {
  const cur = await getMathSet(childId, date);
  if (!cur) return null;
  if (value) cur.results[String(idx)] = value;
  else delete cur.results[String(idx)];
  await saveMathResults(childId, date, cur.results);
  return cur.results;
}

/* --------------------------------------------------------------- 口算用时 */

/**
 * 「每日口算用时」按天存进 app_kv（键 `mathElapsed:<date>`），与 `reviewCount:<date>` 同一套路。
 *
 * 存的是**当天累计毫秒的绝对值**，服务端不做累加 —— 前端只在暂停/离开页面时回写一次总数，
 * 所以重试、重复提交都不会把时间越加越多（幂等）。
 */
export async function getMathElapsed(childId: number, date: string): Promise<number> {
  const v = await kvGet<{ ms?: number }>(childId, `mathElapsed:${date}`);
  return Math.max(0, Math.trunc(Number(v?.ms ?? 0) || 0));
}

export async function setMathElapsed(childId: number, date: string, ms: number): Promise<number> {
  // 上限 6 小时：前端时钟异常或误传时，别把「用时」写成天文数字
  const safe = Math.min(Math.max(0, Math.trunc(ms) || 0), 6 * 60 * 60 * 1000);
  await kvSet(childId, `mathElapsed:${date}`, { ms: safe });
  return safe;
}

/* ------------------------------------------------------------------ 掌握度 */
export type MasteryState = 0 | 1; // 0 = 未掌握, 1 = 已掌握

export async function getMastery(childId: number): Promise<Record<string, Record<string, MasteryState>>> {
  const d = db();
  const rows = await d.all<{ lesson_id: number; ch: string; state: number }>(
    "SELECT lesson_id, ch, state FROM mastery WHERE child_id = ?",
    [childId],
  );
  const out: Record<string, Record<string, MasteryState>> = {};
  for (const r of rows) {
    const key = String(r.lesson_id);
    if (!out[key]) out[key] = {};
    out[key][r.ch] = Number(r.state) === 1 ? 1 : 0;
  }
  return out;
}

export async function setMastery(
  childId: number,
  lessonId: number,
  ch: string,
  state: MasteryState | null,
): Promise<void> {
  const d = db();
  if (state === null) {
    await d.run("DELETE FROM mastery WHERE child_id = ? AND lesson_id = ? AND ch = ?", [childId, lessonId, ch]);
    return;
  }
  await d.run(up("mastery", ["child_id", "lesson_id", "ch", "state", "updated_at"], ["child_id", "lesson_id", "ch"]), [
    childId,
    lessonId,
    ch,
    state,
    nowIso(),
  ]);
}

/* ------------------------------------------------------------------ 错题本 */
export type WrongType = "math" | "chinese";

export interface WrongItem {
  id: number;
  type: WrongType;
  refKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function listWrong(childId: number, type?: WrongType): Promise<WrongItem[]> {
  const d = db();
  const sql = type
    ? "SELECT id, type, ref_key, payload, created_at FROM wrong_items WHERE child_id = ? AND type = ? AND cleared_at IS NULL ORDER BY id"
    : "SELECT id, type, ref_key, payload, created_at FROM wrong_items WHERE child_id = ? AND cleared_at IS NULL ORDER BY id";
  const params = type ? [childId, type] : [childId];
  const rows = await d.all<{ id: number; type: string; ref_key: string; payload: string | null; created_at: string }>(
    sql,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type as WrongType,
    refKey: r.ref_key,
    payload: parseJson<Record<string, unknown>>(r.payload, {}),
    createdAt: r.created_at,
  }));
}

/** 加入错题本；同一条（同 refKey）未消除时不重复添加 */
export async function addWrong(
  childId: number,
  type: WrongType,
  refKey: string,
  payload: Record<string, unknown> = {},
): Promise<number | null> {
  const d = db();
  const dup = await d.get<{ id: number }>(
    "SELECT id FROM wrong_items WHERE child_id = ? AND type = ? AND ref_key = ? AND cleared_at IS NULL",
    [childId, type, refKey],
  );
  if (dup) return null;
  return d.insert("INSERT INTO wrong_items (child_id, type, ref_key, payload, created_at) VALUES (?, ?, ?, ?, ?)", [
    childId,
    type,
    refKey,
    JSON.stringify(payload),
    nowIso(),
  ]);
}

export async function clearWrongById(childId: number, id: number): Promise<void> {
  const d = db();
  await d.run("UPDATE wrong_items SET cleared_at = ? WHERE child_id = ? AND id = ? AND cleared_at IS NULL", [
    nowIso(),
    childId,
    id,
  ]);
}

export async function clearWrongByRef(childId: number, type: WrongType, refKey: string): Promise<void> {
  const d = db();
  await d.run(
    "UPDATE wrong_items SET cleared_at = ? WHERE child_id = ? AND type = ? AND ref_key = ? AND cleared_at IS NULL",
    [nowIso(), childId, type, refKey],
  );
}

/** 清空某一类错题（家长后台用） */
export async function clearAllWrong(childId: number, type?: WrongType): Promise<number> {
  const d = db();
  const before = await d.get<{ n: number }>(
    type
      ? "SELECT COUNT(*) AS n FROM wrong_items WHERE child_id = ? AND type = ? AND cleared_at IS NULL"
      : "SELECT COUNT(*) AS n FROM wrong_items WHERE child_id = ? AND cleared_at IS NULL",
    type ? [childId, type] : [childId],
  );
  if (type) {
    await d.run("UPDATE wrong_items SET cleared_at = ? WHERE child_id = ? AND type = ? AND cleared_at IS NULL", [
      nowIso(),
      childId,
      type,
    ]);
  } else {
    await d.run("UPDATE wrong_items SET cleared_at = ? WHERE child_id = ? AND cleared_at IS NULL", [nowIso(), childId]);
  }
  return Number(before?.n ?? 0);
}

/* -------------------------------------------------------------- 故事与已读 */
export interface StoryRow {
  id: number;
  title: string;
  text: string;
  createdAt: string;
}

export async function listStories(childId: number, limit = 50): Promise<StoryRow[]> {
  const d = db();
  const rows = await d.all<{ id: number; title: string; text: string | null; created_at: string }>(
    "SELECT id, title, text, created_at FROM stories WHERE child_id = ? ORDER BY id DESC LIMIT ?",
    [childId, limit],
  );
  return rows.map((r) => ({ id: Number(r.id), title: r.title, text: r.text ?? "", createdAt: r.created_at }));
}

export async function addStory(childId: number, title: string, text: string): Promise<number> {
  const d = db();
  return d.insert("INSERT INTO stories (child_id, title, text, created_at) VALUES (?, ?, ?, ?)", [
    childId,
    title,
    text,
    nowIso(),
  ]);
}

export async function listReadTitles(childId: number): Promise<string[]> {
  const d = db();
  const rows = await d.all<{ title: string }>(
    "SELECT title FROM read_titles WHERE child_id = ? ORDER BY created_at",
    [childId],
  );
  return rows.map((r) => r.title);
}

/**
 * 按标题删除故事，同时把「已读主题」一并移除。
 * 前端历史列表里的删除按钮用它——删掉之后同一个主题可以再次生成。
 * 按标题（而不是 id）删除，是因为「已读主题」只按标题去重。
 */
export async function deleteStoryByTitle(childId: number, title: string): Promise<number> {
  const d = db();
  const before = await d.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM stories WHERE child_id = ? AND title = ?",
    [childId, title],
  );
  await d.run("DELETE FROM stories WHERE child_id = ? AND title = ?", [childId, title]);
  await d.run("DELETE FROM read_titles WHERE child_id = ? AND title = ?", [childId, title]);
  return Number(before?.n ?? 0);
}

export async function addReadTitle(childId: number, title: string): Promise<void> {
  const d = db();
  await d.run(up("read_titles", ["child_id", "title", "created_at"], ["child_id", "title"]), [
    childId,
    title,
    nowIso(),
  ]);
}

/* -------------------------------------------------------------------- 键值 */
export async function kvGet<T>(childId: number, k: string): Promise<T | undefined> {
  const d = db();
  const row = await d.get<{ v: string | null }>("SELECT v FROM app_kv WHERE child_id = ? AND k = ?", [childId, k]);
  if (!row || row.v === null) return undefined;
  return parseJson<T | undefined>(row.v, undefined);
}

export async function kvSet(childId: number, k: string, v: unknown): Promise<void> {
  const d = db();
  await d.run(up("app_kv", ["child_id", "k", "v", "updated_at"], ["child_id", "k"]), [
    childId,
    k,
    JSON.stringify(v),
    nowIso(),
  ]);
}
