/**
 * 一次性迁移：删除旧第三、四单元课文，导入新第三~八单元课文与生字。
 * 运行：npx tsx src/seed/migrate-import.ts
 * 保留第一、二单元及其掌握度（mastery）。
 */
import { closeDb, initDb, db } from "../db/index.js";
import { createLesson, replaceChars, findLessonByTitle } from "../db/repo/lessons.js";
import { SEED_LESSONS } from "./lessons.js";
import { logSeed } from "../logger.js";

const KEEP_UNITS = new Set(["第一单元", "第二单元（识字）"]);

async function main(): Promise<void> {
  await initDb();
  const d = db();

  // 1) 删除旧第三、四单元（连同生字与掌握度）
  const old = await d.all<{ id: number; title: string }>(
    "SELECT id, title FROM lessons WHERE unit IN (?, ?)",
    ["第三单元", "第四单元"],
  );
  await d.tx(async (t) => {
    for (const o of old) {
      await t.run("DELETE FROM lesson_chars WHERE lesson_id = ?", [o.id]);
      await t.run("DELETE FROM mastery WHERE lesson_id = ?", [o.id]);
      await t.run("DELETE FROM lessons WHERE id = ?", [o.id]);
    }
  });
  logSeed.info({ removed: old.map((o) => o.title) }, "已删除旧第三、四单元课文");

  // 2) 导入新第三~八单元（第一、二单元已存在，跳过）
  const maxRow = await d.get<{ m: number | null }>("SELECT MAX(sort_no) AS m FROM lessons");
  let sortNo = Number(maxRow?.m ?? 0);
  let created = 0;
  let skipped = 0;
  for (const l of SEED_LESSONS) {
    if (KEEP_UNITS.has(l.unit)) continue;
    if (await findLessonByTitle(l.title)) {
      skipped++;
      continue;
    }
    const id = await createLesson({
      title: l.title,
      unit: l.unit,
      note: l.note ?? "",
      content: l.content,
      sortNo: ++sortNo,
    });
    await replaceChars(
      id,
      l.chars.map((c) => ({ ch: c.ch, word: c.word })),
    );
    created++;
  }

  const total = await d.get<{ n: number }>("SELECT COUNT(*) AS n FROM lessons");
  const totalChars = await d.get<{ n: number }>("SELECT COUNT(*) AS n FROM lesson_chars");
  logSeed.info({ created, skipped, lessons: Number(total?.n), chars: Number(totalChars?.n) }, "迁移完成");

  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    logSeed.error({ err: e }, "迁移失败");
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
