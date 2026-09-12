/**
 * 学习数据接口
 *
 * 拆成若干语义化端点（而不是一个万能 PATCH），是为了让前端调用意图明确、
 * 后端校验也能各自收紧。所有写入都是**增量**的，不会覆盖整份状态。
 */
import { Router } from "express";
import { todayStr } from "../db/index.js";
import {
  addWrong,
  clearAllWrong,
  clearWrongById,
  clearWrongByRef,
  countPendingWrong,
  deleteStoryByTitle,
  getDaily,
  getMastery,
  getMathElapsed,
  getMathSet,
  insertMathSet,
  kvGet,
  kvSet,
  listReadTitles,
  listStories,
  listWrong,
  REVIEW_MAX,
  setMastery,
  setMathElapsed,
  setMathResult,
  setReviewCount,
  setReviewTarget,
  setTaskDone,
  type MasteryState,
  type MathQuestion,
  type WrongType,
} from "../db/repo/state.js";
import { currentChildId } from "../services/child.js";
import { ah, bStr, fail, ok, qInt } from "./helpers.js";

export const stateRouter = Router();

function normDate(v: unknown): string {
  const s = bStr(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayStr();
}

function normType(v: unknown): WrongType | undefined {
  return v === "math" || v === "chinese" ? v : undefined;
}

/** 全量读取（前端启动时拉一次） */
stateRouter.get(
  "/state",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const date = normDate(req.query.date);

    const [daily, mathSet, mastery, wrongMath, wrongChinese, stories, readTitles, timer, mathElapsedMs] =
      await Promise.all([
        getDaily(childId, date),
        getMathSet(childId, date),
        getMastery(childId),
        listWrong(childId, "math"),
        listWrong(childId, "chinese"),
        listStories(childId, qInt(req.query.storyLimit, 30, 1, 100)),
        listReadTitles(childId),
        kvGet<{ running: boolean; endAt: number }>(childId, "timer"),
        getMathElapsed(childId, date),
      ]);

    ok(res, {
      date,
      daily,
      mathSet,
      mathElapsedMs,
      mastery,
      wrong: { math: wrongMath, chinese: wrongChinese },
      stories,
      readTitles,
      timer: timer ?? { running: false, endAt: 0 },
    });
  }),
);

/* ------------------------------------------------------------------ 打卡 */
stateRouter.patch(
  "/state/daily",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const date = normDate(body.date);

    const tasks = body.tasks;
    if (tasks && typeof tasks === "object") {
      for (const [k, v] of Object.entries(tasks as Record<string, unknown>)) {
        await setTaskDone(childId, date, k, v === true);
      }
    }
    if (body.reviewCount !== undefined) {
      const n = Number(body.reviewCount);
      if (Number.isFinite(n)) await setReviewCount(childId, date, Math.max(0, Math.trunc(n)));
    }
    // 显式写 null = 回到「未开闸」，给重置 / 测试用；正常开闸走 /state/review/open
    if (body.reviewTarget !== undefined) {
      if (body.reviewTarget === null) {
        await setReviewTarget(childId, date, null);
      } else {
        const t = Number(body.reviewTarget);
        if (Number.isFinite(t)) await setReviewTarget(childId, date, Math.max(0, Math.trunc(t)));
      }
    }
    ok(res, { daily: await getDaily(childId, date) });
  }),
);

/* ------------------------------------------------------------ 错题复习开闸 */

/**
 * 开闸：把「这一轮要重做几道」算出来并**冻结**。
 *
 * 为什么要有这一步、而不是前端每帧算一次：
 *   错题本会随着口算/听写不断长大，如果分母是实时算的，孩子做到一半分母就变了
 *   （「明明只错了一道，却写着 3 道」这类对不上号的根源）。
 *   所以规则是：**口算 + 听写都完成之后**才允许复习，并在那一刻取
 *   `min(3, 当时待复习错题数)` 定死。
 *
 * 幂等：已经冻结过就直接返回现值，重复调用不会把分母改小。
 */
stateRouter.post(
  "/state/review/open",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const date = normDate((req.body ?? {}).date);

    const before = await getDaily(childId, date);
    if (before.reviewTarget === null) {
      const pending = await countPendingWrong(childId);
      await setReviewTarget(childId, date, Math.min(REVIEW_MAX, pending));
    }
    ok(res, { daily: await getDaily(childId, date) });
  }),
);

/* ------------------------------------------------------------------ 口算 */
stateRouter.post(
  "/state/math",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const date = normDate(body.date);
    const qs = Array.isArray(body.qs) ? (body.qs as MathQuestion[]) : [];
    if (!qs.length) {
      fail(res, 400, "qs 不能为空");
      return;
    }
    const results = (body.results && typeof body.results === "object" ? body.results : {}) as Record<string, string>;
    await insertMathSet(childId, date, qs, results);
    // 换了新题组 → 用时从头开始
    await setMathElapsed(childId, date, 0);
    ok(res, { mathSet: await getMathSet(childId, date), mathElapsedMs: 0 });
  }),
);

/**
 * 口算计时：前端把**当天累计毫秒总数**写回来（幂等，不是增量）。
 * 家长端不判定，直接覆盖；越界值由 setMathElapsed 钳住。
 */
stateRouter.patch(
  "/state/math/elapsed",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const date = normDate(body.date);
    const ms = Number(body.ms);
    if (!Number.isFinite(ms) || ms < 0) {
      fail(res, 400, "ms 不合法");
      return;
    }
    const saved = await setMathElapsed(childId, date, ms);
    ok(res, { mathElapsedMs: saved });
  }),
);

stateRouter.patch(
  "/state/math",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const date = normDate(body.date);
    const idx = Number(body.idx);
    if (!Number.isFinite(idx) || idx < 0) {
      fail(res, 400, "idx 不合法");
      return;
    }
    const value = typeof body.value === "string" && ["ok", "bad"].includes(body.value) ? body.value : "";
    const results = await setMathResult(childId, date, idx, value);
    if (!results) {
      fail(res, 404, "当天还没有口算题组");
      return;
    }
    // 顺便把「已答对多少」算出来，省得前端再算一遍
    let correct = 0;
    for (const k of Object.keys(results)) if (results[k] === "ok") correct++;
    ok(res, { results, correct, answered: Object.keys(results).length });
  }),
);

/* ---------------------------------------------------------------- 掌握度 */
stateRouter.patch(
  "/state/mastery",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lessonId = Number(body.lessonId);
    const ch = bStr(body.ch).trim();
    if (!Number.isFinite(lessonId) || !ch) {
      fail(res, 400, "lessonId 与 ch 必填");
      return;
    }
    const raw = body.state;
    const state: MasteryState | null = raw === 1 || raw === true ? 1 : raw === 0 || raw === false ? 0 : null;
    await setMastery(childId, lessonId, ch, state);
    ok(res, { mastery: await getMastery(childId) });
  }),
);

/* ---------------------------------------------------------------- 错题本 */
stateRouter.post(
  "/state/wrong",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = normType(body.type);
    const refKey = bStr(body.refKey).trim();
    if (!type || !refKey) {
      fail(res, 400, "type 与 refKey 必填");
      return;
    }
    const payload = (body.payload && typeof body.payload === "object" ? body.payload : {}) as Record<string, unknown>;
    const id = await addWrong(childId, type, refKey, payload);
    ok(res, { id, duplicated: id === null });
  }),
);

stateRouter.post(
  "/state/wrong/clear",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = normType(body.type);

    let removed = 0;
    if (body.all === true) {
      removed = await clearAllWrong(childId, type);
    } else if (body.id !== undefined) {
      const id = Number(body.id);
      if (!Number.isFinite(id)) {
        fail(res, 400, "id 不合法");
        return;
      }
      await clearWrongById(childId, id);
      removed = 1;
    } else if (typeof body.refKey === "string" && type) {
      await clearWrongByRef(childId, type, body.refKey);
      removed = 1;
    } else {
      fail(res, 400, "需要提供 all / id / (type + refKey) 之一");
      return;
    }
    ok(res, {
      removed,
      wrong: { math: await listWrong(childId, "math"), chinese: await listWrong(childId, "chinese") },
    });
  }),
);

/* -------------------------------------------------------------- 故事删除 */
stateRouter.post(
  "/state/story/delete",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const title = bStr(req.body?.title).trim();
    if (!title) {
      fail(res, 400, "title 必填");
      return;
    }
    const removed = await deleteStoryByTitle(childId, title);
    ok(res, {
      removed,
      stories: await listStories(childId, 50),
      readTitles: await listReadTitles(childId),
    });
  }),
);

/* -------------------------------------------------------------- 阅读计时 */
stateRouter.patch(
  "/state/timer",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const running = body.running === true;
    const endAt = Number(body.endAt);
    const value = { running, endAt: Number.isFinite(endAt) ? endAt : 0 };
    await kvSet(childId, "timer", value);
    ok(res, { timer: value });
  }),
);
