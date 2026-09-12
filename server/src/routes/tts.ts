/**
 * 语音合成接口
 *
 * GET /api/tts?text=眼睛&kind=word  → audio/mpeg
 *   - 命中磁盘缓存时 0 网络请求、0 延迟
 *   - X-TTS-Cache 头标明 HIT/MISS，方便前端与排查时判断
 *
 * 前端拿它当普通音频 URL 用（<audio src> 或 fetch 成 Blob 预加载）。
 */
import { Router, type Response } from "express";
import { listLessons } from "../db/repo/lessons.js";
import { TtsError, dictationTexts, prewarmChars, synthesize, ttsStats } from "../services/tts/index.js";
import { ah, bStr, fail, ok } from "./helpers.js";

export const ttsRouter = Router();

function handleTtsError(res: Response, e: unknown): boolean {
  if (!(e instanceof TtsError)) return false;
  // noinput 是**请求方**的文本没法读（空 / 纯标点），属于 400 而不是 503 ——
  // 503 会被前端理解成「后端 TTS 挂了」从而降级到浏览器音色，但它其实不该降级。
  const status = e.kind === "timeout" ? 504 : e.kind === "noinput" ? 400 : 503;
  res.status(status).json({ ok: false, error: e.message, kind: `tts.${e.kind}` });
  return true;
}

ttsRouter.get(
  "/tts",
  ah(async (req, res) => {
    const text = bStr(req.query.text).trim();
    const kindRaw = bStr(req.query.kind, "word");
    const kind = kindRaw === "char" || kindRaw === "sentence" ? kindRaw : "word";
    if (!text) {
      fail(res, 400, "缺少 text 参数");
      return;
    }

    let r;
    try {
      r = await synthesize(text, kind);
    } catch (e) {
      if (handleTtsError(res, e)) return;
      throw e;
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", String(r.buf.length));
    res.setHeader("X-TTS-Cache", r.cached ? "HIT" : "MISS");
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.setHeader("ETag", `"${r.key}"`);
    res.end(r.buf);
  }),
);

/* -------------------------------------------------- 预热（保存课文后调用） */
interface PrewarmJob {
  id: string;
  lessonId: number;
  total: number;
  done: number;
  ok: number;
  failed: number;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  error: string;
}

const jobs = new Map<string, PrewarmJob>();

ttsRouter.post(
  "/tts/prewarm",
  ah(async (req, res) => {
    const lessonId = Number(req.body?.lessonId);
    if (!Number.isFinite(lessonId)) {
      fail(res, 400, "缺少 lessonId");
      return;
    }
    const lessons = await listLessons(true);
    const lesson = lessons.find((l) => l.id === lessonId);
    if (!lesson) {
      fail(res, 404, "课文不存在");
      return;
    }

    // 只预热可见的生字
    const chars = lesson.chars.filter((c) => !c.hidden).map((c) => ({ ch: c.ch, word: c.word }));
    const total = chars.reduce((n, c) => n + dictationTexts(c.ch, c.word).length, 0);
    const id = `pw_${lessonId}_${Date.now()}`;
    const job: PrewarmJob = {
      id,
      lessonId,
      total,
      done: 0,
      ok: 0,
      failed: 0,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      error: "",
    };
    jobs.set(id, job);
    // 太老的记录清掉，避免内存里越堆越多
    if (jobs.size > 50) {
      const old = Array.from(jobs.values()).sort((a, b) => a.startedAt - b.startedAt).slice(0, 20);
      for (const o of old) jobs.delete(o.id);
    }

    res.json({ ok: true, jobId: id, total, status: "running" });

    // 异步跑，不阻塞响应
    setImmediate(async () => {
      try {
        const r = await prewarmChars(chars, 3);
        job.done = r.total;
        job.ok = r.ok;
        job.failed = r.failed.length;
        job.status = "done";
        job.finishedAt = Date.now();
      } catch (e) {
        job.status = "failed";
        job.error = e instanceof Error ? e.message : String(e);
        job.finishedAt = Date.now();
      }
    });
  }),
);

ttsRouter.get(
  "/tts/prewarm/:jobId",
  ah(async (req, res) => {
    const job = jobs.get(String(req.params.jobId));
    if (!job) {
      fail(res, 404, "预热任务不存在或已过期");
      return;
    }
    ok(res, { job });
  }),
);

ttsRouter.get(
  "/tts/stats",
  ah(async (_req, res) => {
    const s = await ttsStats();
    ok(res, { ...s, mb: Math.round((s.bytes / 1024 / 1024) * 10) / 10 });
  }),
);
