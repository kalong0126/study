/**
 * 进度 store：每日打卡 + 口算 + 错题复习
 *
 * 完成标准（沿用原版，孩子和家长都已习惯）：
 *   · 口算：20 题**全部作答**即算完成，答错也算；全对额外给满分庆祝
 *   · 听写：一轮至少写完 3 个字
 *   · 阅读：计时满 15 分钟（或手动结束且已读超过 20 秒）
 *   · 错题：重做 `reviewTarget` 道（**不是写死的 3 道**，见下）
 *
 * 错题复习这块有两个和别处不一样的规矩：
 *   1. **必须等口算和听写都做完**才能开始。因为这两项会往错题本里加题，
 *      边做边复习的话「要复习几道」这个数一直在变。
 *   2. 目标题数在开闸那一刻定死（`min(3, 当时待复习数)`）并写进服务端，之后不再变。
 *      否则明明只错了 1 道却按 3 道算，孩子把唯一那道改对了任务也完不成。
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { api } from "@/api";
import type { DailyState, MathQuestion, MathSetState, StateSnapshot, TaskKey } from "@/api/types";
import { useMasteryStore } from "./mastery";
import { useUiStore } from "./ui";
import { lsGet, lsSet, randInt, shuffle, todayStr } from "@/utils/local";

export interface TaskDef {
  key: TaskKey;
  name: string;
  desc: string;
  route: string;
  tone: "blue" | "orange" | "purple" | "green";
}

export const TASK_DEFS: TaskDef[] = [
  { key: "math", name: "每日口算", desc: "20 道题全部作答", route: "/math", tone: "blue" },
  { key: "dictation", name: "语文听写一轮", desc: "选一篇课文，完成一轮听写", route: "/chinese", tone: "orange" },
  { key: "reading", name: "童话阅读 15 分钟", desc: "读一篇注音童话，计时满 15 分钟", route: "/story", tone: "purple" },
  { key: "review", name: "错题复习", desc: "把错题本里的错题重做一遍", route: "/wrong", tone: "green" },
];

/** 错题复习一轮最多重做几道（与服务端 REVIEW_MAX 保持一致） */
export const REVIEW_MAX = 3;

/** 开始复习前必须先完成的任务：它们会往错题本里加题 */
const REVIEW_GATE: TaskKey[] = ["math", "dictation"];

const MATH_LOCAL_KEY = "mathLocal";
const MATH_COUNT = 20;

interface MathLocal {
  date: string;
  sig: string;
  answers: Record<string, string>;
  wrongAdded: Record<string, boolean>;
  perfect: boolean;
}

function blankDaily(date: string): DailyState {
  return {
    date,
    tasks: { math: false, dictation: false, reading: false, review: false },
    reviewCount: 0,
    reviewTarget: null,
  };
}

/** 出题：10 道表内乘法 + 5 加法 + 5 减法，去重后打乱 */
export function makeMathSet(date = todayStr()): MathSetState {
  const qs: MathQuestion[] = [];
  const seen = new Set<string>();
  const push = (q: MathQuestion): boolean => {
    if (seen.has(q.text) || qs.length >= MATH_COUNT) return false;
    seen.add(q.text);
    qs.push(q);
    return true;
  };

  let guard = 0;
  while (qs.length < 10 && guard++ < 400) {
    const a = randInt(2, 9);
    const b = randInt(2, 9);
    push({ op: "×", a, b, text: `${a} × ${b} =`, ans: a * b });
  }
  guard = 0;
  let addCount = 0;
  while (addCount < 5 && guard++ < 400) {
    const x = randInt(10, 89);
    const y = randInt(2, Math.min(99 - x, 40));
    if (y < 2 || x + y > 100) continue;
    if (push({ op: "+", a: x, b: y, text: `${x} + ${y} =`, ans: x + y })) addCount++;
  }
  guard = 0;
  let subCount = 0;
  while (subCount < 5 && guard++ < 400) {
    const m = randInt(21, 99);
    const n = randInt(2, m - 1);
    if (m - n > 100) continue;
    if (push({ op: "-", a: m, b: n, text: `${m} - ${n} =`, ans: m - n })) subCount++;
  }
  guard = 0;
  while (qs.length < MATH_COUNT && guard++ < 900) {
    const t = Math.random();
    if (t < 0.4) {
      const p = randInt(2, 9);
      const q = randInt(2, 9);
      push({ op: "×", a: p, b: q, text: `${p} × ${q} =`, ans: p * q });
    } else if (t < 0.7) {
      const u = randInt(11, 80);
      const v = randInt(2, 95 - u);
      if (v < 1) continue;
      push({ op: "+", a: u, b: v, text: `${u} + ${v} =`, ans: u + v });
    } else {
      const s1 = randInt(21, 99);
      const s2 = randInt(2, s1 - 1);
      push({ op: "-", a: s1, b: s2, text: `${s1} - ${s2} =`, ans: s1 - s2 });
    }
  }
  return { date, qs: shuffle(qs).slice(0, MATH_COUNT), results: {} };
}

export const useProgressStore = defineStore("progress", () => {
  const date = ref(todayStr());
  const daily = ref<DailyState>(blankDaily(todayStr()));
  const mathSet = ref<MathSetState | null>(null);
  const mathBusy = ref(false);

  // 只在本地保留的辅助信息：孩子输入的原始答案、已入错题本的题号、满分是否已庆祝
  const answers = ref<Record<string, string>>({});
  const wrongAdded = ref<Record<string, boolean>>({});
  const perfect = ref(false);

  const mathSig = computed(() => (mathSet.value?.qs ?? []).map((q) => q.text).join("|"));

  function persistMathLocal(): void {
    const payload: MathLocal = {
      date: date.value,
      sig: mathSig.value,
      answers: answers.value,
      wrongAdded: wrongAdded.value,
      perfect: perfect.value,
    };
    lsSet(MATH_LOCAL_KEY, payload);
  }

  function restoreMathLocal(): void {
    const saved = lsGet<MathLocal | null>(MATH_LOCAL_KEY, null);
    if (saved && saved.date === date.value && saved.sig === mathSig.value) {
      answers.value = saved.answers ?? {};
      wrongAdded.value = saved.wrongAdded ?? {};
      perfect.value = !!saved.perfect;
    } else {
      answers.value = {};
      wrongAdded.value = {};
      perfect.value = false;
    }
  }

  function applySnapshot(s: StateSnapshot): void {
    // 先把还在跑的计时收尾并回写 —— 此刻 date 还是旧日期，跨天重载时才不会把时间记到新的一天
    pauseMathTimer();
    date.value = s.date;
    daily.value = s.daily ?? blankDaily(s.date);
    mathSet.value = s.mathSet;
    mathElapsedMs.value = Math.max(0, Number(s.mathElapsedMs) || 0);
    if (!mathSet.value) {
      answers.value = {};
      wrongAdded.value = {};
      perfect.value = false;
      mathElapsedMs.value = 0;
    } else {
      restoreMathLocal();
      // 结果里已有判定的题，把答案回填成正确答案，刷新后不至于空着
      for (const [k, v] of Object.entries(mathSet.value.results ?? {})) {
        if (v === "ok" && !answers.value[k]) {
          const q = mathSet.value.qs[Number(k)];
          if (q) answers.value[k] = String(q.ans);
        }
      }
      // 已经全对过的，别再庆祝一次
      if (mathAnswered.value >= mathTotal.value && mathCorrect.value >= mathTotal.value) perfect.value = true;
    }
  }

  /* -------------------------------------------------------------- 打卡 */

  const completedCount = computed(() => TASK_DEFS.filter((d) => daily.value.tasks[d.key]).length);
  const allDone = computed(() => completedCount.value >= TASK_DEFS.length);

  function isDone(key: TaskKey): boolean {
    return !!daily.value.tasks[key];
  }

  /** 完成一项任务。返回 true 表示「这一步刚好凑满全部任务」 */
  async function completeTask(key: TaskKey, opts: { silent?: boolean } = {}): Promise<boolean> {
    if (daily.value.tasks[key]) return false;
    const ui = useUiStore();
    daily.value = { ...daily.value, tasks: { ...daily.value.tasks, [key]: true } };

    api.patchDaily({ date: date.value, tasks: { [key]: true } }).catch(() => {
      daily.value = { ...daily.value, tasks: { ...daily.value.tasks, [key]: false } };
      ui.toast("这一步没能保存到服务器，检查一下网络");
    });

    const c = completedCount.value;
    if (c >= TASK_DEFS.length) {
      ui.showBanner("你太棒了！🎉", "今日 4 项任务全部完成");
      return true;
    }
    if (!opts.silent) {
      const def = TASK_DEFS.find((d) => d.key === key);
      ui.toast(`「${def?.name ?? "任务"}」已完成！还差 ${TASK_DEFS.length - c} 项`);
      ui.celebrate();
    }
    return false;
  }

  /* ---------------------------------------------------------- 错题复习 */

  /** 错题本里还有几道待复习（数学 + 语文） */
  const reviewRemaining = computed(() => useMasteryStore().wrongTotal);

  /** 前置条件：口算 + 听写都做完了才允许复习错题（这两项会往错题本里加题） */
  const reviewOpen = computed(() => REVIEW_GATE.every((k) => isDone(k)));

  const reviewCount = computed(() => daily.value.reviewCount || 0);
  const reviewTarget = computed(() => daily.value.reviewTarget);

  /**
   * 完成判定：**错题本空了就算完成**，否则要重做到冻结的目标数。
   * 「空了就完成」这条是兜底 —— 家长可能在后台清空错题本，那时目标数已经冻结，
   * 不给这条兜底孩子就会「无题可做但任务永远差几道」。
   */
  const reviewDone = computed(() => {
    if (!reviewOpen.value) return false;
    if (reviewRemaining.value === 0) return true;
    const t = reviewTarget.value;
    return t !== null && reviewCount.value >= t;
  });

  /**
   * 能不能动手重做：开闸了就能；今天的复习**已经完成**的话也不再拦 ——
   * 否则会出现「任务卡显示已完成、进去却说未解锁」的自相矛盾
   * （老数据里 reviewTarget 可能还是 null，就是这种情况）。
   */
  const canReview = computed(() => reviewOpen.value || isDone("review"));

  /**
   * 分母的展示值。优先级：冻结的目标（>0）→ 已做数 → 上限。
   * 特别处理目标为 0（开闸时错题本就是空的）：如果老数据里还残留着已做数，
   * 就按已做数兜底，绝不能写出「已完成 3 / 0 道」这种自相矛盾的分母。
   */
  const reviewTotal = computed(() => {
    const t = reviewTarget.value;
    if (t !== null && t > 0) return t;
    if (reviewCount.value > 0) return reviewCount.value;
    return t === 0 ? 0 : REVIEW_MAX;
  });

  /** 首页任务卡 / 错题页顶部显示用的一句话 */
  const reviewText = computed(() => {
    // 做过就优先报成绩：不管它是「做满目标」「本来就没错题」还是「家长把错题清空了」完成的。
    // 否则擦掉最后一道的瞬间会从「已完成 3/3」掉成「错题本是空的」，孩子看着像白做了。
    if (reviewCount.value > 0) return `已完成 ${reviewCount.value} / ${reviewTotal.value} 道`;
    if (isDone("review")) return "错题本是空的，没有要复习的";
    if (!canReview.value) return "先完成口算和听写，再来复习错题";
    return `已完成 0 / ${reviewTotal.value} 道`;
  });

  let reviewSyncing = false;

  /**
   * 开闸 + 收尾，幂等，任何时候调用都安全：
   *   · 前置任务没完成 → 什么也不做（目标保持 null）
   *   · 前置完成但还没冻结 → 让服务端算好并冻结目标数（`min(3, 当时待复习数)`）
   *   · 已经满足完成条件（例如错题本是空的）→ 静默把任务打勾
   */
  async function syncReview(): Promise<void> {
    if (reviewSyncing) return;
    if (!reviewOpen.value) return;
    reviewSyncing = true;
    try {
      if (daily.value.reviewTarget === null) {
        const r = await api.openReview({ date: date.value });
        if (r?.daily) daily.value = r.daily;
      }
    } catch {
      // 开闸失败不打扰孩子，下次触发会再试
    } finally {
      reviewSyncing = false;
    }
    if (reviewDone.value && !isDone("review")) await completeTask("review", { silent: true });
  }

  async function bumpReview(): Promise<void> {
    if (!reviewOpen.value) return; // 没开闸不该计入（界面上此时也是禁用的）
    const next = reviewCount.value + 1;
    daily.value = { ...daily.value, reviewCount: next };
    api.patchDaily({ date: date.value, reviewCount: next }).catch(() => undefined);
    if (reviewDone.value) await completeTask("review");
  }

  /**
   * 「前置完成度 / 目标数 / 计数 / 错题本数量」任一变化就重新对一遍。
   * 放在 watch 里而不是散在各处手动调用，是因为会改动这几项的地方太多
   * （口算判分、听写判卷、复习擦题、后台清空错题本），漏一处任务就会卡在「差一道」。
   */
  watch(
    () => [
      daily.value.tasks.math,
      daily.value.tasks.dictation,
      daily.value.reviewTarget,
      daily.value.reviewCount,
      reviewRemaining.value,
    ],
    () => void syncReview(),
    { immediate: true },
  );

  /* -------------------------------------------------------------- 口算 */

  const mathTotal = computed(() => mathSet.value?.qs.length ?? MATH_COUNT);
  const mathAnswered = computed(() => {
    const r = mathSet.value?.results ?? {};
    return (mathSet.value?.qs ?? []).filter((_, i) => r[i] === "ok" || r[i] === "bad").length;
  });
  const mathCorrect = computed(() => Object.values(mathSet.value?.results ?? {}).filter((v) => v === "ok").length);
  const mathPerfect = computed(() => mathAnswered.value >= mathTotal.value && mathCorrect.value >= mathTotal.value);
  const mathPct = computed(() => (mathTotal.value ? Math.round((mathAnswered.value / mathTotal.value) * 100) : 0));
  const mathWrongCount = computed(() => Object.values(mathSet.value?.results ?? {}).filter((v) => v === "bad").length);

  /* ---------------------------------------------------- 口算计时（自动） */

  /**
   * 计时规则：
   *   · 进入口算页**自动开始**，不需要孩子点「开始」
   *   · 离开页面 / 页面切到后台 → 暂停并回写；离开期间不计入（去喝口水不该算用时）
   *   · 20 题全部作答 → 停止并锁定，这个数就是「用时」
   *   · 「换一批题目」→ 归零重来
   *
   * 回写服务端的是**当天累计毫秒的绝对值**，不是增量 —— 所以重试、重复提交都不会把
   * 时间越加越多。中途直接关掉标签页最多丢 15 秒（见 FLUSH_MS 的兜底回写）。
   */
  const FLUSH_MS = 15_000;

  const mathElapsedMs = ref(0); // 已累计的部分（不含正在跑的这一段）
  const mathTimerRunning = ref(false);
  const mathTimerNow = ref(Date.now()); // 每秒 tick，驱动界面上的计时刷新
  let mathTimerStart = 0; // 本段开始时刻
  let mathTick: number | null = null;
  let mathFlushedAt = 0;

  /** 20 题全部作答 = 做完 */
  const mathDone = computed(() => mathAnswered.value >= mathTotal.value);

  /** 当前总用时（毫秒）= 已累计 + 本段正在跑的 */
  const mathElapsedNow = computed(
    () => mathElapsedMs.value + (mathTimerRunning.value ? Math.max(0, mathTimerNow.value - mathTimerStart) : 0),
  );
  const mathElapsedSec = computed(() => Math.floor(mathElapsedNow.value / 1000));

  /** mm:ss —— 口算页上的实时计时 */
  const mathClock = computed(() => {
    const s = mathElapsedSec.value;
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  });

  /** 「3 分 12 秒」—— 首页展示用 */
  const mathElapsedText = computed(() => {
    const s = mathElapsedSec.value;
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  });

  /** 把当前累计总数回写服务端（幂等覆盖） */
  async function flushMathElapsed(): Promise<void> {
    const ms = mathElapsedNow.value;
    try {
      const r = await api.setMathElapsed({ date: date.value, ms });
      // 只在没在计时的时候采纳服务端的值：正在跑时那一段还没并进 mathElapsedMs，
      // 直接覆盖会把「正在跑的这段」算两遍。
      if (!mathTimerRunning.value && typeof r?.mathElapsedMs === "number") {
        mathElapsedMs.value = r.mathElapsedMs;
      }
    } catch {
      // 计时保存失败不打扰孩子；下一次 tick / 暂停时还会再试
    }
  }

  function tickMathTimer(): void {
    mathTimerNow.value = Date.now();
    if (mathTimerRunning.value && mathTimerNow.value - mathFlushedAt >= FLUSH_MS) {
      mathFlushedAt = mathTimerNow.value;
      void flushMathElapsed();
    }
  }

  function startMathTimer(): void {
    if (mathTimerRunning.value) return;
    if (mathDone.value) return; // 已经做完 → 用时已定，不再计时
    mathTimerStart = Date.now();
    mathTimerNow.value = mathTimerStart;
    mathFlushedAt = mathTimerStart;
    mathTimerRunning.value = true;
    if (mathTick === null) mathTick = window.setInterval(tickMathTimer, 1000);
  }

  function pauseMathTimer(): void {
    if (!mathTimerRunning.value) return;
    mathElapsedMs.value += Math.max(0, Date.now() - mathTimerStart);
    mathTimerRunning.value = false;
    mathTimerNow.value = Date.now();
    if (mathTick !== null) {
      window.clearInterval(mathTick);
      mathTick = null;
    }
    void flushMathElapsed();
  }

  /** 换新题组时归零 */
  function resetMathElapsed(): void {
    mathElapsedMs.value = 0;
    mathTimerNow.value = Date.now();
    if (mathTimerRunning.value) mathTimerStart = mathTimerNow.value;
    mathFlushedAt = mathTimerNow.value;
  }


  function resultOf(idx: number): string {
    return mathSet.value?.results?.[String(idx)] ?? "";
  }

  async function newMathSet(): Promise<void> {
    const ui = useUiStore();
    mathBusy.value = true;
    try {
      const fresh = makeMathSet(date.value);
      const r = await api.createMathSet({ date: date.value, qs: fresh.qs, results: {} });
      mathSet.value = r.mathSet ?? fresh;
      answers.value = {};
      wrongAdded.value = {};
      perfect.value = false;
      resetMathElapsed(); // 换了一批题 → 计时归零
      persistMathLocal();
      ui.toast("换了一批新题目，加油！");
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : "换题失败");
    } finally {
      mathBusy.value = false;
    }
  }

  async function ensureMathSet(): Promise<void> {
    if (mathSet.value?.qs?.length) return;
    const ui = useUiStore();
    try {
      const fresh = makeMathSet(date.value);
      const r = await api.createMathSet({ date: date.value, qs: fresh.qs, results: {} });
      mathSet.value = r.mathSet ?? fresh;
      answers.value = {};
      wrongAdded.value = {};
      perfect.value = false;
      resetMathElapsed(); // 全新题组 → 计时从头开始
      persistMathLocal();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : "题目加载失败");
    }
  }

  /**
   * 输入判分：与原版规则一致
   *   · 完全等于答案 → ok，叮咚
   *   · 输入长度已达到答案长度且不等于答案 → bad，进错题本，嗡
   *   · 之前判错、现在删短了 → 撤销判定
   */
  async function inputMath(idx: number, value: string): Promise<void> {
    const set = mathSet.value;
    const q = set?.qs[idx];
    if (!set || !q) return;
    const ui = useUiStore();
    const mastery = useMasteryStore();
    const v = value.trim();
    const ansStr = String(q.ans);
    const prev = resultOf(idx);

    answers.value = { ...answers.value, [idx]: v };

    let next = prev;
    if (v === ansStr) next = "ok";
    else if (v.length >= ansStr.length && v.length > 0) next = "bad";
    else if (prev === "bad") next = "";

    if (next === prev) {
      persistMathLocal();
      return;
    }

    // 乐观更新
    const results = { ...(set.results ?? {}) };
    if (next) results[idx] = next;
    else delete results[idx];
    set.results = results;

    if (next === "ok") {
      ui.celebrate();
    } else if (next === "bad") {
      ui.toast("答错啦，已放进错题小本本");
      if (!wrongAdded.value[idx]) {
        wrongAdded.value = { ...wrongAdded.value, [idx]: true };
        // 后端按 refKey 去重，这里只是减少重复请求
        const fresh = await mastery.addWrongMath(q, date.value).catch(() => false);
        if (!fresh) wrongAdded.value = { ...wrongAdded.value, [idx]: true };
      }
    }
    persistMathLocal();

    try {
      await api.setMathResult({ date: date.value, idx, value: next });
    } catch {
      ui.toast("这一题的判定没能保存，检查一下网络");
    }

    await checkMathDone();
  }

  /** 20 题全部作答 → 完成任务；全对 → 满分庆祝 */
  async function checkMathDone(): Promise<void> {
    if (!mathSet.value?.qs?.length) return;
    if (mathAnswered.value < mathTotal.value) return;
    // 做完就停表：这个数就是首页上要展示的「用时」。
    // 这里再 **await** 一次回写（pauseMathTimer 里那次是 fire-and-forget），
    // 保证孩子做完立刻刷新时，首页读到的一定是最终值，而不是上一秒的旧值。
    pauseMathTimer();
    await flushMathElapsed();
    const filled = await completeTask("math");
    if (mathCorrect.value < mathTotal.value) return;
    if (perfect.value) return;
    perfect.value = true;
    persistMathLocal();
    const ui = useUiStore();
    ui.celebratePerfect(filled ? "20 道全对，今天的任务也全部完成啦" : "20 道口算一道都没错，太厉害啦");
  }

  /** 兼容旧存档：已作答满 20 题但任务没打勾的，静默补上 */
  async function syncMathTaskFlag(): Promise<void> {
    if (!mathSet.value?.qs?.length) return;
    if (mathAnswered.value >= mathTotal.value && !isDone("math")) {
      daily.value = { ...daily.value, tasks: { ...daily.value.tasks, math: true } };
      await api.patchDaily({ date: date.value, tasks: { math: true } }).catch(() => undefined);
    }
  }

  return {
    date,
    daily,
    mathSet,
    mathBusy,
    answers,
    wrongAdded,
    perfect,
    mathSig,
    applySnapshot,
    completedCount,
    allDone,
    isDone,
    completeTask,
    bumpReview,
    reviewOpen,
    reviewCount,
    reviewTarget,
    reviewTotal,
    reviewRemaining,
    reviewDone,
    canReview,
    reviewText,
    syncReview,
    mathTotal,
    mathAnswered,
    mathCorrect,
    mathPerfect,
    mathPct,
    mathWrongCount,
    mathDone,
    mathElapsedMs,
    mathTimerRunning,
    mathElapsedSec,
    mathClock,
    mathElapsedText,
    startMathTimer,
    pauseMathTimer,
    resetMathElapsed,
    resultOf,
    newMathSet,
    ensureMathSet,
    inputMath,
    checkMathDone,
    syncMathTaskFlag,
  };
});
