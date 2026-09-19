<script setup lang="ts">
/**
 * 屏上听写 · 一轮全部写完，交给大人审核
 *
 * 2026-09-19 改版（用户要求）：**不再接大模型判卷**，只保留「大人审核」这一条路。
 *   ① 一轮 = 这一轮要练的**全部**字：首轮＝整课生字里还没掌握的（若全部已掌握则整课重练），
 *      之后的轮次＝上一轮写错的 + 还没写到的。
 *      —— 原来为了迁就多模态判卷「一次最多判 6 格」而切的 `ROUND_SIZE = 6` 已删，
 *         既然不判卷，就没有理由再把一课生字切成好几轮写。
 *   ② 逐字写（一块田字格一个字），写到最后一个字点「全部写完了，交给大人」
 *      → **直接进审核页**。中间那个「待提交」确认页（`reviewing`）也删了，
 *      用户要的是「全部写完 → 交由大人审核」两步，中间不再多一次点击。
 *   ③ 大人看着孩子写的字逐个点「写对 / 写错」，点完保存
 *      —— 不走大模型：不花 token、不用等，结果直接写进掌握度与错字本。
 *   ④ 审核页上没写的格子标「（空着）」并给「去补写」；补写回来先前判定的结果不丢
 *      （`manual` 只在首次进审核页时初始化，见 `reviewStarted`）。
 *   ⑤ 保存后按「还剩几个字没掌握」提示再来一轮，写错的字下一轮还会出现。
 *
 * 本组件由父页面用 `v-if` 控制显隐（默认隐藏），**挂载即 start()** ——
 * 用户要求「点开始听写就直接打开屏上听写界面」，所以原来那个 idle 落地页
 * （一段说明 + 「开始屏上听写」按钮）已删；阶段只剩 writing → result，
 * 「结束听写」会 emit("close") 让父页面收起。
 *
 * 原来那条 AI 链路（拼网格图 + 一次多模态请求 + 轮询 taskId + 数量序号校验 +
 * 自动降级逐字判 + 家长改判）整套已从本组件删除；后端 `/api/mark/*` 接口保留未动，
 * 前端不再调用。所以这一页现在没有任何「等待模型」的阶段，写完就能判。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { describeApiError } from "@/api";
import HandBoard from "@/components/HandBoard.vue";
import Icon from "@/components/Icon.vue";
import { dictationItems, playSequence, stopAudio } from "@/composables/useAudio";
import { thumbDataUrl, type Stroke } from "@/composables/useHandCanvas";
import { playBuzz, playDing } from "@/composables/useSound";
import { useContentStore } from "@/stores/content";
import { useMasteryStore } from "@/stores/mastery";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";

const content = useContentStore();
const mastery = useMasteryStore();
const progress = useProgressStore();
const ui = useUiStore();

/** 两个阶段：逐字写 → 大人审核（idle 只是「还没开始」的初值，不渲染界面） */
type Phase = "idle" | "writing" | "result";

const board = ref<InstanceType<typeof HandBoard> | null>(null);

const emit = defineEmits<{
  (e: "active", v: boolean): void;
  /** 本轮结束，请父页面把面板收起来（回到默认隐藏） */
  (e: "close"): void;
}>();

const phase = ref<Phase>("idle");
const roundNo = ref(0);
const index = ref(0);
/** 本轮字表（＝这一轮要练的全部字） */
const targets = ref<{ ch: string; word: string; pinyin: string }[]>([]);
/** 每字的笔迹，与 targets 同长 */
const ink = ref<Stroke[][]>([]);
/** 哪些字已经写了 */
const written = ref<boolean[]>([]);
/** 大人的判定：null 未判 / true 写对 / false 写错 */
const manual = ref<Record<number, boolean | null>>({});
const summary = ref("");

let completedThisRound = false;
/** 本轮是否已经进过审核页（决定 manual 要不要重新初始化——补写回来别把判定清掉） */
let reviewStarted = false;

const lesson = computed(() => content.current);
const lessonChars = computed(() => content.chars);

const current = computed(() => targets.value[index.value] ?? null);
const isLast = computed(() => index.value >= targets.value.length - 1);
const writtenCount = computed(() => written.value.filter(Boolean).length);
const canStart = computed(() => lessonChars.value.length > 0);

/* ------------------------------------------------------------------ 生命周期 */

// 父页面是 `v-if="dictating"` 挂载本组件的：一挂载就直接开写，
// 不再有「先看到一段说明、再点一个按钮」的中间页。
onMounted(() => {
  start();
});

onBeforeUnmount(() => {
  stopAudio();
});

/* ------------------------------------------------------------------ 朗读 */

function speakCurrent(): void {
  const c = current.value;
  if (!c) return;
  void playSequence(dictationItems(c.ch, c.word));
}

/* ------------------------------------------------------------------ 开始一轮 */

function start(): void {
  const les = lesson.value;
  if (!canStart.value || !les) {
    ui.toast("这篇课文还没有生字表，请家长先到内容后台录入");
    return;
  }
  const all = lessonChars.value.map((c) => ({ ch: c.ch, word: c.word, pinyin: content.pinyinOf(c.ch, c) }));
  // 「再来一轮」练还没掌握的字：写错的（状态 0）和还没写到的（undefined）都留下，
  // 已写对/已掌握的（状态 1）跳过，不再从头重来。全部掌握后回退到全部，允许自由重练。
  const remaining = all.filter((c) => mastery.charState(les.id, c.ch) !== 1);
  const pool = remaining.length > 0 ? remaining : all;
  roundNo.value += 1;

  // 一整轮＝pool 里全部的字（不再按 6 个切片）
  targets.value = pool;
  ink.value = pool.map(() => []);
  written.value = pool.map(() => false);
  index.value = 0;
  manual.value = {};
  summary.value = "";
  completedThisRound = false;
  reviewStarted = false;
  phase.value = "writing";
  emit("active", true);

  void nextTick(() => {
    board.value?.clear();
    board.value?.resize();
  });
  speakCurrent();
}

/* -------------------------------------------------------------- 逐字书写 */

/**
 * 离开当前字之前，把画布上的笔迹存进 ink[index]。
 * 注意：只有画布真的挂着（phase === 'writing'）才读，否则会读到空数组把已有笔迹抹掉。
 */
function saveCurrent(): void {
  if (phase.value !== "writing") return;
  const b = board.value;
  if (!b) return;
  const strokes = b.getStrokes();
  if (index.value >= ink.value.length) return;
  const next = ink.value.slice();
  next[index.value] = strokes;
  ink.value = next;
  const w = written.value.slice();
  w[index.value] = strokes.length > 0;
  written.value = w;
}

function loadIndex(i: number): void {
  index.value = i;
  void nextTick(() => {
    board.value?.setStrokes(ink.value[i] ?? []);
    board.value?.resize();
  });
}

/** 「下一个 / 上一个 / 去补写」统一走这里 */
function goTo(i: number): void {
  saveCurrent();
  if (i < 0) {
    loadIndex(0);
    return;
  }
  if (i >= targets.value.length) {
    // 整轮走完 → 直接交给大人（没有中间确认页）
    handToParent();
    return;
  }
  loadIndex(i);
  speakCurrent();
}

function clearBoard(): void {
  board.value?.clear();
  ui.toast("擦干净了，重新写一次吧");
}

/* ---------------------------------------------------------- 交给大人审核 */

/**
 * 写完整轮 → 直接进审核页。
 * `manual` 只在本轮**第一次**进审核页时初始化：从审核页点「去补写」再回来时，
 * 先前已经点好的判定不能被清掉。
 */
function handToParent(): void {
  stopAudio();
  if (!reviewStarted) {
    const init: Record<number, boolean | null> = {};
    targets.value.forEach((_, i) => {
      init[i] = null;
    });
    manual.value = init;
    reviewStarted = true;
    ui.toast("请大人看着孩子写的字，逐个点「写对 / 写错」");
  }
  phase.value = "result";
}

/** 审核页发现空字：点回书写阶段补上（写完最后一个字会再次进审核页） */
function goBackWrite(i: number): void {
  phase.value = "writing";
  loadIndex(i);
  speakCurrent();
}

async function saveParentReview(): Promise<void> {
  if (!lesson.value) return;
  const judged: { i: number; correct: boolean }[] = [];
  for (const [k, v] of Object.entries(manual.value)) {
    if (v === true || v === false) judged.push({ i: Number(k), correct: v });
  }
  if (!judged.length) {
    ui.toast("还没有判定任何一个字");
    return;
  }
  ui.toast("正在保存审核结果…");
  try {
    for (const j of judged) {
      const ch = targets.value[j.i]?.ch;
      if (!ch) continue;
      await mastery.setCharState(lesson.value.id, ch, j.correct ? 1 : 0, {
        lessonTitle: lesson.value.title,
      });
    }
    ui.toast(`已保存 ${judged.length} 个字的结果`);
    // 本轮全部字都判定且都写对 → 听写全对 +10（后端幂等）
    const allCorrect = judged.length === targets.value.length && judged.every((j) => j.correct);
    if (allCorrect) await progress.awardPoints("dictation_perfect");
    if (judged.some((j) => j.correct)) playDing();
    else playBuzz();
    await finishRound(judged.length);
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

/* -------------------------------------------------------------- 收尾与结果 */

async function finishRound(judgedCount: number): Promise<void> {
  const total = targets.value.length;
  const ok = countCorrect();
  const bad = targets.value.filter((_, i) => isWrong(i)).map((t) => t.ch);
  summary.value = `本轮听写结束：共 ${total} 个字，判定了 ${judgedCount} 个，写对 ${ok} 个。${
    bad.length ? `要再练的字：${bad.join("　")}` : "全部写对，太厉害啦！"
  }`;

  if (judgedCount >= 3 && !completedThisRound) {
    completedThisRound = true;
    await progress.completeTask("dictation");
  } else if (judgedCount > 0 && judgedCount < 3) {
    ui.toast("至少写完 3 个字才算完成今日「语文听写」任务哦");
  }
}

function isWrong(i: number): boolean {
  return manual.value[i] === false;
}

function countCorrect(): number {
  return Object.values(manual.value).filter((v) => v === true).length;
}

/** 结束本轮：清干净并请父页面把面板收起（回到默认隐藏） */
function end(): void {
  stopAudio();
  targets.value = [];
  ink.value = [];
  written.value = [];
  manual.value = {};
  phase.value = "idle";
  summary.value = "";
  reviewStarted = false;
  emit("active", false);
  emit("close");
}

/** 父页面通过 ref 调这两个方法（开始听写 / 结束听写） */
defineExpose({ start, end });

/* ------------------------------------------------------------------ 展示辅助 */

function thumbOf(i: number): string {
  return thumbDataUrl(ink.value[i] ?? [], 180);
}

/** 结果格子的状态样式（避免在模板里写嵌套三元） */
function cellClass(i: number): string {
  const m = manual.value[i];
  if (m === true) return "ok";
  if (m === false) return "no";
  return "none";
}

function pinyinOfCurrent(): string {
  return current.value?.pinyin || "请点「再听一遍」";
}

/** 审核页顶部那一句：还剩没写的字就提醒可以先补写 */
const leadText = computed(() => {
  const total = targets.value.length;
  if (!total) return "";
  const missing = total - writtenCount.value;
  if (missing > 0) {
    return `还有 ${missing} 个字没写（标着「（空着）」的那几格）：可以点「去补写」，也可以直接判。`;
  }
  return `这一轮 ${total} 个字都写完了！请大人看着孩子写的字，逐个点「写对 / 写错」，然后保存。`;
});

/** 本轮结束后还剩多少个字没掌握（下次「再来一轮」会练这些） */
const remainingAfterRound = computed(() => {
  const les = lesson.value;
  if (!les || !lessonChars.value.length) return 0;
  return lessonChars.value.filter((c) => mastery.charState(les.id, c.ch) !== 1).length;
});

/** 「再来一轮」按钮文案：有剩余就提示数量，全掌握则改为「再练一遍」 */
const nextRoundHint = computed(() => {
  const n = remainingAfterRound.value;
  return n > 0 ? `再来一轮（还有 ${n} 个字没掌握）` : "全部掌握啦，再练一遍";
});

watch(
  () => content.currentId,
  () => {
    // 换课文时结束当前轮次，避免字表错位
    if (phase.value !== "idle") end();
    roundNo.value = 0;
  },
);

function onImageError(e: Event): void {
  // 缩略图是 data URL，正常不会失败；兜底避免浏览器显示破图
  (e.target as HTMLImageElement).style.visibility = "hidden";
}
</script>

<template>
  <div class="hw-box">
    <div class="hw-hd">
      <span class="hw-ico"><Icon name="pen" :size="18" /></span>
      <div>
        <span class="t">屏上听写 · 写完这一轮交给大人</span>
        <span class="s">
          系统不判对错：一个字写一格，这一轮的 {{ targets.length }} 个字全部写完，再交给大人逐个判定
        </span>
      </div>
    </div>

    <!-- ------------------------------------------------------ 逐字书写中 -->
    <div v-if="phase === 'writing'" class="hw-stage on">
      <div class="hw-bar">
        <span class="hw-idx">第 {{ index + 1 }} / {{ targets.length }} 个</span>
        <span class="hw-pin">{{ pinyinOfCurrent() }}</span>
        <div class="spacer"></div>
        <button class="btn ghost sm" type="button" @click="speakCurrent()">
          <Icon name="speaker" :size="16" />再听一遍
        </button>
        <button class="btn ghost sm" type="button" @click="end()">
          <Icon name="stop" :size="16" />结束听写
        </button>
      </div>

      <div class="hw-dots" style="margin-bottom: 10px">
        <span v-for="(w, i) in written" :key="i" class="hw-dot" :class="{ cur: i === index, ok: w }"></span>
      </div>

      <HandBoard ref="board" :active="phase === 'writing'" :label="`手写区域，第 ${index + 1} 个字`" />

      <div class="hw-tools">
        <button class="btn ghost" type="button" @click="clearBoard()"><Icon name="eraser" :size="18" />清空重写</button>
        <button class="btn ghost" type="button" :disabled="index === 0" @click="goTo(index - 1)">
          <Icon name="arrowLeft" :size="18" />上一个
        </button>
        <button class="btn green" type="button" @click="goTo(index + 1)">
          <Icon name="arrowRight" :size="18" />{{ isLast ? "全部写完了，交给大人" : "写好了，下一个" }}
        </button>
      </div>
    </div>

    <!-- -------------------------------------------------- 大人审核 / 结果 -->
    <div v-if="phase === 'result'" class="hw-stage on">
      <p class="hw-lead">{{ leadText }}</p>

      <div class="hw-cells">
        <div v-for="(t, i) in targets" :key="`${t.ch}-${i}`" class="hw-cell" :class="cellClass(i)">
          <div class="hc-i">第 {{ i + 1 }} 个</div>
          <div class="hc-t">{{ t.ch }}</div>
          <template v-if="written[i]">
            <img class="hw-thumb" :src="thumbOf(i)" :alt="`第 ${i + 1} 个字的手写`" @error="onImageError" />
          </template>
          <template v-else>
            <div class="hc-w">（空着）</div>
            <button class="btn ghost sm" type="button" style="width: 100%; margin: 4px 0 2px" @click="goBackWrite(i)">
              <Icon name="pen" :size="14" />去补写
            </button>
          </template>
          <div class="hc-rev">
            <button type="button" :class="{ on: manual[i] === true }" @click="manual[i] = true">写对</button>
            <button type="button" :class="{ on: manual[i] === false }" @click="manual[i] = false">写错</button>
          </div>
        </div>
      </div>

      <div v-if="summary" class="hw-sum on">{{ summary }}</div>

      <div class="hw-tools">
        <button class="btn green" type="button" @click="saveParentReview()">
          <Icon name="save" :size="18" />保存审核结果
        </button>
        <button class="btn ghost" type="button" @click="start()">
          <Icon name="arrowRight" :size="18" />{{ nextRoundHint }}
        </button>
        <button class="btn ghost sm" type="button" @click="end()">
          <Icon name="stop" :size="16" />结束听写
        </button>
      </div>
    </div>
  </div>
</template>
