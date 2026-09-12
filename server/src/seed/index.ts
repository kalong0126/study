/**
 * 种子数据导入
 *
 * 幂等：已存在同名课文的会跳过，所以可以放心重复执行。
 * reset=true 时会先清空 lessons 与 lesson_chars，用于「恢复出厂内容」。
 */
import { db, nowIso } from "../db/index.js";
import { createLesson, findLessonByTitle, replaceChars } from "../db/repo/lessons.js";
import { logSeed } from "../logger.js";
import { SEED_LESSONS, SEED_STATS } from "./lessons.js";

export interface SeedResult {
  created: number;
  skipped: number;
  chars: number;
  lessons: number;
}

export async function seedLessons(opts: { reset?: boolean } = {}): Promise<SeedResult> {
  const d = db();

  if (opts.reset) {
    logSeed.warn("reset=true，清空现有课文与生字");
    await d.run("DELETE FROM lesson_chars");
    await d.run("DELETE FROM mastery");
    await d.run("DELETE FROM lessons");
  }

  let created = 0;
  let skipped = 0;
  let chars = 0;

  for (let i = 0; i < SEED_LESSONS.length; i++) {
    const l = SEED_LESSONS[i];
    const existing = await findLessonByTitle(l.title);
    if (existing) {
      skipped++;
      continue;
    }
    const id = await createLesson({ title: l.title, unit: l.unit, note: l.note ?? "", sortNo: i + 1 });
    await replaceChars(
      id,
      l.chars.map((c) => ({ ch: c.ch, word: c.word })),
    );
    created++;
    chars += l.chars.length;
  }

  const total = await d.get<{ n: number }>("SELECT COUNT(*) AS n FROM lesson_chars");
  const result = { created, skipped, chars, lessons: Number(total?.n ?? 0) };
  logSeed.info(
    { created, skipped, seedLessons: SEED_STATS.lessons, seedChars: SEED_STATS.chars, totalCharsInDb: result.lessons },
    "课文种子数据导入完成",
  );
  await d.run("DELETE FROM app_kv WHERE k = 'seeded_at'");
  await d.run("INSERT INTO app_kv (child_id, k, v, updated_at) VALUES (0, 'seeded_at', ?, ?)", [
    JSON.stringify(nowIso()),
    nowIso(),
  ]);
  return result;
}
