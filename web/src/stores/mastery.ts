/**
 * 掌握度 + 错题本 store
 *
 * 两者放在一起，是因为它们是同一件事的两面：
 *   · 某个字判为「未掌握」→ 自动进错字本（refKey = lessonId:字）
 *   · 判为「已掌握」→ 自动从错字本移除
 * 后端判卷服务写库时用的是同一套 refKey 规则，所以 AI 判卷和手工点选不会打架。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api";
import type { MasteryState, MathQuestion, WrongItem, WrongType } from "@/api/types";

export function chineseRefKey(lessonId: number, ch: string): string {
  return `${lessonId}:${ch}`;
}
export function mathRefKey(text: string): string {
  return `math:${text}`;
}

export const useMasteryStore = defineStore("mastery", () => {
  const mastery = ref<Record<string, Record<string, MasteryState>>>({});
  const wrong = ref<{ math: WrongItem[]; chinese: WrongItem[] }>({ math: [], chinese: [] });

  function snapshot(m: Record<string, Record<string, MasteryState>>, w: { math: WrongItem[]; chinese: WrongItem[] }): void {
    mastery.value = m ?? {};
    wrong.value = w ?? { math: [], chinese: [] };
  }

  /* ------------------------------------------------------------ 掌握度读 */

  function charState(lessonId: number, ch: string): MasteryState | undefined {
    return mastery.value[String(lessonId)]?.[ch];
  }

  function lessonStats(lessonId: number, chars: string[]): { ok: number; no: number; none: number } {
    const book = mastery.value[String(lessonId)] ?? {};
    let ok = 0;
    let no = 0;
    let none = 0;
    for (const ch of chars) {
      const s = book[ch];
      if (s === 1) ok++;
      else if (s === 0) no++;
      else none++;
    }
    return { ok, no, none };
  }

  const masteredCount = computed(() => {
    let n = 0;
    for (const book of Object.values(mastery.value)) {
      for (const v of Object.values(book)) if (v === 1) n++;
    }
    return n;
  });

  const wrongTotal = computed(() => wrong.value.math.length + wrong.value.chinese.length);

  /* ------------------------------------------------------------ 掌握度写 */

  /**
   * 幂等设置掌握状态，并同步错题本。
   * 乐观更新：先改本地再发请求，失败后回滚。
   */
  async function setCharState(
    lessonId: number,
    ch: string,
    state: MasteryState | null,
    opts: { lessonTitle?: string; skipWrongBook?: boolean } = {},
  ): Promise<void> {
    const key = String(lessonId);
    const prevBook = mastery.value[key];
    const prev = prevBook?.[ch];

    // ---- 乐观更新
    const book = { ...(mastery.value[key] ?? {}) };
    if (state === null) delete book[ch];
    else book[ch] = state;
    mastery.value = { ...mastery.value, [key]: book };

    try {
      const r = await api.setMastery({ lessonId, ch, state });
      mastery.value = r.mastery ?? mastery.value;
    } catch (e) {
      // ---- 回滚
      const rollback = { ...(mastery.value[key] ?? {}) };
      if (prev === undefined) delete rollback[ch];
      else rollback[ch] = prev;
      mastery.value = { ...mastery.value, [key]: rollback };
      throw e;
    }

    if (opts.skipWrongBook) return;

    // ---- 同步错题本（与后端判卷服务同一套 refKey）
    if (state === 0) {
      await addWrong("chinese", chineseRefKey(lessonId, ch), {
        char: ch,
        lessonId,
        lessonTitle: opts.lessonTitle ?? "",
      }).catch(() => undefined);
    } else if (state === 1) {
      await clearWrong({ type: "chinese", refKey: chineseRefKey(lessonId, ch) }).catch(() => undefined);
    }
  }

  /** 点击生字上的 ✓ / ✗ ：再点一次同一边 = 取消标记 */
  async function toggleChar(lessonId: number, ch: string, target: MasteryState, lessonTitle?: string): Promise<"set" | "cleared"> {
    const now = charState(lessonId, ch);
    if (now === target) {
      await setCharState(lessonId, ch, null, { lessonTitle });
      return "cleared";
    }
    await setCharState(lessonId, ch, target, { lessonTitle });
    return "set";
  }

  /* -------------------------------------------------------------- 错题本 */

  async function addWrong(type: WrongType, refKey: string, payload: Record<string, unknown>): Promise<boolean> {
    const r = await api.addWrong({ type, refKey, payload });
    if (r.duplicated) return false;
    // 本地补一条，避免再拉一次全量
    if (r.id !== null) {
      const item: WrongItem = {
        id: r.id,
        type,
        refKey,
        payload,
        createdAt: new Date().toISOString(),
      };
      wrong.value = { ...wrong.value, [type]: [...wrong.value[type], item] };
    }
    return true;
  }

  async function addWrongMath(q: MathQuestion, date: string): Promise<boolean> {
    return addWrong("math", mathRefKey(q.text), { text: q.text, ans: q.ans, date });
  }

  async function clearWrong(opts: { all?: boolean; id?: number; type?: WrongType; refKey?: string }): Promise<number> {
    const r = await api.clearWrong(opts);
    if (r.wrong) wrong.value = r.wrong;
    return r.removed;
  }

  /** 重新挑战成功 → 擦掉这一题 */
  async function removeWrongItem(type: WrongType, id: number): Promise<void> {
    await clearWrong({ id });
    // 保险起见，本地也剔一遍（clearWrong 已回传全量，这里只是兜底）
    wrong.value = { ...wrong.value, [type]: wrong.value[type].filter((w) => w.id !== id) };
  }

  function wrongMath(): WrongItem[] {
    return wrong.value.math;
  }
  function wrongChinese(): WrongItem[] {
    return wrong.value.chinese;
  }

  return {
    mastery,
    wrong,
    snapshot,
    charState,
    lessonStats,
    masteredCount,
    wrongTotal,
    setCharState,
    toggleChar,
    addWrong,
    addWrongMath,
    clearWrong,
    removeWrongItem,
    wrongMath,
    wrongChinese,
  };
});
