/**
 * 日志层
 *
 * 需求：家长平时的排查入口就是「后台日志」，所以格式必须一眼能看懂。
 * 输出示例：
 *   [2026-09-12 21:30:11.123] INFO  [llm]  童话生成成功 model=deepseek-chat ms=4231 chars=582
 *   [2026-09-12 21:30:12.456] INFO  [tts]  合成完成 text="眼睛" voice=zh-CN-XiaoyiNeural cache=MISS ms=812
 *   [2026-09-12 21:30:15.789] ERROR [llm] 大模型调用失败 kind=timeout msg="请求超时"
 *
 * 三个出口：stdout（带颜色）、按天文件、内存环形缓冲（供 /api/diag/logs 读取）
 */
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { loadConfig, SERVER_ROOT, type AppConfig } from "./config.js";

export interface LogRecord {
  ts: number;
  level: string;
  mod: string;
  msg: string;
  fields: Record<string, unknown>;
}

const RING_MAX = 600;
const ring: LogRecord[] = [];

/* ------------------------------------------------------------------ 颜色 */
const C = {
  reset: "\u001b[0m",
  dim: "\u001b[90m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  bold: "\u001b[1m",
};
const LEVEL_COLOR: Record<string, string> = {
  trace: C.dim,
  debug: C.cyan,
  info: C.green,
  warn: C.yellow,
  error: C.red,
  fatal: `${C.bold}${C.red}`,
};

/* -------------------------------------------------------------- 格式化 */
function pad2(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad2(d.getMilliseconds(), 3)}`
  );
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "string") {
    return /[\s"=\\]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Error) return `"${v.message}"`;
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch {
    return String(v);
  }
}

/** 把一条日志渲染成单行文本 */
export function formatRecord(rec: LogRecord, color = false): string {
  const lvl = rec.level.toUpperCase().padEnd(5);
  const modTag = rec.mod ? `[${rec.mod}]`.padEnd(7) : " ".repeat(7);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rec.fields)) {
    if (k === "mod" || k === "level" || k === "time" || k === "msg") continue;
    parts.push(`${k}=${renderValue(v)}`);
  }
  const tail = parts.length ? `  ${parts.join(" ")}` : "";
  const head = `[${fmtTime(rec.ts)}]`;
  const msg = rec.msg || "";
  if (!color) return `${head} ${lvl} ${modTag} ${msg}${tail}`;
  const lc = LEVEL_COLOR[rec.level] ?? "";
  return (
    `${C.dim}${head}${C.reset} ` +
    `${lc}${lvl}${C.reset} ` +
    `${C.magenta}${modTag}${C.reset} ` +
    `${msg}${C.dim}${tail}${C.reset}`
  );
}

/* --------------------------------------------------------- 按天轮转文件 */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

class DailyFileWriter {
  private stream: fs.WriteStream | null = null;
  private date = "";

  constructor(
    private readonly dir: string,
    private readonly prefix: string,
    private readonly keepDays: number,
  ) {
    this.rotateIfNeeded();
    const t = setInterval(() => this.rotateIfNeeded(), 60_000);
    if (typeof t.unref === "function") t.unref();
  }

  private rotateIfNeeded(): void {
    const d = todayKey();
    if (d === this.date && this.stream) return;
    try {
      this.stream?.end();
    } catch {
      /* ignore */
    }
    fs.mkdirSync(this.dir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(this.dir, `${this.prefix}-${d}.log`), { flags: "a" });
    this.stream.on("error", () => {
      /* 磁盘写失败不应拖垮服务 */
      this.stream = null;
    });
    this.date = d;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.keepDays <= 0) return;
    try {
      const cutoff = Date.now() - this.keepDays * 86400_000;
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.startsWith(`${this.prefix}-`) || !f.endsWith(".log")) continue;
        const full = path.join(this.dir, f);
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      }
    } catch {
      /* ignore */
    }
  }

  write(line: string): void {
    if (!this.stream) this.rotateIfNeeded();
    try {
      this.stream?.write(`${line}\n`);
    } catch {
      /* ignore */
    }
  }

  flush(): void {
    try {
      this.stream?.end();
    } catch {
      /* ignore */
    }
    this.stream = null;
  }
}

/* ----------------------------------------------------------- 组装 logger */
function buildLogger(cfg: AppConfig): pino.Logger {
  const file = new DailyFileWriter(cfg.logging.dir, "app", cfg.logging.keepDays);
  const wantColor = process.stdout.isTTY === true || process.env.FORCE_COLOR === "1";

  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      try {
        const obj = JSON.parse(chunk.toString()) as Record<string, unknown>;
        const rec: LogRecord = {
          ts: typeof obj.time === "number" ? obj.time : Date.now(),
          level: typeof obj.level === "string" ? obj.level.toLowerCase() : "info",
          mod: typeof obj.mod === "string" ? obj.mod : "",
          msg: typeof obj.msg === "string" ? obj.msg : "",
          fields: obj,
        };
        ring.push(rec);
        if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
        process.stdout.write(`${formatRecord(rec, wantColor)}\n`);
        file.write(formatRecord(rec, false));
      } catch {
        /* 格式化失败就别把服务搞崩 */
      }
      cb();
    },
  });

  return pino(
    {
      level: cfg.logging.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.epochTime,
      messageKey: "msg",
      redact: { paths: cfg.logging.redact, censor: "[Redacted]" },
      serializers: { err: pino.stdSerializers.err },
      formatters: { level: (label) => ({ level: label }) },
    },
    sink,
  );
}

let logger: pino.Logger;
let activeCfg: AppConfig;

try {
  activeCfg = loadConfig();
  logger = buildLogger(activeCfg);
} catch {
  // 配置坏了也要能记日志，否则排查无从下手
  activeCfg = {
    logging: { level: "info", dir: path.join(SERVER_ROOT, "logs"), keepDays: 3, redact: [] },
  } as unknown as AppConfig;
  logger = buildLogger(activeCfg);
}

export const log = logger;

/** 取一个带模块标签的子 logger：mod("llm").info({...}, "消息") */
export function mod(name: string): pino.Logger {
  return logger.child({ mod: name });
}

/** 预置模块（避免各处重复字符串） */
export const logSys = mod("sys");
export const logHttp = mod("http");
export const logDb = mod("db");
export const logLlm = mod("llm");
export const logTts = mod("tts");
export const logStory = mod("story");
export const logSeed = mod("seed");
export const logVideo = mod("video");
export const logBackup = mod("backup");
export const logAuth = mod("auth");

/* --------------------------------------------------------------- 读取接口 */
export function getRecentLogs(limit = 100, level?: string): LogRecord[] {
  const order: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
  let list = ring.slice();
  if (level && order[level] !== undefined) {
    const min = order[level];
    list = list.filter((r) => (order[r.level] ?? 99) >= min);
  }
  return list.slice(-Math.max(1, Math.min(limit, RING_MAX)));
}

export function clearRecentLogs(): void {
  ring.length = 0;
}

export function ringStats(): { count: number; logFile: string } {
  return { count: ring.length, logFile: path.join(activeCfg.logging.dir, `app-${todayKey()}.log`) };
}
