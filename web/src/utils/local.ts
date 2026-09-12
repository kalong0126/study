/**
 * 本地小工具：只存「纯界面偏好」这类不需要进数据库的东西。
 * 学习数据一律走 API，localStorage 只留当前选中的课文和口算打字缓存。
 */

const PREFIX = "g2_local:";

export function lsGet<T>(key: string, def: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return def;
    return JSON.parse(raw) as T;
  } catch {
    return def;
  }
}

export function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* 存不下就算了，不影响主流程 */
  }
}

export function lsDel(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* 忽略 */
  }
}

export function todayStr(d = new Date()): string {
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function randInt(a: number, b: number): number {
  return a + Math.floor(Math.random() * (b - a + 1));
}
