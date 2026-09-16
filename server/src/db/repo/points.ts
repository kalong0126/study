/**
 * 仓储：积分系统
 *
 * 规则（与前端 progress store 的完成链路一一对应）：
 *   · 口算完成 +10、语文听写完成 +10、阅读完成 +20（这 3 项在 setTaskDone 时由后端自动发）
 *   · 语言强化 9 道题**全部**完成 +20（**没做完一分不给**；判定归 `routes/language.ts`，
 *     它每次作答后重算进度再回写打卡标记，标记落库时走的就是本表）
 *   · 口算全对 +10、听写全对 +10（前端判定「全对」后显式调 /points/award）
 *   · 五项任务全部完成再 +10（后端在 setTaskDone 后检查自动发）
 *   · 兑换：50 分 = 半小时平板娱乐时间 / 1 块钱（扣除对应积分，生成兑换记录）
 *
 * 幂等设计：所有「奖励」类入账都带 ref_key（如 "math_done:2026-09-13"），
 * 靠 (child_id, ref_key) 唯一约束保证重复调用不会重复加分。兑换的 ref_key 用毫秒时间戳，
 * 天然唯一（家庭单用户场景不会同毫秒兑两次）。
 *
 * 注意：积分**只发不追回**。语言强化做完拿到 20 分后，家长若把某题打回「再练一练」，
 * 打卡标记会取消（首页重新变「待完成」），但那 20 分留在账上不动 ——
 * 孩子确实做过了，扣分只会让他觉得莫名其妙。
 */
import { db, nowIso } from "../index.js";

/** 各积分原因对应的分值 */
export const POINT_VALUES: Record<string, number> = {
  math_done: 10,
  math_perfect: 10,
  dictation_done: 10,
  dictation_perfect: 10,
  reading_done: 20,
  language_done: 20,
  video_done: 10,
  all_done: 10,
};

/** 任务 key → 完成积分原因（review 不加分，故不在此表） */
export const POINT_REASONS: Record<string, string> = {
  math: "math_done",
  dictation: "dictation_done",
  reading: "reading_done",
  language: "language_done",
  video: "video_done",
};

export interface Reward {
  id: string;
  label: string;
  cost: number;
}

/** 可兑换奖励（与前端 REWARDS 保持一致） */
export const REWARDS: Reward[] = [
  { id: "screen_30min", label: "半小时平板娱乐时间", cost: 50 },
  { id: "money_1yuan", label: "1 块钱", cost: 50 },
];

export function findReward(id: string): Reward | undefined {
  return REWARDS.find((r) => r.id === id);
}

export interface LedgerEntry {
  id: number;
  delta: number;
  reason: string;
  refKey: string;
  createdAt: string;
}

export interface Redemption {
  id: number;
  reward: string;
  cost: number;
  createdAt: string;
}

/** 当前积分余额 = 所有流水的 delta 之和（不可能为负，兑换前已校验） */
export async function getBalance(childId: number): Promise<number> {
  const d = db();
  const r = await d.get<{ s: number | null }>("SELECT SUM(delta) AS s FROM points_ledger WHERE child_id = ?", [childId]);
  return Math.max(0, Math.trunc(Number(r?.s ?? 0) || 0));
}

/** 幂等加分：reason 必须在 POINT_VALUES 里，ref_key 已存在则不重复发 */
export async function awardPoints(
  childId: number,
  reason: string,
  refKey: string,
): Promise<{ awarded: boolean; balance: number }> {
  const points = POINT_VALUES[reason];
  if (!points) return { awarded: false, balance: await getBalance(childId) };

  const d = db();
  const dup = await d.get<{ id: number }>("SELECT id FROM points_ledger WHERE child_id = ? AND ref_key = ?", [
    childId,
    refKey,
  ]);
  if (dup) return { awarded: false, balance: await getBalance(childId) };

  await d.insert(
    "INSERT INTO points_ledger (child_id, delta, reason, ref_key, created_at) VALUES (?, ?, ?, ?, ?)",
    [childId, points, reason, refKey, nowIso()],
  );
  return { awarded: true, balance: await getBalance(childId) };
}

export async function listLedger(childId: number, limit = 100): Promise<LedgerEntry[]> {
  const d = db();
  const rows = await d.all<{ id: number; delta: number; reason: string; ref_key: string; created_at: string }>(
    "SELECT id, delta, reason, ref_key, created_at FROM points_ledger WHERE child_id = ? ORDER BY id DESC LIMIT ?",
    [childId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    delta: Number(r.delta),
    reason: r.reason,
    refKey: r.ref_key,
    createdAt: r.created_at,
  }));
}

export async function listRedemptions(childId: number, limit = 100): Promise<Redemption[]> {
  const d = db();
  const rows = await d.all<{ id: number; reward: string; cost: number; created_at: string }>(
    "SELECT id, reward, cost, created_at FROM redemptions WHERE child_id = ? ORDER BY id DESC LIMIT ?",
    [childId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    reward: r.reward,
    cost: Number(r.cost),
    createdAt: r.created_at,
  }));
}

/**
 * 每种奖励兑换一次折算出的「实物量」：平板按分钟计、现金按元计。
 * 与 REWARDS 一一对应，统计页靠它把兑换记录换算成孩子看得懂的总数。
 */
export const REWARD_META: Record<string, { screenMinutes?: number; moneyYuan?: number }> = {
  screen_30min: { screenMinutes: 30 },
  money_1yuan: { moneyYuan: 1 },
};

export interface RedemptionStats {
  screenCount: number;
  screenMinutes: number;
  moneyCount: number;
  moneyYuan: number;
}

/** 兑换累计统计：总共换了多久平板、多少钱 */
export async function getRedemptionStats(childId: number): Promise<RedemptionStats> {
  const d = db();
  const rows = await d.all<{ reward: string; cnt: number }>(
    "SELECT reward, COUNT(*) AS cnt FROM redemptions WHERE child_id = ? GROUP BY reward",
    [childId],
  );
  let screenCount = 0;
  let moneyCount = 0;
  for (const r of rows) {
    if (r.reward === "screen_30min") screenCount = Math.trunc(Number(r.cnt) || 0);
    else if (r.reward === "money_1yuan") moneyCount = Math.trunc(Number(r.cnt) || 0);
  }
  const screenMinutes = screenCount * (REWARD_META.screen_30min?.screenMinutes ?? 0);
  const moneyYuan = moneyCount * (REWARD_META.money_1yuan?.moneyYuan ?? 0);
  return { screenCount, screenMinutes, moneyCount, moneyYuan };
}

export interface RedemptionPage {
  items: Redemption[];
  total: number;
  page: number;
  pageSize: number;
}

/** 兑换记录分页查询（page 从 1 开始，按 id 倒序，最新的在前） */
export async function listRedemptionsPaged(
  childId: number,
  page: number,
  pageSize: number,
): Promise<RedemptionPage> {
  const d = db();
  const totalRow = await d.get<{ n: number }>("SELECT COUNT(*) AS n FROM redemptions WHERE child_id = ?", [
    childId,
  ]);
  const total = Math.max(0, Math.trunc(Number(totalRow?.n ?? 0) || 0));
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safeSize = Math.min(100, Math.max(1, Math.trunc(pageSize) || 10));
  const offset = (safePage - 1) * safeSize;
  const rows = await d.all<{ id: number; reward: string; cost: number; created_at: string }>(
    "SELECT id, reward, cost, created_at FROM redemptions WHERE child_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
    [childId, safeSize, offset],
  );
  const items = rows.map((r) => ({
    id: Number(r.id),
    reward: r.reward,
    cost: Number(r.cost),
    createdAt: r.created_at,
  }));
  return { items, total, page: safePage, pageSize: safeSize };
}

/**
 * 兑换：事务内先查余额，够则扣分（入账一条负流水）+ 生成兑换记录。
 * 余额不足抛出带 kind='insufficient' 的错误，路由层转成友好提示。
 */
export async function redeemPoints(
  childId: number,
  reward: Reward,
): Promise<{ balance: number; redemption: Redemption }> {
  const d = db();
  return d.tx(async (t) => {
    const cur = await t.get<{ s: number | null }>("SELECT SUM(delta) AS s FROM points_ledger WHERE child_id = ?", [
      childId,
    ]);
    const balance = Math.max(0, Math.trunc(Number(cur?.s ?? 0) || 0));
    if (balance < reward.cost) {
      const err = new Error("积分不够") as Error & { kind?: string };
      err.kind = "insufficient";
      throw err;
    }

    const refKey = `redeem:${Date.now()}`;
    await t.insert(
      "INSERT INTO points_ledger (child_id, delta, reason, ref_key, created_at) VALUES (?, ?, 'redeem', ?, ?)",
      [childId, -reward.cost, refKey, nowIso()],
    );
    const rid = await t.insert(
      "INSERT INTO redemptions (child_id, reward, cost, created_at) VALUES (?, ?, ?, ?)",
      [childId, reward.id, reward.cost, nowIso()],
    );
    return {
      balance: balance - reward.cost,
      redemption: { id: Number(rid), reward: reward.id, cost: reward.cost, createdAt: nowIso() },
    };
  });
}
