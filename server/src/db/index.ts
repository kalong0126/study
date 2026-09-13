/**
 * 数据库门面：按配置选择 sqlite / mysql，对上暴露同一套 async 接口。
 *
 * 为什么要双驱动：
 *   开发机（Windows）没有 MySQL，用 sqlite 就能把「全部后端逻辑」真实跑通，
 *   部署到内网服务器时把 config.yaml 的 db.driver 改成 mysql 即可，仓储层零改动。
 *   sqlite 单文件、零运维，其实也完全适合家庭内网；mysql 适合你已有 MySQL 的情况。
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import mysql from "mysql2/promise";
import { loadConfig, type AppConfig } from "../config.js";
import { logDb } from "../logger.js";
import { indexStatements, schemaStatements } from "./schema.js";
import type { Driver } from "./sql.js";

export interface Db {
  readonly driver: Driver;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<void>;
  insert(sql: string, params?: unknown[]): Promise<number>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type { Driver } from "./sql.js";

/* ==================================================================== SQLite */
class SqliteDb implements Db {
  readonly driver = "sqlite" as const;
  private db: Database.Database;
  private cache = new Map<string, Database.Statement>();
  /** 事务互斥锁：better-sqlite3 是同步驱动，保证同一时刻只有一个事务在跑 */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
  }

  private stmt(sql: string): Database.Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.stmt(sql).all(...params) as T[];
  }
  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.stmt(sql).get(...params) as T | undefined;
  }
  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.stmt(sql).run(...params);
  }
  async insert(sql: string, params: unknown[] = []): Promise<number> {
    const r = this.stmt(sql).run(...params);
    return Number(r.lastInsertRowid);
  }
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const task = async (): Promise<T> => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const r = await fn(this);
        this.db.exec("COMMIT");
        return r;
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw e;
      }
    };
    const next = this.lock.then(task, task);
    this.lock = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    try {
      this.cache.clear();
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

/* ===================================================================== MySQL */
class MysqlDb implements Db {
  readonly driver = "mysql" as const;
  constructor(private pool: mysql.Pool) {}

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query(sql, params);
    return rows as T[];
  }
  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }
  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.pool.query(sql, params);
  }
  async insert(sql: string, params: unknown[] = []): Promise<number> {
    const [r] = await this.pool.query(sql, params);
    return Number((r as mysql.ResultSetHeader).insertId);
  }
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    const bound: Db = {
      driver: "mysql",
      all: async (s, p = []) => ((await conn.query(s, p))[0] as T[]) as never,
      get: async (s, p = []) => ((await conn.query(s, p))[0] as never[])[0] as never,
      run: async (s, p = []) => {
        await conn.query(s, p);
      },
      insert: async (s, p = []) => Number(((await conn.query(s, p))[0] as mysql.ResultSetHeader).insertId),
      exec: async (s) => {
        await conn.query(s);
      },
      tx: async () => {
        throw new Error("不支持嵌套事务");
      },
      close: async () => undefined,
    };
    try {
      await conn.beginTransaction();
      const r = await fn(bound);
      await conn.commit();
      return r;
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      conn.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

async function createMysql(cfg: AppConfig): Promise<MysqlDb> {
  const m = cfg.db.mysql;
  // 先确保库存在（用户可能只装了 MySQL 还没建库）
  try {
    const boot = await mysql.createConnection({
      host: m.host,
      port: m.port,
      user: m.user,
      password: m.password,
    });
    await boot.query(
      `CREATE DATABASE IF NOT EXISTS \`${m.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await boot.end();
  } catch (e) {
    logDb.warn({ err: e, host: m.host, port: m.port }, "建库检查失败，仍尝试直连（库可能已存在）");
  }

  const pool = mysql.createPool({
    host: m.host,
    port: m.port,
    user: m.user,
    password: m.password,
    database: m.database,
    waitForConnections: true,
    connectionLimit: m.connectionLimit,
    charset: "utf8mb4",
    dateStrings: true,
    multipleStatements: false,
  });
  // 立刻压一次连接，让配置错误在启动时就暴露
  await pool.query("SELECT 1");
  return new MysqlDb(pool);
}

/* ================================================================ 迁移与单例 */

/** 判断某张表是否已有某列（sqlite 用 PRAGMA，mysql 用 information_schema） */
async function hasColumn(d: Db, table: string, col: string): Promise<boolean> {
  if (d.driver === "sqlite") {
    const rows = await d.all<{ name: string }>(`PRAGMA table_info(${table})`);
    return rows.some((r) => r.name === col);
  }
  const rows = await d.all<{ COLUMN_NAME: string }>(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, col],
  );
  return rows.length > 0;
}

/**
 * 轻量列迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表加新列，
 * 所以后来新增的列都要在这里补 ALTER。每列只做一次（先查后加，幂等）。
 */
async function ensureColumn(d: Db, table: string, col: string, def: string): Promise<void> {
  if (await hasColumn(d, table, col)) return;
  await d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

export async function migrate(d: Db): Promise<void> {
  for (const sql of schemaStatements(d.driver)) {
    await d.exec(sql);
  }
  // —— 后续新增字段的迁移（对已存在的库补列）——
  await ensureColumn(d, "lessons", "content", "TEXT NULL");
  for (const sql of indexStatements(d.driver)) {
    try {
      await d.exec(sql);
    } catch (e) {
      const code = (e as { code?: string }).code;
      // MySQL 重复索引会抛 ER_DUP_KEYNAME，属正常
      if (code !== "ER_DUP_KEYNAME") {
        logDb.warn({ err: e, sql: sql.slice(0, 60) }, "建索引失败（可忽略）");
      }
    }
  }
}

let current: Db | null = null;

export async function initDb(): Promise<Db> {
  if (current) return current;
  const cfg = loadConfig();
  const t0 = Date.now();
  const instance = cfg.db.driver === "mysql" ? await createMysql(cfg) : new SqliteDb(cfg.db.sqlite.file);
  await migrate(instance);
  current = instance;
  logDb.info(
    {
      driver: instance.driver,
      target: instance.driver === "mysql" ? `${cfg.db.mysql.host}:${cfg.db.mysql.port}/${cfg.db.mysql.database}` : cfg.db.sqlite.file,
      ms: Date.now() - t0,
    },
    "数据库就绪",
  );
  return instance;
}

export function db(): Db {
  if (!current) throw new Error("数据库尚未初始化，请先调用 initDb()");
  return current;
}

export async function closeDb(): Promise<void> {
  if (!current) return;
  await current.close();
  current = null;
}

/** 当前时间戳字符串（统一格式，所有仓储都用它） */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 今天日期（本地时区，'YYYY-MM-DD'） */
export function todayStr(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
