/**
 * 积分接口
 *
 *   GET  /api/points          余额 + 兑换记录 + 积分流水
 *   POST /api/points/award    发「全对」奖励（口算全对 / 听写全对，幂等）
 *   POST /api/points/redeem   用积分兑换奖励（扣除对应积分并生成记录）
 *
 * 「完成 +10 / 阅读 +20 / 全部完成 +10」这些不在本文件 —— 它们在后端 setTaskDone
 * 的链路里自动发（见 routes/state.ts 的 PATCH /state/daily），前端无需关心。
 */
import { Router } from "express";
import { todayStr } from "../db/index.js";
import {
  awardPoints,
  findReward,
  getBalance,
  listLedger,
  listRedemptions,
  redeemPoints,
} from "../db/repo/points.js";
import { currentChildId } from "../services/child.js";
import { ah, bStr, fail, ok, qInt } from "./helpers.js";

export const pointsRouter = Router();

/** 允许前端显式发的奖励原因（完成类积分由后端自动发，避免前端刷分） */
const AWARDABLE_REASONS = new Set(["math_perfect", "dictation_perfect"]);

pointsRouter.get(
  "/points",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const limit = qInt(req.query.limit, 100, 1, 500);
    const [balance, redemptions, ledger] = await Promise.all([
      getBalance(childId),
      listRedemptions(childId, limit),
      listLedger(childId, limit),
    ]);
    ok(res, { balance, redemptions, ledger });
  }),
);

pointsRouter.post(
  "/points/award",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const reason = bStr(req.body?.reason).trim();
    if (!AWARDABLE_REASONS.has(reason)) {
      fail(res, 400, "不支持的积分原因");
      return;
    }
    const date = todayStr();
    const r = await awardPoints(childId, reason, `${reason}:${date}`);
    ok(res, { awarded: r.awarded, balance: r.balance });
  }),
);

pointsRouter.post(
  "/points/redeem",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const rewardId = bStr(req.body?.reward).trim();
    const reward = findReward(rewardId);
    if (!reward) {
      fail(res, 400, "未知的兑换项目");
      return;
    }
    try {
      const r = await redeemPoints(childId, reward);
      ok(res, { balance: r.balance, redemption: r.redemption });
    } catch (e) {
      if ((e as { kind?: string }).kind === "insufficient") {
        fail(res, 400, `积分不够，兑换「${reward.label}」需要 ${reward.cost} 分`);
        return;
      }
      throw e;
    }
  }),
);
