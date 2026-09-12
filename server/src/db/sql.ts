/**
 * SQL 方言适配
 *
 * 为什么要有这层：本机开发没有 MySQL（只有 Docker 时代才有），
 * 所以数据层做成 sqlite / mysql 双驱动。两者的差异集中在这里，
 * 仓储层的写法就能完全一致。
 *
 * 统一约定（重要，影响所有仓储代码）：
 *   - 占位符一律用 `?`（mysql 与 sqlite 都支持）
 *   - 时间戳一律用 VARCHAR 存字符串（'YYYY-MM-DD' 或 ISO），避开两种库的日期类型差异
 *   - JSON 一律用 TEXT 存，应用层 JSON.parse/stringify（本项目不需要按 JSON 内部查询）
 *   - 布尔一律用 0/1 整数
 */
export type Driver = "mysql" | "sqlite";

/** 自增主键列定义（sqlite 必须写在列上，mysql 写在表尾） */
export function idColumnDef(d: Driver): string {
  return d === "mysql"
    ? "id INT NOT NULL AUTO_INCREMENT"
    : "id INTEGER PRIMARY KEY AUTOINCREMENT";
}

/** mysql 需要在表尾补 PRIMARY KEY；sqlite 已内联 */
export function primaryKeyClause(d: Driver): string {
  return d === "mysql" ? ", PRIMARY KEY (id)" : "";
}

/** 唯一约束写法 */
export function uniqueClause(d: Driver, name: string, cols: string[]): string {
  return d === "mysql"
    ? `, UNIQUE KEY ${name} (${cols.join(", ")})`
    : `, UNIQUE (${cols.join(", ")})`;
}

/** 复合主键写法 */
export function compositePkClause(cols: string[]): string {
  return `, PRIMARY KEY (${cols.join(", ")})`;
}

/** 普通索引写法 */
export function indexClause(d: Driver, name: string, cols: string[]): string {
  return d === "mysql"
    ? `, KEY ${name} (${cols.join(", ")})`
    : "";
}

/** 表尾选项：mysql 需要指定引擎与字符集，只有它要用到 utf8mb4 存中文 */
export function tableOptions(d: Driver): string {
  return d === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci" : "";
}

/**
 * 生成 upsert 语句（两种库语法不同，集中在这里处理）
 * @param cols 全部列（含冲突键）
 * @param keyCols 冲突判定用的键列
 */
export function upsertSql(d: Driver, table: string, cols: string[], keyCols: string[]): string {
  const ph = cols.map(() => "?").join(", ");
  const updates = cols.filter((c) => !keyCols.includes(c));
  if (d === "mysql") {
    // MySQL 5.7 / 8.x 均可用；8.0.20+ 只是给出 deprecate 警告，不影响功能
    const setClause = updates.map((c) => `${c}=VALUES(${c})`).join(", ");
    return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph}) ON DUPLICATE KEY UPDATE ${setClause}`;
  }
  const setClause = updates.map((c) => `${c}=excluded.${c}`).join(", ");
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph}) ON CONFLICT(${keyCols.join(", ")}) DO UPDATE SET ${setClause}`;
}

/** 0/1 ↔ boolean */
export function toBool(v: unknown): boolean {
  return v === 1 || v === true || v === "1";
}
export function toInt(v: boolean): number {
  return v ? 1 : 0;
}

/** JSON 列安全解析 */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}
