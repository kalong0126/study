/**
 * 登录接口
 *
 * 前端只有三个需求：
 *   · 启动时问一句「这一步要不要先输口令」（GET /auth/me）
 *   · 输口令（POST /auth/login）
 *   · 退出（POST /auth/logout）
 *
 * 口令本身只存在于 config.yaml（或同名环境变量），永远不下发给前端；
 * 下发的只有一枚随机 token，且落到 cookie 里就带 HttpOnly。
 */
import { Router } from "express";
import { loadConfig } from "../config.js";
import { logAuth } from "../logger.js";
import {
  SESSION_COOKIE,
  exposureOf,
  login,
  readToken,
  revokeAllSessions,
  revokeSession,
  verifySession,
} from "../services/auth.js";
import { ah, fail, ok } from "./helpers.js";

export const authRouter = Router();

/** 会话 cookie。HTTPS 下才加 Secure —— 内网 HTTP 时加了浏览器会直接不收 */
function buildCookie(token: string, expiresAt: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

authRouter.get(
  "/auth/me",
  ah(async (req, res) => {
    const cfg = loadConfig();
    const auth = cfg.server.auth;
    // exposureOf 是唯一判据 —— 公网判定、内网放行、能不能用家长口令，全走它，
    // 免得出现「这儿说你在内网、那儿说你是公网」这种自相矛盾
    const { lan, exposed } = exposureOf(cfg, req);

    // 没启用鉴权，或者人在家里 → 直接算「已通过」，角色给家长级（内网本来就有全部权限）
    if (!auth.enabled || !exposed) {
      ok(res, { enabled: auth.enabled, authed: true, role: auth.enabled ? "parent" : "", lan, exposed });
      return;
    }

    const session = await verifySession(readToken(req));
    ok(res, { enabled: true, authed: !!session, role: session?.role ?? "", lan, exposed });
  }),
);

authRouter.post(
  "/auth/login",
  ah(async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.server.auth.enabled) {
      ok(res, { enabled: false, authed: true, role: "parent" });
      return;
    }

    const { exposed } = exposureOf(cfg, req);

    const pin = String((req.body as { pin?: unknown } | undefined)?.pin ?? "").trim();
    if (!pin) {
      fail(res, 400, "请输入口令", { kind: "auth.nopin" });
      return;
    }

    const r = await login(cfg, pin, {
      ip: req.socket.remoteAddress ?? "",
      // 「人在家里」= 这次请求没有被当成公网。用 exposed 的取反而不是单独再判一次来源，
      // 否则 forcePublic 一开，两边结论就不一致了（家长口令会从公网漏过去）。
      fromLan: !exposed,
      agent: String(req.headers["user-agent"] ?? ""),
    });

    if (!r.ok) {
      fail(res, r.status ?? 401, r.error ?? "登录失败", {
        kind: r.kind,
        remaining: r.remaining,
        retryAfterSec: r.retryAfterSec,
      });
      return;
    }

    res.setHeader("Set-Cookie", buildCookie(r.token as string, r.expiresAt as number, req.secure));
    ok(res, { enabled: true, authed: true, role: r.role, expiresAt: r.expiresAt });
  }),
);

authRouter.post(
  "/auth/logout",
  ah(async (req, res) => {
    await revokeSession(readToken(req));
    res.setHeader("Set-Cookie", clearCookie());
    ok(res, { cleared: true });
  }),
);

/**
 * 让所有设备退出登录 —— 家长换口令、或者觉得哪台设备不该还留着会话时用。
 * 归「家长专属」：公网能随便调它就成了一个登出所有人的开关（DoS）。
 */
authRouter.post(
  "/auth/logout-all",
  ah(async (_req, res) => {
    const removed = await revokeAllSessions();
    logAuth.warn({ removed }, "已清除全部登录会话");
    res.setHeader("Set-Cookie", clearCookie());
    ok(res, { removed });
  }),
);
