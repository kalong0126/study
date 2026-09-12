import type { NextFunction, Request, Response } from "express";
import { LlmError } from "../services/llm.js";

/** 包裹 async 路由：异常统一交给错误中间件（Express 5 已自动支持，这里再兜一层更稳） */
export function ah(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** 统一的失败响应体 */
export function fail(res: Response, status: number, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ ok: false, error: message, ...extra });
}

export function ok(res: Response, data: Record<string, unknown> = {}): void {
  res.json({ ok: true, ...data });
}

/** 从 query 里取整数 */
export function qInt(v: unknown, def: number, min = -Infinity, max = Infinity): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** 从 body 里取字符串 */
export function bStr(v: unknown, def = ""): string {
  return typeof v === "string" ? v : def;
}

/**
 * 把大模型错误翻译成合适的 HTTP 状态码 + 可读提示。
 * kind 会原样返回给前端，前端据此给出「超时 / 网络不通 / 密钥错 / 地址错」的具体建议。
 */
export function handleLlmError(res: Response, e: unknown): boolean {
  if (!(e instanceof LlmError)) return false;
  const status =
    e.kind === "config" ? 400 : e.kind === "timeout" ? 504 : e.kind === "network" ? 502 : e.kind === "parse" ? 502 : 502;
  res.status(status).json({
    ok: false,
    error: e.message,
    kind: e.kind,
    detail: e.detail,
  });
  return true;
}
