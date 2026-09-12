/**
 * 手写判卷接口
 *
 * POST /api/mark            提交判卷（立即返回 taskId，后台异步判）
 * GET  /api/mark/:taskId    轮询结果
 * POST /api/mark/:taskId/review  家长改判
 */
import { Router } from "express";
import { createMarkTask, getMarkTask, reviewMarkTask, runMarkTask, type MarkMode } from "../services/mark.js";
import { currentChildId } from "../services/child.js";
import { ah, fail, ok } from "./helpers.js";

export const markRouter = Router();

const MAX_ITEMS = 20;

markRouter.post(
  "/mark",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;

    const mode: MarkMode = body.mode === "each" ? "each" : "composite";
    const targets = Array.isArray(body.targets) ? body.targets.map((t) => String(t).trim()).filter(Boolean) : [];
    const image = typeof body.image === "string" ? body.image : undefined;
    const images = Array.isArray(body.images) ? body.images.map((s) => String(s)) : undefined;

    if (!targets.length) {
      fail(res, 400, "targets 不能为空");
      return;
    }
    if (targets.length > MAX_ITEMS) {
      fail(res, 400, `一次最多提交 ${MAX_ITEMS} 个字`);
      return;
    }
    if (mode === "composite" && !image) {
      fail(res, 400, "composite 模式需要提供合成图 image");
      return;
    }
    if (mode === "each" && (!images || images.length !== targets.length)) {
      fail(res, 400, "each 模式需要提供与 targets 等长的 images");
      return;
    }

    const lessonIdRaw = Number(body.lessonId);
    const lessonId = Number.isFinite(lessonIdRaw) && lessonIdRaw > 0 ? lessonIdRaw : null;

    const input = { childId, lessonId, mode, targets, image, images };
    const taskId = await createMarkTask(input);

    // 后台执行，立刻返回 taskId（避免 20-40s 同步阻塞）
    setImmediate(() => {
      void runMarkTask(taskId, input);
    });

    ok(res, { taskId, status: "pending", count: targets.length, mode });
  }),
);

markRouter.get(
  "/mark/:taskId",
  ah(async (req, res) => {
    const taskId = Number(req.params.taskId);
    if (!Number.isFinite(taskId)) {
      fail(res, 400, "taskId 不合法");
      return;
    }
    const task = await getMarkTask(taskId);
    if (!task) {
      fail(res, 404, "判卷任务不存在");
      return;
    }
    ok(res, { task });
  }),
);

markRouter.post(
  "/mark/:taskId/review",
  ah(async (req, res) => {
    const taskId = Number(req.params.taskId);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const parsed = items
      .map((it: Record<string, unknown>) => ({ index: Number(it?.index), correct: it?.correct === true }))
      .filter((it: { index: number }) => Number.isFinite(it.index));
    if (!parsed.length) {
      fail(res, 400, "items 不能为空");
      return;
    }
    const r = await reviewMarkTask(taskId, parsed);
    if (!r) {
      fail(res, 404, "判卷任务不存在");
      return;
    }
    const task = await getMarkTask(taskId);
    ok(res, { task });
  }),
);
