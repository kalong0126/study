/**
 * 命令行导入种子数据
 *   npm run seed            仅导入缺失的课文（幂等）
 *   npm run seed -- --reset 清空后重新导入
 */
import { closeDb, initDb } from "../db/index.js";
import { logSeed } from "../logger.js";
import { seedLessons } from "./index.js";

const reset = process.argv.includes("--reset");

initDb()
  .then(async () => {
    const r = await seedLessons({ reset });
    logSeed.info(r, reset ? "种子数据已重置" : "种子数据导入完成");
    await closeDb();
    process.exit(0);
  })
  .catch(async (e) => {
    logSeed.error({ err: e }, "种子数据导入失败");
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
