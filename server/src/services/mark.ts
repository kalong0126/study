/**
 * 手写判卷服务
 *
 * 三个关键设计：
 *   1. **批量**：N 个字拼成一张带序号的网格图，一次多模态请求判完。
 *      8 个字逐字判 = 8 次请求；拼图后 = 1 次，成本差 8 倍。
 *   2. **严格校验**：模型返回的项数、序号必须与目标严格对应，否则视为不可信。
 *      这一步不能省——模型很容易漏项，直接按序赋值会造成「张冠李戴」，
 *      把 A 的判定安到 B 头上，比判错更糟糕。
 *   3. **异步任务**：POST 立即返回 taskId，前端轮询。
 *      避免 20-40 秒同步阻塞导致网关超时，中途刷新页面任务也不丢。
 */
import { db, nowIso } from "../db/index.js";
import { addWrong, clearWrongByRef, setMastery, type MasteryState } from "../db/repo/state.js";
import { loadConfig, resolveLlm } from "../config.js";
import { logMark } from "../logger.js";
import { LlmError, chat, type ChatMessage } from "./llm.js";
import {
  MARK_SYSTEM,
  buildBatchMarkPrompt,
  buildSingleMarkPrompt,
  parseBatchMarkResult,
  parseSingleMarkResult,
  type MarkItemResult,
} from "./prompts/markPrompt.js";

export type MarkMode = "composite" | "each";
export type MarkStatus = "pending" | "running" | "done" | "failed";

export interface MarkItem {
  index: number;
  target: string;
  correct: boolean | null;
  written: string;
  score: number | null;
  comment: string;
  reviewedBy: string; // "" | "ai" | "parent"
}

export interface MarkTaskView {
  taskId: number;
  status: MarkStatus;
  degraded: boolean;
  error: string;
  errorKind: string;
  items: MarkItem[];
  createdAt: string;
  finishedAt: string | null;
}

export interface CreateMarkInput {
  childId: number;
  lessonId: number | null;
  mode: MarkMode;
  targets: string[];
  /** mode=composite：拼好的网格图（data URL） */
  image?: string;
  /** 逐字图（data URL 数组，与 targets 一一对应）。composite 模式下作为降级素材 */
  images?: string[];
}

/* ------------------------------------------------------------------ 存储层 */
export async function createMarkTask(input: CreateMarkInput): Promise<number> {
  const d = db();
  const meta = JSON.stringify({ mode: input.mode, targets: input.targets });
  const id = await d.insert(
    "INSERT INTO mark_tasks (child_id, lesson_id, status, degraded, items, error, created_at) VALUES (?, ?, ?, 0, ?, '', ?)",
    [input.childId, input.lessonId, "pending", meta, nowIso()],
  );
  return id;
}

export async function getMarkTask(taskId: number): Promise<MarkTaskView | null> {
  const d = db();
  const t = await d.get<{
    id: number;
    status: string;
    degraded: number;
    error: string | null;
    created_at: string;
    finished_at: string | null;
    items: string | null;
  }>("SELECT id, status, degraded, error, created_at, finished_at, items FROM mark_tasks WHERE id = ?", [taskId]);
  if (!t) return null;

  const rows = await d.all<{
    idx: number;
    target: string;
    correct: number | null;
    written: string | null;
    score: number | null;
    comment: string | null;
    reviewed_by: string | null;
  }>(
    "SELECT idx, target, correct, written, score, comment, reviewed_by FROM mark_items WHERE task_id = ? ORDER BY idx",
    [taskId],
  );

  let errorKind = "";
  const rawErr = t.error ?? "";
  const m = /^\[([a-z]+)\]\s*/.exec(rawErr);
  if (m) errorKind = m[1];

  return {
    taskId: Number(t.id),
    status: t.status as MarkStatus,
    degraded: Number(t.degraded) === 1,
    error: rawErr.replace(/^\[[a-z]+\]\s*/, ""),
    errorKind,
    createdAt: t.created_at,
    finishedAt: t.finished_at,
    items: rows.map((r) => ({
      index: Number(r.idx),
      target: r.target,
      correct: r.correct === null ? null : Number(r.correct) === 1,
      written: r.written ?? "",
      score: r.score === null ? null : Number(r.score),
      comment: r.comment ?? "",
      reviewedBy: r.reviewed_by ?? "",
    })),
  };
}

interface MarkItemRow {
  index: number;
  target: string;
  correct: boolean;
  written: string;
  score: number;
  comment: string;
}

async function writeItems(taskId: number, items: MarkItemRow[]): Promise<void> {
  const d = db();
  await d.run("DELETE FROM mark_items WHERE task_id = ?", [taskId]);
  for (const it of items) {
    await d.run(
      "INSERT INTO mark_items (task_id, idx, target, correct, written, score, comment, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [taskId, it.index, it.target, it.correct ? 1 : 0, it.written, it.score, it.comment, "ai"],
    );
  }
}

async function finishTask(
  taskId: number,
  status: MarkStatus,
  opts: { degraded?: boolean; error?: string } = {},
): Promise<void> {
  const d = db();
  await d.run("UPDATE mark_tasks SET status = ?, degraded = ?, error = ?, finished_at = ? WHERE id = ?", [
    status,
    opts.degraded ? 1 : 0,
    opts.error ?? "",
    nowIso(),
    taskId,
  ]);
}

/* ---------------------------------------------------------------- 判卷核心 */
function buildImageMessage(prompt: string, image: string): ChatMessage {
  const url = image.startsWith("data:") ? image : `data:image/png;base64,${image}`;
  return {
    role: "user",
    content: [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url } },
    ],
  };
}

/** 批量判卷：一次请求判完 N 个字；返回 null 表示结果不可信 */
async function markComposite(targets: string[], image: string): Promise<MarkItemResult[] | null> {
  const cfg = loadConfig();
  const res = await chat({
    tag: "mark.batch",
    provider: resolveLlm(cfg, "mark"),
    maxTokens: 200 + targets.length * 120,
    messages: [
      { role: "system", content: MARK_SYSTEM },
      buildImageMessage(buildBatchMarkPrompt(targets), image),
    ],
  });
  const parsed = parseBatchMarkResult(res.text, targets.length);
  if (!parsed) {
    logMark.warn(
      { expect: targets.length, rawHead: res.text.slice(0, 200) },
      "批量判卷返回结果不合法（项数或序号不符），将降级",
    );
    return null;
  }
  return parsed;
}

/** 单字判卷 */
async function markOne(target: string, image: string, index: number): Promise<MarkItemResult | null> {
  const cfg = loadConfig();
  const res = await chat({
    tag: "mark.single",
    provider: resolveLlm(cfg, "mark"),
    maxTokens: 300,
    messages: [{ role: "system", content: MARK_SYSTEM }, buildImageMessage(buildSingleMarkPrompt(target), image)],
  });
  return parseSingleMarkResult(res.text, index);
}

/** 逐字判卷（降级路径），并发压到 2 防止被限流 */
async function markEach(targets: string[], images: string[]): Promise<{ items: MarkItemResult[]; failed: number[] }> {
  const items: MarkItemResult[] = [];
  const failed: number[] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const i = cursor++;
      const img = images[i];
      if (!img) {
        failed.push(i + 1);
        continue;
      }
      try {
        const r = await markOne(targets[i], img, i + 1);
        if (r) items.push({ ...r, index: i + 1 });
        else failed.push(i + 1);
      } catch (e) {
        logMark.warn({ index: i + 1, target: targets[i], err: e }, "单字判卷失败");
        failed.push(i + 1);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  items.sort((a, b) => a.index - b.index);
  return { items, failed };
}

/** 把判定结果落到掌握度和错字本（幂等，可重复调用） */
export async function applyMarkItems(
  childId: number,
  lessonId: number | null,
  items: { target: string; correct: boolean | null }[],
): Promise<void> {
  for (const it of items) {
    if (it.correct === null) continue; // 未判定（待家长审核）不动
    const refKey = `${lessonId ?? 0}:${it.target}`;
    const state: MasteryState = it.correct ? 1 : 0;
    if (lessonId) {
      await setMastery(childId, lessonId, it.target, state);
    }
    if (it.correct) {
      await clearWrongByRef(childId, "chinese", refKey);
    } else {
      await addWrong(childId, "chinese", refKey, { char: it.target, lessonId });
    }
  }
}

/* -------------------------------------------------------------- 任务执行器 */
/** 内存去重：同一任务不会被并发执行两次 */
const running = new Set<number>();

export async function runMarkTask(taskId: number, input: CreateMarkInput): Promise<void> {
  if (running.has(taskId)) return;
  running.add(taskId);
  const t0 = Date.now();
  const cfg = loadConfig();

  try {
    await db().run("UPDATE mark_tasks SET status = ? WHERE id = ?", ["running", taskId]);

    if (!cfg.llm.markModel) {
      throw new LlmError("config", "后端未配置 llm.markModel（手写判卷必须用支持视觉的模型）");
    }

    let items: MarkItemResult[] = [];
    let degraded = false;

    if (input.mode === "composite" && input.image) {
      const batch = await markComposite(input.targets, input.image);
      if (batch) {
        items = batch;
      } else if (input.images?.length) {
        // 降级：用单字图逐张判
        degraded = true;
        const each = await markEach(input.targets, input.images);
        items = each.items;
        logMark.warn({ taskId, failed: each.failed.length }, "批量判卷降级为逐字判卷");
      } else {
        throw new LlmError("parse", "批量判卷结果格式不符，且没有提供单字图可用于降级");
      }
    } else {
      if (!input.images?.length) {
        throw new LlmError("config", "逐字判卷需要提供 images 数组");
      }
      const each = await markEach(input.targets, input.images);
      items = each.items;
      if (each.failed.length && !each.items.length) {
        throw new LlmError("parse", "所有字都未能判定，请检查判卷模型是否支持视觉");
      }
    }

    // 补齐缺失项（未判出的字标记为待人工审核）
    const byIndex = new Map(items.map((i) => [i.index, i]));
    const full: (MarkItemResult & { target: string })[] = [];
    for (let i = 0; i < input.targets.length; i++) {
      const target = input.targets[i];
      const got = byIndex.get(i + 1);
      if (got) {
        full.push({ ...got, index: i + 1, target });
      } else {
        full.push({
          index: i + 1,
          target,
          written: "?",
          correct: false,
          score: 0,
          comment: "这个字没能自动判定，请家长看一眼",
          // 标记出来，避免把「没判出」误当成「写错了」
        });
      }
    }

    await writeItems(taskId, full);
    await applyMarkItems(
      input.childId,
      input.lessonId,
      full.map((f) => ({ target: f.target, correct: f.correct })),
    );
    await finishTask(taskId, "done", { degraded });

    const correctCount = full.filter((f) => f.correct).length;
    logMark.info(
      {
        taskId,
        mode: input.mode,
        degraded,
        count: full.length,
        correct: correctCount,
        ms: Date.now() - t0,
      },
      "判卷完成",
    );
  } catch (e) {
    const kind = e instanceof LlmError ? e.kind : "unknown";
    const msg = e instanceof Error ? e.message : String(e);
    await finishTask(taskId, "failed", { error: `[${kind}] ${msg}` });
    logMark.error({ taskId, kind, err: e, ms: Date.now() - t0 }, "判卷失败");
  } finally {
    running.delete(taskId);
  }
}

/** 家长改判：只改判定，不动原图 */
export async function reviewMarkTask(
  taskId: number,
  items: { index: number; correct: boolean }[],
): Promise<{ lessonId: number | null; childId: number } | null> {
  const d = db();
  const task = await d.get<{ child_id: number; lesson_id: number | null }>(
    "SELECT child_id, lesson_id FROM mark_tasks WHERE id = ?",
    [taskId],
  );
  if (!task) return null;

  for (const it of items) {
    await d.run("UPDATE mark_items SET correct = ?, reviewed_by = ? WHERE task_id = ? AND idx = ?", [
      it.correct ? 1 : 0,
      "parent",
      taskId,
      it.index,
    ]);
  }

  const rows = await d.all<{ idx: number; target: string; correct: number | null }>(
    "SELECT idx, target, correct FROM mark_items WHERE task_id = ? ORDER BY idx",
    [taskId],
  );
  await applyMarkItems(
    Number(task.child_id),
    task.lesson_id === null ? null : Number(task.lesson_id),
    rows.map((r) => ({ target: r.target, correct: r.correct === null ? null : Number(r.correct) === 1 })),
  );

  logMark.info({ taskId, changed: items.length }, "家长改判完成");
  return { lessonId: task.lesson_id === null ? null : Number(task.lesson_id), childId: Number(task.child_id) };
}

/**
 * 服务启动时清理「中断任务」。
 * 判卷任务只存在内存里，进程一重启，pending/running 的任务就永远不会有人推进了，
 * 必须显式标成失败，否则前端会一直轮询。
 */
export async function failStaleTasks(): Promise<number> {
  const d = db();
  const rows = await d.all<{ id: number }>("SELECT id FROM mark_tasks WHERE status IN ('pending','running')");
  if (!rows.length) return 0;
  await d.run(
    "UPDATE mark_tasks SET status = 'failed', error = ?, finished_at = ? WHERE status IN ('pending','running')",
    ["[interrupted] 服务重启，任务已中断，请重新提交", nowIso()],
  );
  logMark.warn({ count: rows.length }, "清理了中断的判卷任务");
  return rows.length;
}
