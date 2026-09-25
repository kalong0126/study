/**
 * 诊断接口
 *
 * 家长排查问题的入口。因为配置与密钥都在后端，前端只保留「只读诊断」。
 * 三类信息：
 *   /api/diag/logs      最近的运行日志（与后台日志同源）
 *   /api/diag/llm       配置与网络可达性自检（不消耗 token）
 *   /api/diag/llm-test  真实调用一次（消耗极少 token，用来确认密钥与模型可用）
 * 外加一个给平板用的：/api/diag/rootca.crt（下载自签 CA 的根证书）
 */
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { loadConfig, providerModelMismatches, resolveAllLlm, resolveLlm, startupWarnings } from "../config.js";
import { db, nowIso } from "../db/index.js";
import { clearRecentLogs, formatRecord, getRecentLogs, logSys, ringStats } from "../logger.js";
import { chat, llmConfigSummary } from "../services/llm.js";
import { synthesize, ttsInfo, ttsStats } from "../services/tts/index.js";
import { ah, bStr, fail, handleLlmError, ok, qInt } from "./helpers.js";

export const diagRouter = Router();

/**
 * 下载本机自签 CA 的根证书 —— 专门给平板用。
 *
 * 开了 HTTPS 之后，平板必须装一次根证书才认这个站点。而「把 pem 弄到安卓平板上」
 * 本身就很绕（USB / 网盘 / 邮件都得试），所以干脆让服务自己发一份：
 * 平板浏览器打开这个地址就能下载，装完再用 https 打开就是全信任的。
 *
 * 只发**公钥证书**，不涉及任何私钥（rootCA-key.pem 始终留在 mkcert 的 CAROOT 里）。
 * 走 http 访问时也能下 —— 本来就是为了在切到 https 之前把证书装好。
 */
diagRouter.get("/diag/rootca.crt", (_req, res) => {
  const cfg = loadConfig();
  const file = path.join(path.dirname(cfg.server.https.certFile), "rootCA.crt");
  if (!fs.existsSync(file)) {
    fail(res, 404, "还没有根证书：先在仓库根目录跑 scripts/https-setup.ps1");
    return;
  }
  res.setHeader("Content-Type", "application/x-x509-ca-cert");
  res.setHeader("Content-Disposition", 'attachment; filename="rootCA.crt"');
  res.setHeader("Cache-Control", "no-store");
  res.send(fs.readFileSync(file));
});

/** 只取主机名，诊断信息里没必要铺一长串路径 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || "(空)";
  }
}

diagRouter.get(
  "/diag/logs",
  ah(async (req, res) => {
    const limit = qInt(req.query.limit, 120, 1, 600);
    const level = bStr(req.query.level) || undefined;
    const logs = getRecentLogs(limit, level);
    ok(res, {
      logs: logs.map((r) => ({
        ts: r.ts,
        at: new Date(r.ts).toISOString(),
        level: r.level,
        mod: r.mod,
        msg: r.msg,
        fields: r.fields,
        text: formatRecord(r, false),
      })),
      stats: ringStats(),
      now: nowIso(),
    });
  }),
);

diagRouter.delete(
  "/diag/logs",
  ah(async (_req, res) => {
    clearRecentLogs();
    ok(res, { cleared: true });
  }),
);

/** 探测某个地址是否可达（不关心返回码，能连上就算通） */
async function probeReach(
  url: string,
  timeoutMs = 6000,
): Promise<{ reachable: boolean; status: number | null; ms: number; error: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: "GET", signal: ac.signal, redirect: "manual" });
    return { reachable: true, status: res.status, ms: Date.now() - t0, error: "" };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } })?.cause;
    const name = (e as { name?: string })?.name;
    const msg = name === "AbortError" ? `超时（${timeoutMs}ms）` : `${(e as Error).message}${cause?.code ? ` · ${cause.code}` : ""}`;
    return { reachable: false, status: null, ms: Date.now() - t0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 综合自检：配置是否完整、网络是否可达、数据库是否正常 */
diagRouter.get(
  "/diag/llm",
  ah(async (_req, res) => {
    const cfg = loadConfig();
    const summary = llmConfigSummary();
    const resolved = resolveAllLlm(cfg);

    const probe = await probeReach(cfg.llm.baseUrl);
    const ttsCache = await ttsStats();

    let dbOk = true;
    let dbError = "";
    try {
      await db().get("SELECT 1 AS x");
    } catch (e) {
      dbOk = false;
      dbError = e instanceof Error ? e.message : String(e);
    }

    // 每个用途单独一行，能一眼看出来「谁走了哪家、哪个模型」
    const purposeLabel: Record<string, string> = { story: "故事模型", suggest: "组词模型" };
    const purposeChecks = resolved.map((p) => ({
      name: purposeLabel[p.purpose] ?? p.purpose,
      ok: p.configured,
      detail: p.configured
        ? `${p.model} · ${p.usingOwnProvider ? "独立 provider" : "共享 provider"} · ${hostOf(p.baseUrl)}`
        : `${p.model || "未配置模型"}${p.apiKey ? "" : " · 无 API Key"}`,
    }));

    const checks = [
      {
        name: "配置文件",
        ok: true,
        detail: `默认 baseUrl=${cfg.llm.baseUrl}`,
      },
      ...purposeChecks,
      (() => {
        const mism = providerModelMismatches(cfg);
        return {
          name: "模型与厂商匹配",
          ok: mism.length === 0,
          detail: mism.length ? mism.join("  ／  ") : "各用途的模型名与接口地址一致",
        };
      })(),
      {
        name: "接口地址拼接",
        ok: true,
        detail: resolved.map((p) => `${p.purpose}=${p.chatUrl}`).join("  |  "),
      },
      {
        name: "网络可达性",
        ok: probe.reachable,
        detail: probe.reachable
          ? `默认地址可达（HTTP ${probe.status}，${probe.ms}ms）`
          : `不可达：${probe.error}`,
      },
      { name: "数据库", ok: dbOk, detail: dbOk ? `正常（${db().driver}）` : dbError },
      {
        name: "语音合成",
        ok: true,
        detail: `${cfg.tts.provider} · ${cfg.tts.voice} · 缓存 ${ttsCache.count} 个文件（${Math.round(ttsCache.bytes / 1024 / 1024 * 10) / 10} MB）`,
      },
    ];

    ok(res, {
      checks,
      llm: summary,
      tts: ttsInfo(),
      db: { driver: db().driver, ok: dbOk, error: dbError },
      warnings: startupWarnings(cfg),
    });
  }),
);

/** 真实调用一次大模型，确认密钥与模型可用（消耗极少 token） */
diagRouter.post(
  "/diag/llm-test",
  ah(async (req, res) => {
    const cfg = loadConfig();
    const which: "story" | "suggest" = bStr(req.body?.which, "story") === "suggest" ? "suggest" : "story";
    const model = which === "suggest" ? cfg.llm.suggestModel : cfg.llm.storyModel;
    if (!model) {
      fail(res, 400, which === "suggest" ? "未配置组词模型 llm.suggestModel" : "未配置故事模型 llm.storyModel");
      return;
    }
    try {
      const r = await chat({
        tag: `diag.${which}`,
        provider: resolveLlm(cfg, which),
        timeoutMs: 30000,
        maxTokens: 16,
        messages: [{ role: "user", content: "请只回复两个字：正常" }],
      });
      ok(res, { which, model, reply: r.text.slice(0, 50), ms: r.ms, usage: r.usage });
    } catch (e) {
      if (handleLlmError(res, e)) return;
      throw e;
    }
  }),
);

/** 真实合成一段语音（不消耗 token，用于确认 Edge TTS 是否可用） */
diagRouter.get(
  "/diag/tts-test",
  ah(async (req, res) => {
    const text = bStr(req.query.text, "你好，我是朗读小助手").trim();
    try {
      const r = await synthesize(text, "sentence");
      ok(res, { text: r.text, bytes: r.buf.length, cached: r.cached, ms: r.ms, rate: r.rate });
    } catch (e) {
      const kind = (e as { kind?: string })?.kind ?? "tts.unknown";
      fail(res, 503, e instanceof Error ? e.message : String(e), { kind });
    }
  }),
);

diagRouter.post(
  "/diag/echo",
  ah(async (req, res) => {
    logSys.info({ path: req.path, bodyKeys: Object.keys(req.body ?? {}) }, "诊断回显");
    ok(res, { received: req.body ?? null, at: nowIso() });
  }),
);
