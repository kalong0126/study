/**
 * 建表语句（双方言）
 *
 * 字段类型选择说明：
 *   - 时间统一 VARCHAR(32)：'YYYY-MM-DD'（date）或 ISO（created_at/updated_at）
 *   - JSON 统一 TEXT：math_sets.questions、wrong_items.payload、mark_tasks.items 等
 *     本项目的 JSON 只做整体读写，不需要按内部字段查询，拆表反而增加复杂度
 *   - 布尔统一 INTEGER 0/1
 */
import {
  compositePkClause,
  idColumnDef,
  primaryKeyClause,
  tableOptions,
  uniqueClause,
  type Driver,
} from "./sql.js";

export function schemaStatements(d: Driver): string[] {
  const id = idColumnDef(d);
  const pk = primaryKeyClause(d);
  const opt = tableOptions(d);

  return [
    // ---------------- 内容：课文与生字 ----------------
    `CREATE TABLE IF NOT EXISTS lessons (
  ${id},
  title VARCHAR(200) NOT NULL,
  unit VARCHAR(100) NULL,
  sort_no INT NOT NULL DEFAULT 0,
  note TEXT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL${pk}
)${opt}`,

    `CREATE TABLE IF NOT EXISTS lesson_chars (
  ${id},
  lesson_id INT NOT NULL,
  ch VARCHAR(8) NOT NULL,
  word VARCHAR(64) NULL,
  pinyin VARCHAR(64) NULL,
  sort_no INT NOT NULL DEFAULT 0,
  hidden INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL${pk}${uniqueClause(d, "uk_lesson_sort", ["lesson_id", "sort_no"])}
)${opt}`,

    // ---------------- 主体 ----------------
    `CREATE TABLE IF NOT EXISTS children (
  ${id},
  name VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL${pk}
)${opt}`,

    // ---------------- 学习数据 ----------------
    `CREATE TABLE IF NOT EXISTS daily_progress (
  child_id INT NOT NULL,
  date VARCHAR(16) NOT NULL,
  task_key VARCHAR(32) NOT NULL,
  done INT NOT NULL DEFAULT 0,
  updated_at VARCHAR(32) NOT NULL${compositePkClause(["child_id", "date", "task_key"])}
)${opt}`,

    `CREATE TABLE IF NOT EXISTS math_sets (
  ${id},
  child_id INT NOT NULL,
  date VARCHAR(16) NOT NULL,
  questions TEXT NULL,
  results TEXT NULL,
  created_at VARCHAR(32) NOT NULL${pk}
)${opt}`,

    `CREATE TABLE IF NOT EXISTS mastery (
  child_id INT NOT NULL,
  lesson_id INT NOT NULL,
  ch VARCHAR(8) NOT NULL,
  state INT NOT NULL,
  updated_at VARCHAR(32) NOT NULL${compositePkClause(["child_id", "lesson_id", "ch"])}
)${opt}`,

    `CREATE TABLE IF NOT EXISTS wrong_items (
  ${id},
  child_id INT NOT NULL,
  type VARCHAR(16) NOT NULL,
  ref_key VARCHAR(160) NOT NULL,
  payload TEXT NULL,
  created_at VARCHAR(32) NOT NULL,
  cleared_at VARCHAR(32) NULL${pk}
)${opt}`,

    `CREATE TABLE IF NOT EXISTS stories (
  ${id},
  child_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  text TEXT NULL,
  created_at VARCHAR(32) NOT NULL${pk}
)${opt}`,

    `CREATE TABLE IF NOT EXISTS read_titles (
  child_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  created_at VARCHAR(32) NOT NULL${compositePkClause(["child_id", "title"])}
)${opt}`,

    // ---------------- 判卷留痕 ----------------
    `CREATE TABLE IF NOT EXISTS mark_tasks (
  ${id},
  child_id INT NOT NULL,
  lesson_id INT NULL,
  status VARCHAR(16) NOT NULL,
  degraded INT NOT NULL DEFAULT 0,
  items TEXT NULL,
  error TEXT NULL,
  created_at VARCHAR(32) NOT NULL,
  finished_at VARCHAR(32) NULL${pk}
)${opt}`,

    `CREATE TABLE IF NOT EXISTS mark_items (
  ${id},
  task_id INT NOT NULL,
  idx INT NOT NULL,
  target VARCHAR(8) NOT NULL,
  correct INT NULL,
  written VARCHAR(16) NULL,
  score INT NULL,
  comment TEXT NULL,
  reviewed_by VARCHAR(16) NULL${pk}
)${opt}`,

    // ---------------- 零散键值（计时器等） ----------------
    `CREATE TABLE IF NOT EXISTS app_kv (
  child_id INT NOT NULL,
  k VARCHAR(64) NOT NULL,
  v TEXT NULL,
  updated_at VARCHAR(32) NOT NULL${compositePkClause(["child_id", "k"])}
)${opt}`,
  ];
}

/**
 * 索引单独建。
 * 注意：MySQL 不支持 `CREATE INDEX IF NOT EXISTS`（8.0 之前普遍不支持），
 * 所以这里对 mysql 采用「先查再建」的方式，查询失败就忽略。
 */
export function indexStatements(d: Driver): string[] {
  if (d === "sqlite") {
    return [
      "CREATE INDEX IF NOT EXISTS idx_chars_lesson ON lesson_chars (lesson_id)",
      "CREATE INDEX IF NOT EXISTS idx_mastery_child ON mastery (child_id, lesson_id)",
      "CREATE INDEX IF NOT EXISTS idx_wrong_child ON wrong_items (child_id, type, cleared_at)",
      "CREATE INDEX IF NOT EXISTS idx_stories_child ON stories (child_id)",
      "CREATE INDEX IF NOT EXISTS idx_markitems_task ON mark_items (task_id)",
      "CREATE INDEX IF NOT EXISTS idx_daily_child ON daily_progress (child_id, date)",
    ];
  }
  return [
    "CREATE INDEX idx_chars_lesson ON lesson_chars (lesson_id)",
    "CREATE INDEX idx_mastery_child ON mastery (child_id, lesson_id)",
    "CREATE INDEX idx_wrong_child ON wrong_items (child_id, type, cleared_at)",
    "CREATE INDEX idx_stories_child ON stories (child_id)",
    "CREATE INDEX idx_markitems_task ON mark_items (task_id)",
    "CREATE INDEX idx_daily_child ON daily_progress (child_id, date)",
  ];
}
