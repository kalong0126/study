/**
 * 备份与恢复
 *
 * 数据从浏览器搬进数据库后，「备份」从可选项变成了必需项：
 * 以前浏览器里至少还有一份，现在服务器坏了就全没了。
 *
 * 两条路径：
 *   1. 定时全量备份（默认每天凌晨 3 点，保留 30 天）
 *   2. 手动导出 / 恢复（含**兼容老版单文件 HTML 的 localStorage 导出格式**）
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { db, nowIso } from "../db/index.js";
import { findLessonByTitle, listLessons } from "../db/repo/lessons.js";
import { addReadTitle, addStory, addWrong, insertMathSet, setMastery, setReviewCount, setTaskDone } from "../db/repo/state.js";
import { logBackup } from "../logger.js";
import { parseJson, upsertSql } from "../db/sql.js";

export const BACKUP_APP = "grade2-server";
export const BACKUP_VERSION = 2;
/** 老版单文件 HTML 的导出标识 */
export const LEGACY_APP = "grade2-workbench";

export interface BackupPack {
  app: string;
  version: number;
  exportedAt: string;
  childId: number;
  data: Record<string, unknown>;
}

/* ------------------------------------------------------------------ 导出 */
export async function exportAll(childId: number): Promise<BackupPack> {
  const d = db();
  const [lessons, daily, mathSets, mastery, wrong, stories, readTitles, kv] = await Promise.all([
    d.all("SELECT id, title, unit, note, sort_no, created_at, updated_at FROM lessons ORDER BY sort_no, id"),
    d.all("SELECT date, task_key, done, updated_at FROM daily_progress WHERE child_id = ?", [childId]),
    d.all("SELECT date, questions, results, created_at FROM math_sets WHERE child_id = ? ORDER BY id", [childId]),
    d.all("SELECT lesson_id, ch, state, updated_at FROM mastery WHERE child_id = ?", [childId]),
    d.all(
      "SELECT type, ref_key, payload, created_at, cleared_at FROM wrong_items WHERE child_id = ? ORDER BY id",
      [childId],
    ),
    d.all("SELECT title, text, created_at FROM stories WHERE child_id = ? ORDER BY id", [childId]),
    d.all("SELECT title, created_at FROM read_titles WHERE child_id = ?", [childId]),
    d.all("SELECT k, v, updated_at FROM app_kv WHERE child_id = ?", [childId]),
  ]);

  const chars = await d.all<Record<string, unknown>>(
    "SELECT lesson_id, ch, word, pinyin, sort_no, hidden FROM lesson_chars ORDER BY lesson_id, sort_no",
  );

  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: nowIso(),
    childId,
    data: { lessons, lessonChars: chars, daily, mathSets, mastery, wrong, stories, readTitles, kv },
  };
}

export async function writeBackupFile(pack: BackupPack): Promise<{ file: string; bytes: number }> {
  const cfg = loadConfig();
  await fs.promises.mkdir(cfg.backup.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(cfg.backup.dir, `backup-${stamp}.json`);
  const json = JSON.stringify(pack);
  await fs.promises.writeFile(file, json, "utf8");
  logBackup.info({ file, kb: Math.round(json.length / 1024) }, "备份文件已生成");
  return { file, bytes: json.length };
}

export async function listBackupFiles(): Promise<{ file: string; bytes: number; mtime: number }[]> {
  const cfg = loadConfig();
  try {
    const names = await fs.promises.readdir(cfg.backup.dir);
    const out: { file: string; bytes: number; mtime: number }[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const full = path.join(cfg.backup.dir, n);
      const st = await fs.promises.stat(full);
      out.push({ file: n, bytes: st.size, mtime: st.mtimeMs });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

export async function cleanupOldBackups(): Promise<number> {
  const cfg = loadConfig();
  const files = await listBackupFiles();
  const cutoff = Date.now() - cfg.backup.keepDays * 86400_000;
  let removed = 0;
  for (const f of files) {
    if (f.mtime < cutoff) {
      try {
        await fs.promises.unlink(path.join(cfg.backup.dir, f.file));
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  if (removed) logBackup.info({ removed }, "清理了过期备份");
  return removed;
}

/** 执行一次完整备份（定时或手动触发） */
export async function runBackup(childId: number): Promise<{ file: string; bytes: number }> {
  const pack = await exportAll(childId);
  const r = await writeBackupFile(pack);
  await cleanupOldBackups();
  return r;
}

/* ------------------------------------------------------------------ 恢复 */
export interface RestoreSummary {
  format: "server" | "legacy";
  lessons?: number;
  chars?: number;
  mastery: number;
  wrong: number;
  stories: number;
  readTitles: number;
  mathSets: number;
  daily: number;
  skipped: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 从备份恢复。
 * 自动识别两种格式：
 *   - grade2-server  v2：本服务自己的全量备份
 *   - grade2-workbench v1：老版单文件 HTML 的导出（含课文标题 → lessonId 的映射）
 */
export async function restorePack(
  childId: number,
  pack: unknown,
  opts: { mode?: "merge" | "replace"; skipDemo?: boolean } = {},
): Promise<RestoreSummary> {
  if (!isPlainObject(pack)) throw new Error("备份文件格式不正确（不是 JSON 对象）");
  const app = String(pack.app ?? "");
  const summary: RestoreSummary = {
    format: app === LEGACY_APP ? "legacy" : "server",
    mastery: 0,
    wrong: 0,
    stories: 0,
    readTitles: 0,
    mathSets: 0,
    daily: 0,
    skipped: [],
  };

  if (app === LEGACY_APP) {
    return restoreLegacy(childId, pack, opts, summary);
  }
  if (app === BACKUP_APP) {
    return restoreServer(childId, pack, opts, summary);
  }
  throw new Error(`无法识别的备份文件（app="${app}"）。请选择「导出 JSON 备份」生成的文件。`);
}

async function restoreLegacy(
  childId: number,
  pack: Record<string, unknown>,
  opts: { mode?: "merge" | "replace"; skipDemo?: boolean },
  summary: RestoreSummary,
): Promise<RestoreSummary> {
  const d = db();
  const data = (pack.data ?? {}) as Record<string, unknown>;
  const skipDemo = opts.skipDemo !== false; // 默认跳过示例数据

  if (opts.mode === "replace") {
    await d.tx(async (t) => {
      await t.run("DELETE FROM daily_progress WHERE child_id = ?", [childId]);
      await t.run("DELETE FROM math_sets WHERE child_id = ?", [childId]);
      await t.run("DELETE FROM mastery WHERE child_id = ?", [childId]);
      await t.run("DELETE FROM wrong_items WHERE child_id = ?", [childId]);
      await t.run("DELETE FROM stories WHERE child_id = ?", [childId]);
      await t.run("DELETE FROM read_titles WHERE child_id = ?", [childId]);
    });
  }

  // ---- 打卡 ----
  const daily = data.daily as { date?: string; tasks?: Record<string, boolean>; reviewCount?: number } | undefined;
  if (daily?.date) {
    const tasks = daily.tasks ?? {};
    for (const [k, v] of Object.entries(tasks)) {
      await setTaskDone(childId, daily.date, k, v === true);
      summary.daily++;
    }
    if (typeof daily.reviewCount === "number") await setReviewCount(childId, daily.date, daily.reviewCount);
  }

  // ---- 口算 ----
  const mathSet = data.mathSet as { date?: string; qs?: unknown[]; results?: Record<string, string> } | undefined;
  if (mathSet?.date && Array.isArray(mathSet.qs) && mathSet.qs.length) {
    const dup = await d.get<{ n: number }>("SELECT COUNT(*) AS n FROM math_sets WHERE child_id = ? AND date = ?", [
      childId,
      mathSet.date,
    ]);
    if (Number(dup?.n ?? 0) === 0) {
      await insertMathSet(childId, mathSet.date, mathSet.qs as never, mathSet.results ?? {});
      summary.mathSets++;
    }
  }

  // ---- 掌握度（老数据的 key 是「课文标题」，要映射成 lessonId）----
  const mastery = data.mastery;
  if (isPlainObject(mastery)) {
    for (const [title, map] of Object.entries(mastery)) {
      const lesson = await findLessonByTitle(title);
      if (!lesson) {
        summary.skipped.push(`掌握度：找不到课文「${title}」`);
        continue;
      }
      if (!isPlainObject(map)) continue;
      for (const [ch, st] of Object.entries(map)) {
        await setMastery(childId, lesson.id, ch, Number(st) === 1 ? 1 : 0);
        summary.mastery++;
      }
    }
  }

  // ---- 错题本 ----
  const wrong = data.wrong as { math?: unknown[]; chinese?: unknown[] } | undefined;
  if (wrong?.math && Array.isArray(wrong.math)) {
    for (const it of wrong.math) {
      if (!isPlainObject(it)) continue;
      if (skipDemo && it.demo === true) continue;
      const text = String(it.text ?? "").trim();
      if (!text) continue;
      await addWrong(childId, "math", text, { text, ans: Number(it.ans ?? 0) });
      summary.wrong++;
    }
  }
  if (wrong?.chinese && Array.isArray(wrong.chinese)) {
    for (const it of wrong.chinese) {
      if (!isPlainObject(it)) continue;
      if (skipDemo && it.demo === true) continue;
      const ch = String(it.char ?? "").trim();
      if (!ch) continue;
      const title = String(it.lesson ?? "");
      const lesson = title ? await findLessonByTitle(title) : undefined;
      if (title && !lesson) summary.skipped.push(`错字「${ch}」：找不到课文「${title}」`);
      const lessonId = lesson?.id ?? 0;
      await addWrong(childId, "chinese", `${lessonId}:${ch}`, { char: ch, lessonId });
      summary.wrong++;
    }
  }

  // ---- 故事 ----
  const stories = data.stories as { readTitles?: unknown[]; history?: unknown[] } | undefined;
  if (stories?.readTitles && Array.isArray(stories.readTitles)) {
    for (const t of stories.readTitles) {
      const title = String(t ?? "").trim();
      if (!title || (skipDemo && title.startsWith("示例："))) continue;
      await addReadTitle(childId, title);
      summary.readTitles++;
    }
  }
  if (stories?.history && Array.isArray(stories.history)) {
    for (const it of stories.history) {
      if (!isPlainObject(it)) continue;
      const title = String(it.title ?? "").trim();
      if (!title || (skipDemo && it.demo === true)) continue;
      const dup = await d.get<{ id: number }>("SELECT id FROM stories WHERE child_id = ? AND title = ? LIMIT 1", [
        childId,
        title,
      ]);
      if (dup) continue;
      // 老格式的 history 只存了标题与日期，正文没有——补一条占位便于看到历史列表
      await addStory(childId, title, String(it.text ?? ""));
      summary.stories++;
    }
  }

  logBackup.info({ ...summary, childId }, "从老版备份恢复完成");
  return summary;
}

async function restoreServer(
  childId: number,
  pack: Record<string, unknown>,
  opts: { mode?: "merge" | "replace"; skipDemo?: boolean },
  summary: RestoreSummary,
): Promise<RestoreSummary> {
  const d = db();
  const data = (pack.data ?? {}) as Record<string, unknown>;

  // ---- 内容：课文与生字 ----
  const lessons = Array.isArray(data.lessons) ? (data.lessons as Record<string, unknown>[]) : [];
  const chars = Array.isArray(data.lessonChars) ? (data.lessonChars as Record<string, unknown>[]) : [];
  if (lessons.length) {
    if (opts.mode === "replace") {
      await d.run("DELETE FROM lesson_chars");
      await d.run("DELETE FROM lessons");
    }
    const idMap = new Map<number, number>();
    /** 备份里已存在的课文：不动它的生字，避免覆盖家长后来改过的组词 */
    const keepExistingChars = new Set<number>();

    for (const l of lessons) {
      const title = String(l.title ?? "").trim();
      if (!title) continue;
      const existing = await findLessonByTitle(title);
      if (existing) {
        idMap.set(Number(l.id), existing.id);
        keepExistingChars.add(Number(l.id));
        continue;
      }
      const newId = await d.insert(
        "INSERT INTO lessons (title, unit, note, sort_no, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          title,
          String(l.unit ?? ""),
          String(l.note ?? ""),
          Number(l.sort_no ?? 0),
          String(l.created_at ?? nowIso()),
          nowIso(),
        ],
      );
      idMap.set(Number(l.id), newId);
      summary.lessons = (summary.lessons ?? 0) + 1;
    }

    for (const c of chars) {
      const oldLesson = Number(c.lesson_id);
      if (keepExistingChars.has(oldLesson)) continue;
      const newLesson = idMap.get(oldLesson);
      if (!newLesson) continue;
      // 用 upsert：重复执行恢复不会因为 UNIQUE(lesson_id, sort_no) 而中断
      await d.run(
        upsertSql(
          d.driver,
          "lesson_chars",
          ["lesson_id", "ch", "word", "pinyin", "sort_no", "hidden", "created_at"],
          ["lesson_id", "sort_no"],
        ),
        [
          newLesson,
          String(c.ch ?? ""),
          String(c.word ?? ""),
          String(c.pinyin ?? ""),
          Number(c.sort_no ?? 0),
          Number(c.hidden ?? 0),
          nowIso(),
        ],
      );
      summary.chars = (summary.chars ?? 0) + 1;
    }
  }

  if (opts.mode === "replace") {
    await d.run("DELETE FROM daily_progress WHERE child_id = ?", [childId]);
    await d.run("DELETE FROM math_sets WHERE child_id = ?", [childId]);
    await d.run("DELETE FROM mastery WHERE child_id = ?", [childId]);
    await d.run("DELETE FROM wrong_items WHERE child_id = ?", [childId]);
    await d.run("DELETE FROM stories WHERE child_id = ?", [childId]);
    await d.run("DELETE FROM read_titles WHERE child_id = ?", [childId]);
  }

  for (const r of (data.daily ?? []) as Record<string, unknown>[]) {
    await setTaskDone(childId, String(r.date), String(r.task_key), Number(r.done) === 1);
    summary.daily++;
  }
  for (const r of (data.mathSets ?? []) as Record<string, unknown>[]) {
    const date = String(r.date);
    const qs = parseJson<unknown[]>(r.questions, []);
    if (!qs.length) continue;
    // merge 模式下同一天只保留一份，避免重复恢复堆出多组题
    const dup = await d.get<{ n: number }>("SELECT COUNT(*) AS n FROM math_sets WHERE child_id = ? AND date = ?", [
      childId,
      date,
    ]);
    if (Number(dup?.n ?? 0) > 0) continue;
    await insertMathSet(childId, date, qs as never, parseJson<Record<string, string>>(r.results, {}));
    summary.mathSets++;
  }
  for (const r of (data.mastery ?? []) as Record<string, unknown>[]) {
    await setMastery(childId, Number(r.lesson_id), String(r.ch), Number(r.state) === 1 ? 1 : 0);
    summary.mastery++;
  }
  for (const r of (data.wrong ?? []) as Record<string, unknown>[]) {
    if (r.cleared_at) continue; // 已消除的不再导回
    const type = r.type === "math" ? "math" : "chinese";
    await addWrong(childId, type, String(r.ref_key), parseJson<Record<string, unknown>>(r.payload, {}));
    summary.wrong++;
  }
  for (const r of (data.stories ?? []) as Record<string, unknown>[]) {
    const title = String(r.title ?? "").trim();
    if (!title) continue;
    const dup = await d.get<{ id: number }>("SELECT id FROM stories WHERE child_id = ? AND title = ? LIMIT 1", [
      childId,
      title,
    ]);
    if (dup) continue; // 同标题不重复导入
    await addStory(childId, title, String(r.text ?? ""));
    summary.stories++;
  }
  for (const r of (data.readTitles ?? []) as Record<string, unknown>[]) {
    await addReadTitle(childId, String(r.title));
    summary.readTitles++;
  }

  logBackup.info({ ...summary, childId }, "从服务端备份恢复完成");
  return summary;
}

/* -------------------------------------------------------------- 定时备份 */
const CRON_RE = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/;

/** 算出下一次触发时间（支持 "M H * * *" 形式的每日定时） */
export function nextRunAt(cron: string, from = new Date()): Date | null {
  const m = CRON_RE.exec(cron);
  if (!m) return null;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) return null;
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

let backupTimer: NodeJS.Timeout | null = null;

export function scheduleDailyBackup(childIdProvider: () => Promise<number>): void {
  const cfg = loadConfig();
  if (!cfg.backup.enabled) {
    logBackup.info("备份已禁用（backup.enabled = false）");
    return;
  }
  const plan = (): void => {
    const next = nextRunAt(cfg.backup.cron);
    if (!next) {
      logBackup.warn({ cron: cfg.backup.cron }, "backup.cron 格式不支持（需形如 \"0 3 * * *\"），自动备份未启用");
      return;
    }
    const delay = Math.max(1000, next.getTime() - Date.now());
    logBackup.info({ next: next.toISOString(), inMinutes: Math.round(delay / 60000) }, "已安排下一次自动备份");
    backupTimer = setTimeout(async () => {
      try {
        const childId = await childIdProvider();
        await runBackup(childId);
      } catch (e) {
        logBackup.error({ err: e }, "自动备份失败");
      }
      plan();
    }, delay);
    if (typeof backupTimer.unref === "function") backupTimer.unref();
  };
  plan();
}

export function stopDailyBackup(): void {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = null;
}
