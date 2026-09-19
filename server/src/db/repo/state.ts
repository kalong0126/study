/**
 * 仓储：学习数据（打卡进度 / 口算 / 掌握度 / 错题本 / 故事 / 零散键值）
 */
import { db, nowIso, type Driver } from "../index.js";
import { parseJson, upsertSql } from "../sql.js";

const DRIVER: () => Driver = () => db().driver;
const up = (table: string, cols: string[], keys: string[]) => upsertSql(DRIVER(), table, cols, keys);

/* ------------------------------------------------------------------ 打卡进度 */

/**
 * 每日打卡任务清单。
 *
 * `language`（语言强化）与 `video`（英文故事）两项的完成标准不在本表里判：
 *   · language —— 「9 道题全做完」的真相存 `languageProgress:<date>`，
 *     由 `routes/language.ts` 的 `syncLanguageTask()` 每次作答后重算并回写这里。
 *   · video    —— 「完整看完一集」的真相存 `videoWatch:<date>`，
 *     由 `routes/video.ts` 的 `syncVideoTask()` 在播放进度上报后重算并回写。
 * 这样做的原因：这两项都由孩子分多次/在别的设备上推进，靠前端打勾容易和真实进度脱节；
 * 后端算准了再回写，换设备 / 刷新 / 前端是旧缓存都不会漏。
 */
export const TASK_KEYS = ["math", "dictation", "reading", "language", "video", "review"] as const;
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

/**
 * 当天语言强化的「题量 / 已完成数」。
 *
 * 键名与 `routes/language.ts` 里的 `setKey` / `progKey` 一致（`language:<date>` /
 * `languageProgress:<date>`），这里只读不写 —— 写入在语言强化路由里。
 *
 * 只统计**题目数组里真实存在的那些题**（而不是进度表里的条目数）：
 * 换过题、重置过之后残留的旧条目不该被算成「已完成」，
 * 否则首页会写出「已完成 9 / 9」但任务卡没有打勾这种自相矛盾的样子。
 */
export async function getLanguageProgress(
  childId: number,
  date: string,
): Promise<{ total: number; done: number }> {
  const set = await kvGet<{ questions?: { id: number }[] }>(childId, `language:${date}`);
  const questions = Array.isArray(set?.questions) ? set!.questions : [];
  const progress = (await kvGet<Record<string, { status?: string }>>(childId, `languageProgress:${date}`)) ?? {};
  const done = questions.filter((q) => progress[String(q?.id)]?.status === "done").length;
  return { total: questions.length, done };
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

/**
 * 「今天」的童话（本地时区的那一天，取最新一条；没有就返回 null）。
 *
 * 为什么按时间范围查、而不是记一个 `storyDay` 键：
 *   · `created_at` 本来就是这条记录自己的时间，不需要第二处状态去同步；
 *   · 家长在后台把今天的童话删了，这里立刻查不到、当天可以重新生成 ——
 *     记键的话就得记得在删除路径上一起清，漏一处就变成「今天永远生成不了」。
 *
 * `created_at` 是 `nowIso()` 写的 UTC ISO 串，所以边界也要换算成 UTC 再比较
 * （直接用本地日期串去比会差 8 小时，早上生成的故事会被算成昨天的）。
 */
export async function storyOfDay(childId: number, day = new Date()): Promise<StoryRow | null> {
  const d = db();
  const from = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const row = await d.get<{ id: number; title: string; text: string | null; created_at: string }>(
    "SELECT id, title, text, created_at FROM stories WHERE child_id = ? AND created_at >= ? AND created_at < ? ORDER BY id DESC LIMIT 1",
    [childId, from.toISOString(), to.toISOString()],
  );
  return row ? { id: Number(row.id), title: row.title, text: row.text ?? "", createdAt: row.created_at } : null;
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

/* ------------------------------------------------------------ 故事收藏 */
export interface StoryFav {
  id: number;
  title: string;
  /** 收藏时把正文一起存进 KV：历史故事被删之后，收藏的那篇还能照常重读 */
  text: string;
  favAt: string;
}

/** 收藏存 app_kv（`storyFavs`），最多留 50 篇 —— 孩子的收藏不会比这更多 */
const FAV_KEY = "storyFavs";
const FAVS_MAX = 50;

export async function listStoryFavs(childId: number): Promise<StoryFav[]> {
  const list = (await kvGet<StoryFav[]>(childId, FAV_KEY)) ?? [];
  return Array.isArray(list)
    ? list
        .filter((f) => f && typeof f.title === "string")
        .map((f) => ({
          id: Number(f.id) || 0,
          title: f.title,
          text: typeof f.text === "string" ? f.text : "",
          favAt: typeof f.favAt === "string" ? f.favAt : nowIso(),
        }))
    : [];
}

/** 切换收藏（按标题去重）；返回切换后的状态与最新列表 */
export async function toggleStoryFav(
  childId: number,
  story: { id: number; title: string; text: string },
): Promise<{ fav: boolean; favs: StoryFav[] }> {
  const prev = await listStoryFavs(childId);
  const kept = prev.filter((f) => f.title !== story.title);
  const wasFav = kept.length !== prev.length;
  if (wasFav) {
    return { fav: false, favs: kept };
  }
  const next = [{ id: story.id, title: story.title, text: story.text, favAt: nowIso() }, ...kept].slice(0, FAVS_MAX);
  await kvSet(childId, FAV_KEY, next);
  return { fav: true, favs: next };
}

/* -------------------------------------------------------------------- 键值 */
export async function kvGet<T>(childId: number, k: string): Promise<T | undefined> {
  const d = db();
  const row = await d.get<{ v: string | null }>("SELECT v FROM app_kv WHERE child_id = ? AND k = ?", [childId, k]);
  if (!row || row.v === null) return undefined;
  return parseJson<T | undefined>(row.v, undefined);
}

/**
 * 按前缀扫描一批 KV（LIKE 前缀匹配）。
 * 语言强化的历史题集按天散在 `language:<date>` 一串键里，「列出曾经出现过的词语」
 * 这种跨天汇总就靠它 —— 量级是几百条 JSON，一次扫完没有压力。
 */
export async function kvScan(childId: number, prefix: string): Promise<{ k: string; v: string }[]> {
  const d = db();
  const rows = await d.all<{ k: string; v: string | null }>(
    "SELECT k, v FROM app_kv WHERE child_id = ? AND k LIKE ?",
    [childId, `${prefix}%`],
  );
  return rows.filter((r): r is { k: string; v: string } => typeof r.v === "string").map((r) => ({ k: r.k, v: r.v }));
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

/* ----------------------------------------------------------- 重置（家长后台）

设计原则：
  · 保留 lessons / lesson_chars（内容数据，由「重新导入内置课文」管）
  · 保留 children 表（账号本身）
  · 保留 seeded_at 这类系统级 KV（child_id=0，不属于任何孩子）
  · 掌握度（mastery）：resetToday 只删今天动过的；resetAll 全删（回到最初，生字页无勾选）
  · 清掉其它所有「按孩子累积的学习数据」（积分 / 兑换 / 错题 / 故事 / 已读 / 判卷等）
*/
export interface ResetStats {
  daily: number;
  math: number;
  mastery: number;
  wrong: number;
  stories: number;
  reads: number;
  marks: number;
  kv: number;
  points: number;
  redemptions: number;
}

/**
 * 重置「今天」的学习数据。
 * 清：今天的任务打勾、口算题组与计时、按日期的 KV（含今天的语言强化题目与作答）、
 *     今天动过的掌握度、今天新进的错题、今天发放的积分与今天发生的兑换（余额回退到今天开始前）。
 * 保留：历史日期、历史错题、故事 / 已读标题、课文与生字、历史掌握度、历史积分与历史兑换、
 *     语言强化的历史题目（按天的键才清）。
 */
export async function resetToday(
  childId: number,
  date: string,
): Promise<Pick<ResetStats, "daily" | "math" | "mastery" | "wrong" | "kv" | "points" | "redemptions">> {
  const d = db();
  return d.tx(async (t) => {
    const c1 = await t.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM daily_progress WHERE child_id = ? AND date = ?",
      [childId, date],
    );
    const c2 = await t.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM math_sets WHERE child_id = ? AND date = ?",
      [childId, date],
    );
    await t.run("DELETE FROM daily_progress WHERE child_id = ? AND date = ?", [childId, date]);
    await t.run("DELETE FROM math_sets WHERE child_id = ? AND date = ?", [childId, date]);

    // 只清按日期生成的 KV 键，跨天键（timer / seeded_at / 系统设置 / languageRecent /
    // videoWatched）一律保留
    const dailyKeys = [
      `reviewCount:${date}`,
      `reviewTarget:${date}`,
      `mathElapsed:${date}`,
      `language:${date}`,
      `languageProgress:${date}`,
      `languageImage:${date}`,
      `videoWatch:${date}`,
    ];
    let kv = 0;
    for (const k of dailyKeys) {
      const c = await t.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM app_kv WHERE child_id = ? AND k = ?",
        [childId, k],
      );
      await t.run("DELETE FROM app_kv WHERE child_id = ? AND k = ?", [childId, k]);
      kv += Number(c?.n ?? 0);
    }

    // 撤销「今日」的积分变动：今天发放的正分流水、今天发生的兑换（负分流水 + 兑换记录）一并清掉。
    // 用 created_at 当天匹配（与 mastery 的 updated_at / wrong_items 的 created_at 同一边界），
    // 只删今天动过的，历史累积的保留。余额 = SUM(delta) 自然回退到「今天开始前」的值，
    // 也就是「总积分减去今日获取（净变化）」。
    const pc = await t.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM points_ledger WHERE child_id = ? AND created_at LIKE ?",
      [childId, `${date}%`],
    );
    await t.run("DELETE FROM points_ledger WHERE child_id = ? AND created_at LIKE ?", [childId, `${date}%`]);
    const rc = await t.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM redemptions WHERE child_id = ? AND created_at LIKE ?",
      [childId, `${date}%`],
    );
    await t.run("DELETE FROM redemptions WHERE child_id = ? AND created_at LIKE ?", [childId, `${date}%`]);

    // 今天的掌握度清掉 —— 这是听写判卷（AI / 大人审核）的成果。
    // 按 updated_at 当天匹配，只删今天动过的；之前几天点过 ✓ 的字保留下来。
    const mc = await t.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM mastery WHERE child_id = ? AND updated_at LIKE ?",
      [childId, `${date}%`],
    );
    await t.run("DELETE FROM mastery WHERE child_id = ? AND updated_at LIKE ?", [childId, `${date}%`]);

    // 今天的错题本一并清掉 —— 今天做口算/听写做错的题与字，重置后重新来过。
    // 按 created_at 当天匹配（与 mastery 的 updated_at 同一边界），只删今天新进的，历史累积的保留。
    const wc = await t.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM wrong_items WHERE child_id = ? AND created_at LIKE ?",
      [childId, `${date}%`],
    );
    await t.run("DELETE FROM wrong_items WHERE child_id = ? AND created_at LIKE ?", [childId, `${date}%`]);

    return {
      daily: Number(c1?.n ?? 0),
      math: Number(c2?.n ?? 0),
      mastery: Number(mc?.n ?? 0),
      wrong: Number(wc?.n ?? 0),
      kv,
      points: Number(pc?.n ?? 0),
      redemptions: Number(rc?.n ?? 0),
    };
  });
}

/** 清空该孩子的全部学习数据，回到最初状态。保留：lessons / lesson_chars / children 表 */
export async function resetAll(childId: number): Promise<ResetStats> {
  const d = db();
  const c = async (sql: string, params: unknown[]): Promise<number> => {
    const r = await d.get<{ n: number }>("SELECT COUNT(*) AS n FROM " + sql, params);
    return Number(r?.n ?? 0);
  };
  // 先 count（事务外只是读，不影响 delete 计数；同事务里串行即可）
  const counts = {
    daily: await c("daily_progress WHERE child_id = ?", [childId]),
    math: await c("math_sets WHERE child_id = ?", [childId]),
    wrong: await c("wrong_items WHERE child_id = ?", [childId]),
    stories: await c("stories WHERE child_id = ?", [childId]),
    reads: await c("read_titles WHERE child_id = ?", [childId]),
    marks: await c("mark_tasks WHERE child_id = ?", [childId]),
    kv: await c("app_kv WHERE child_id = ?", [childId]),
    points: await c("points_ledger WHERE child_id = ?", [childId]),
    redemptions: await c("redemptions WHERE child_id = ?", [childId]),
    // 掌握度也一并清掉：清空全部 = 回到最初状态，生字页不再有 ✓/✗ 勾选。
    mastery: await c("mastery WHERE child_id = ?", [childId]),
  };
  const markItems = await d.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM mark_items WHERE task_id IN (SELECT id FROM mark_tasks WHERE child_id = ?)",
    [childId],
  );

  await d.tx(async (t) => {
    await t.run("DELETE FROM daily_progress WHERE child_id = ?", [childId]);
    await t.run("DELETE FROM math_sets WHERE child_id = ?", [childId]);
    await t.run("DELETE FROM wrong_items WHERE child_id = ?", [childId]);
    await t.run("DELETE FROM stories WHERE child_id = ?", [childId]);
    await t.run("DELETE FROM read_titles WHERE child_id = ?", [childId]);
    await t.run(
      "DELETE FROM mark_items WHERE task_id IN (SELECT id FROM mark_tasks WHERE child_id = ?)",
      [childId],
    );
    await t.run("DELETE FROM mark_tasks WHERE child_id = ?", [childId]);
    await t.run("DELETE FROM app_kv WHERE child_id = ?", [childId]);
    await t.run("DELETE FROM points_ledger WHERE child_id = ?", [childId]);
    await t.run("DELETE FROM redemptions WHERE child_id = ?", [childId]);
    await t.run("DELETE FROM mastery WHERE child_id = ?", [childId]);
  });

  return { ...counts, marks: counts.marks + Number(markItems?.n ?? 0) };
}
