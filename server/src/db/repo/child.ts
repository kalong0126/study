/**
 * 仓储：孩子（主体）
 *
 * 目前只有一个孩子，但字段先留着——将来加二宝不用改表结构，
 * 所有学习数据都挂在 child_id 上，只要新增一行 children 就能隔离。
 */
import { db, nowIso } from "../index.js";

export async function ensureDefaultChild(name = "小朋友"): Promise<number> {
  const d = db();
  const row = await d.get<{ id: number }>("SELECT id FROM children ORDER BY id LIMIT 1");
  if (row) return Number(row.id);
  return d.insert("INSERT INTO children (name, created_at) VALUES (?, ?)", [name, nowIso()]);
}

export async function listChildren(): Promise<{ id: number; name: string }[]> {
  const d = db();
  const rows = await d.all<{ id: number; name: string }>("SELECT id, name FROM children ORDER BY id");
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}
