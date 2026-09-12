/**
 * 当前孩子上下文
 *
 * 内网部署不做鉴权，所以「当前孩子」就是库里第一条 children 记录。
 * 表结构已经按 child_id 分好了，将来加二宝只要多一行数据 + 一个切换开关。
 */
import { ensureDefaultChild } from "../db/repo/child.js";

let cachedId: number | null = null;

export async function currentChildId(): Promise<number> {
  if (cachedId) return cachedId;
  cachedId = await ensureDefaultChild();
  return cachedId;
}

export function resetChildCache(): void {
  cachedId = null;
}
