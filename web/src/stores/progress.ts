/**
 * 进度 store：每日打卡 + 口算 + 错题复习
 *
 * 完成标准（沿用原版，孩子和家长都已习惯）：
 *   · 口算：20 题**全部作答**即算完成，答错也算；全对额外给满分庆祝
 *   · 听写：一轮至少写完 3 个字
 *   · 阅读：计时满 15 分钟（或手动结束且已读超过 20 秒）
 *   · 语言强化：9 道题**全部**做完才算完成，加 20 分（少一道一分不给）
 *   · 英文故事：随机抽一集，**完整看完**（实看 ≥ 90% 时长）才算完成，加 10 分
 *   · 错题：重做 `reviewTarget` 道（**不是写死的 3 道**，见下）
 *
 * 语言强化与英文故事这两项的完成标准都不在这里判 ——
 * `languageProgress:<date>` 里那 9 道小题的作答状态、`videoWatch:<date>` 里的观看时长才是真相，
 * 后端每次作答 / 每次上报进度后重算并回写打卡标记。
 * 本 store 只负责「把页面新拿到的状态同步进来」（`syncLanguage` / `syncVideo`）与展示，
 * 这样孩子在别处（换设备 / 家长判定）做完，首页也不会漏。
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
import type { DailyState, MathQuestion, MathSetState, Redemption, StateSnapshot, TaskKey } from "@/api/types";
import { useMasteryStore } from "./mastery";
import { useUiStore } from "./ui";
import { lsGet, lsSet, randInt, shuffle, todayStr } from "@/utils/local";

export interface TaskDef {
  key: TaskKey;
  /** 首页小岛地图上的岛名（也用于「完成」提示），家长和孩子都认这个叫法 */
  name: string;
  desc: string;
  route: string;
  /** 岛上的图标名（Icon.vue 的键） */
  icon: string;
  /** 这一关的主色：岛屿草地上的图标、进度胶囊、已完成的旗子都用它 */
  color: string;
  /** 做完这一关能拿几分（0 = 不发分，只清错题）。仅用于展示，真正的发分在后端 */
  reward: number;
  /** 还没产生真实进度时，岛标签下写的短说明 */
  hint: string;
}

/**
 * 六关的顺序 = 首页地图从左到右的顺序，**也决定解锁顺序**：
 * 第 N 关只有在第 1..N-1 关全部完成后才解锁（见 isUnlocked）。
 *
 * 两条排法上的讲究：
 *   · **错题修理站紧跟在口算、听写后面**。错题就是这两关做错时攒下的，
 *     刚做完口算想立刻订正却被告知「先去读 15 分钟故事」，孩子只会把错题扔到明天。
 *     顺带一个好消息：它排第 3 位，解锁条件正好等于原有的错题开闸条件
 *     （`REVIEW_GATE` = 口算 + 听写），两套规则天然一致，不需要各让一步。
 *   · **英文小屋（video）刻意排在最后**：它是「看一集动画」，六项里最省力，
 *     放末位当奖励 —— 前面五关啃完，正好痛快看一集收尾。
 *
 * 顺序只影响孩子端的展示与解锁；后端只按 `TASK_KEYS.every()` 判全勤，与顺序无关。
 */
export const TASK_DEFS: TaskDef[] = [
  {
    key: "math",
    name: "口算岛",
    desc: "20 道题全部作答",
    route: "/math",
    icon: "math",
    color: "#4FA3DC",
    reward: 10,
    hint: "20 道题",
  },
  {
    key: "dictation",
    name: "听写屋",
    desc: "选一篇课文，完成一轮听写",
    route: "/chinese",
    icon: "chinese",
    color: "#E8834E",
    reward: 10,
    hint: "完成一轮",
  },
  {
    key: "review",
    name: "错题修理站",
    desc: "把错题本里的错题重做一遍",
    route: "/wrong",
    icon: "wrong",
    color: "#3FBF8F",
    reward: 0,
    hint: "重做错题",
  },
  {
    key: "reading",
    name: "故事树",
    desc: "读一篇注音童话，计时满 15 分钟",
    route: "/story",
    icon: "story",
    color: "#8E7BEF",
    reward: 20,
    hint: "读满 15 分钟",
  },
  {
    key: "language",
    name: "语言练习",
    desc: "9 道题全部做完可得 20 分",
    route: "/language",
    icon: "wand",
    color: "#FF7FA0",
    reward: 20,
    hint: "9 道题",
  },
  {
    key: "video",
    name: "英文小屋",
    desc: "看一集英文故事，完整看完得 10 分",
    route: "/video",
    icon: "video",
    color: "#2FA8A0",
    reward: 10,
    hint: "看一集",
  },
];

/** 路由路径 → 任务。关卡顺序锁要在导航前把「孩子点的是哪一关」认出来 */
export const ROUTE_TASK: Record<string, TaskKey> = Object.fromEntries(
  TASK_DEFS.map((d) => [d.route, d.key]),
) as Record<string, TaskKey>;

/** 错题复习一轮最多重做几道（与服务端 REVIEW_MAX 保持一致） */
export const REVIEW_MAX = 3;

/**
 * 积分规则（与服务端 db/repo/points.ts 保持一致）：
 *   · 口算完成 +10、听写完成 +10、阅读完成 +20、语言强化 9/9 完成 +20、全部完成 +10（后端自动发）
 *   · 口算全对 +10、听写全对 +10（前端判定全对后调 awardPoints）
 */
export const REWARDS = [
  { id: "screen_30min", label: "半小时平板娱乐时间", cost: 50 },
  { id: "money_1yuan", label: "1 块钱", cost: 50 },
] as const;

export function rewardLabel(id: string): string {
  return REWARDS.find((r) => r.id === id)?.label ?? id;
}

/** 语言强化每天固定 9 道题（没有题集时也要有个像样的分母） */
export const LANGUAGE_TOTAL = 9;

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
    tasks: { math: false, dictation: false, reading: false, language: false, video: false, review: false },
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

  /**
   * 服务端那份当日状态是否已经拿到手。
   *
   * 只有它才能回答「现在能进哪一关」—— 在拿到之前，本地 daily 是一张全 false 的
   * 空白表，照它判定会把已经做完的关也当成没做（把做过口算的孩子挡在听写屋外面）。
   * 所以路由守卫在 loaded 之前一律放行（fail-open）。
   */
  const loaded = ref(false);

  /** 积分余额（跨天累计钱包）与最近的兑换记录 */
  const balance = ref(0);
  const redemptions = ref<Redemption[]>([]);

  /** 语言强化当天的进度：首页任务卡上写「已完成 N / 9 题」用 */
  const languageDone = ref(0);
  const languageTotal = ref(LANGUAGE_TOTAL);

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
    loaded.value = true;
    mathSet.value = s.mathSet;
    mathElapsedMs.value = Math.max(0, Number(s.mathElapsedMs) || 0);
    balance.value = Math.max(0, Number(s.balance) || 0);
    redemptions.value = s.redemptions ?? [];
    languageDone.value = Math.max(0, Number(s.language?.done) || 0);
    languageTotal.value = Math.max(0, Number(s.language?.total) || 0) || LANGUAGE_TOTAL;
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

  /* ------------------------------------------------ 关卡顺序（小岛地图） */

  /**
   * 参与顺序锁的关卡。
   *
   * **错题修理站不在里面** —— 它是「随时能去的工具站」，不是一条要按顺序走的关卡：
   *   · 错题本该是想看就看的东西。孩子做口算错了 2 道，正想翻开来看看，
   *     却被挡回去「先读完 15 分钟故事」，那这本错题从此就没人翻第二遍。
   *   · 它自己那一层闸更合适：`REVIEW_GATE`（口算 + 听写做完才允许**重做**，随时可以**看**），
   *     WrongView 页内的 `.wb-lock` 提示条就是干这个的。
   *   · 如果这里也硬拦，「只看不改」那套提示与禁用输入的逻辑就永远走不到 —— 变成死代码。
   *
   * 所以地图上它排在口算、听写后面（修错题要趁热），但不参与「做过才解锁下一座」。
   */
  const LOCK_CHAIN = TASK_DEFS.filter((d) => d.key !== "review");

  /**
   * 当前这一关 = 链上第一个还没完成的任务；链走完了就等于链长（此时地图上不该再有锁）。
   *
   * 首页地图和导航守卫都要回答「现在能进哪一关」，所以只在这里算一次 ——
   * 两处各写一遍「哪一关是当前关」，迟早会算出不一样的结果（一处说能进、一处说锁着）。
   */
  const chainIndex = computed(() => {
    const i = LOCK_CHAIN.findIndex((d) => !daily.value.tasks[d.key]);
    return i === -1 ? LOCK_CHAIN.length : i;
  });

  function indexOfTask(key: TaskKey): number {
    return TASK_DEFS.findIndex((d) => d.key === key);
  }

  /**
   * 当前这一关（小岛地图上要打「出发」+ 呼吸圈的那一座）在 TASK_DEFS 里的下标。
   * 链走完时返回关数（越界 → 地图上谁都不是当前关）。
   */
  const currentIndex = computed(() => {
    const key = LOCK_CHAIN[chainIndex.value]?.key;
    return key === undefined ? TASK_DEFS.length : indexOfTask(key);
  });

  /**
   * 这一关能不能进。
   *   · 错题修理站永远可以进（工具站，闸在它自己页面里）
   *   · 其余按链上的先后：前面的都完成了才轮到它，已完成的关永远可以回去重做
   */
  function isUnlocked(key: TaskKey): boolean {
    if (key === "review") return true;
    const i = LOCK_CHAIN.findIndex((d) => d.key === key);
    return i === -1 ? true : i <= chainIndex.value;
  }

  /**
   * 被挡住时该点名的那一关。链上顺序只有一条，所以任何被锁的任务前面挡着的都是同一关
   * （当前这一关）—— 说「先闯过故事树」比「先完成前面的任务」有用得多。
   */
  const currentTaskName = computed(() => LOCK_CHAIN[chainIndex.value]?.name ?? "");

  /** 完成一项任务。返回 true 表示「这一步刚好凑满全部任务」 */
  async function completeTask(key: TaskKey, opts: { silent?: boolean } = {}): Promise<boolean> {
    if (daily.value.tasks[key]) return false;
    const ui = useUiStore();
    daily.value = { ...daily.value, tasks: { ...daily.value.tasks, [key]: true } };

    try {
      const r = await api.patchDaily({ date: date.value, tasks: { [key]: true } });
      // 完成类积分由后端在 setTaskDone 链路自动入账，这里用返回的余额实时刷新「我的积分」。
      // 必须 await：口算/听写全对时，这里会和 awardPoints 并发（本函数没等，调用方紧接着就发全对奖），
      // 若不等待，patchDaily 的旧余额快照可能后到，把 awardPoints 已刷新的新余额覆盖掉（少 10 分）。
      if (r && typeof r.balance === "number") balance.value = r.balance;
    } catch {
      daily.value = { ...daily.value, tasks: { ...daily.value.tasks, [key]: false } };
      ui.toast("这一步没能保存到服务器，检查一下网络");
    }

    const c = completedCount.value;
    if (c >= TASK_DEFS.length) {
      ui.showBanner("你太棒了！🎉", `今日 ${TASK_DEFS.length} 项任务全部完成`);
      return true;
    }
    if (!opts.silent) {
      const def = TASK_DEFS.find((d) => d.key === key);
      ui.toast(`「${def?.name ?? "任务"}」已完成！还差 ${TASK_DEFS.length - c} 项`);
      ui.celebrate();
    }
    return false;
  }

  /**
   * 用服务端返回的打卡状态覆盖本地那份（可选带上余额）。
   *
   * 语言强化的打勾判定在后端做，所以做题页拿到 daily 后要用这个把本地刷新一下 ——
   * 否则首页会拿着上一份旧状态，出现「页面里写着 9/9 完成、首页还显示待完成」。
   */
  function applyDaily(d: DailyState | null | undefined, newBalance?: number): void {
    if (d) {
      daily.value = d;
      loaded.value = true;
    }
    if (typeof newBalance === "number") balance.value = Math.max(0, newBalance);
  }

  /**
   * 同步语言强化的当日进度（做题页每次载入 / 每次作答后调用）。
   *
   * 完成与取消完成都要处理：
   *   · 9 道全做完 → 打勾（后端发 20 分）
   *   · 有一道被打回「再练一练」→ 标记退回「待完成」，首页重新变成待办
   *     （已发出去的 20 分不追回 —— 孩子确实做过了，扣分只会让他莫名其妙）
   *
   * 打勾走 `silent`：庆祝与提示由做题页自己给（它更清楚该说「+20 分」），
   * 唯一例外是这一项刚好凑满全部任务 —— 那时 store 会弹「全部完成」的横幅。
   * 用本地 `isDone` 先判一道，是为了避免每次作答都白跑一次 PATCH。
   */
  async function syncLanguage(done: number, total: number): Promise<void> {
    languageDone.value = Math.max(0, done);
    languageTotal.value = Math.max(0, total) || LANGUAGE_TOTAL;

    const all = total > 0 && done >= total;
    if (all) {
      if (!isDone("language")) await completeTask("language", { silent: true });
      return;
    }
    if (!isDone("language")) return;
    daily.value = { ...daily.value, tasks: { ...daily.value.tasks, language: false } };
    try {
      const r = await api.patchDaily({ date: date.value, tasks: { language: false } });
      if (r && typeof r.balance === "number") balance.value = r.balance;
    } catch {
      /* 退回「待完成」失败不打扰孩子，下次作答/刷新会再对一遍 */
    }
  }

  /**
   * 同步英文故事的打卡标记（播放页每次载入 / 每次上报播放进度后调用）。
   *
   * 与语言强化同样由**后端**判定（真相是 `videoWatch:<date>` 里的观看时长），
   * 这里只把结果在本地立刻反映出来 —— 首页不用刷新就变「已完成」。
   *
   * 只处理「完成」这一个方向：一集看完当天就不再回退（孩子接着点「换一个」继续看，
   * 不该把已经到手的打卡和 10 分抹掉）。
   */
  async function syncVideo(done: boolean): Promise<void> {
    if (!done) return;
    if (!isDone("video")) await completeTask("video", { silent: true });
  }

  /* ---------------------------------------------------------------- 积分 */

  /**
   * 发「全对」奖励（口算全对 / 听写全对）。后端按 reason+日期 幂等，重复调用不会重复加分。
   * 完成类积分（口算/听写/阅读完成、全部完成）由后端在 setTaskDone 链路里自动发，前端无需关心。
   */
  async function awardPoints(reason: "math_perfect" | "dictation_perfect"): Promise<void> {
    try {
      const r = await api.awardPoints(reason);
      balance.value = r.balance;
    } catch {
      // 加分失败不打扰孩子，下次触发会再试（后端幂等，不会重复入账）
    }
  }

  /** 兑换奖励：成功后更新余额并把记录插到列表头部 */
  async function redeemPoints(reward: string): Promise<Redemption> {
    const r = await api.redeem(reward);
    balance.value = r.balance;
    redemptions.value = [r.redemption, ...redemptions.value];
    return r.redemption;
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

    // 已经判定过（对/错）的题锁定，不允许再改（输入框此时已 disabled，这里再挡一道防程序化调用）
    if (prev === "ok" || prev === "bad") return;

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
    // 口算全对 → 额外 +10（后端幂等，重复调用不会重复加分）
    await awardPoints("math_perfect");
    const ui = useUiStore();
    ui.celebratePerfect(filled ? "20 道全对，今天的任务也全部完成啦" : "20 道口算一道都没错，太厉害啦");
  }

  /** 兼容旧存档：已作答满 20 题但任务没打勾的，静默补上 */
  async function syncMathTaskFlag(): Promise<void> {
    if (!mathSet.value?.qs?.length) return;
    if (mathAnswered.value >= mathTotal.value && !isDone("math")) {
      daily.value = { ...daily.value, tasks: { ...daily.value.tasks, math: true } };
      try {
        const r = await api.patchDaily({ date: date.value, tasks: { math: true } });
        if (r && typeof r.balance === "number") balance.value = r.balance;
      } catch {
        /* 静默补打卡失败不打扰孩子 */
      }
    }
  }

  return {
    date,
    daily,
    loaded,
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
    currentIndex,
    indexOfTask,
    isUnlocked,
    currentTaskName,
    completeTask,
    applyDaily,
    syncLanguage,
    syncVideo,
    languageDone,
    languageTotal,
    balance,
    redemptions,
    awardPoints,
    redeemPoints,
    bumpReview,
    reviewOpen,
    reviewCount,
    reviewTarget,
    reviewTotal,
    reviewRemaining,
    reviewDone,
    canReview,
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
