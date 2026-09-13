<script setup lang="ts">
/**
 * 屏上听写 · 整轮写完一起提交
 *
 * 相比旧版的「逐字写完立刻提交」，这里按改造计划 §10 改成了：
 *   ① 一轮最多 6 个字，逐字写，**不提交**
 *   ② 全部写完 → [一起交给 AI 批改] 或 [交给大人审核]
 *   ③ AI 批改：把 N 个字拼成一张带红色序号的网格图，**一次**多模态请求判完
 *      （逐字判要 N 次，成本差 N 倍，延迟也从 N×5s 降到 1×8s）
 *   ④ 后端会严格校验返回的项数与序号，不符就自动降级为逐字判卷 —— 前端无需关心
 *   ⑤ 逐字展示结果，家长可以逐字改判
 *   ⑥ 结果写入掌握度与错字本（AI 路径由后端落库，大人审核路径由前端落库）
 *
 * 「交给大人审核」故意**不走**大模型：既不花 token，也不等待，
 * 家长看着孩子写的字直接点 ✓/✗ 就行。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { api, describeApiError } from "@/api";
import type { MarkItem, MarkTaskView } from "@/api/types";
import HandBoard from "@/components/HandBoard.vue";
import Icon from "@/components/Icon.vue";
import { dictationItems, playSequence, stopAudio } from "@/composables/useAudio";
import { sheetDataUrl, singleDataUrl, thumbDataUrl, type Cell, type Stroke } from "@/composables/useHandCanvas";
import { playBuzz, playDing } from "@/composables/useSound";
import { useContentStore } from "@/stores/content";
import { useMasteryStore } from "@/stores/mastery";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";

const content = useContentStore();
const mastery = useMasteryStore();
const progress = useProgressStore();
const ui = useUiStore();

type Phase = "idle" | "writing" | "reviewing" | "marking" | "result";

const board = ref<InstanceType<typeof HandBoard> | null>(null);

const phase = ref<Phase>("idle");
/** 每轮固定最多 6 个字（判卷拼图 4×2 最清晰，孩子一轮 6 个也坐得住） */
const ROUND_SIZE = 6;
const roundNo = ref(0);
const index = ref(0);
/** 本轮字表 */
const targets = ref<{ ch: string; word: string; pinyin: string }[]>([]);
/** 每字的笔迹，与 targets 同长 */
const ink = ref<Stroke[][]>([]);
/** 哪些字已经写了 */
const written = ref<boolean[]>([]);

const elapsed = ref(0);
const taskResult = ref<MarkTaskView | null>(null);
const mode = ref<"ai" | "parent">("ai");
const manual = ref<Record<number, boolean | null>>({});
const errorMsg = ref("");
const summary = ref("");

let elapsedTimer: number | null = null;
let pollTimer: number | null = null;
let completedThisRound = false;

const lesson = computed(() => content.current);
const lessonChars = computed(() => content.chars);

const current = computed(() => targets.value[index.value] ?? null);
const isLast = computed(() => index.value >= targets.value.length - 1);
const writtenCount = computed(() => written.value.filter(Boolean).length);
const allWritten = computed(() => targets.value.length > 0 && writtenCount.value === targets.value.length);
const canStart = computed(() => lessonChars.value.length > 0);

/* ------------------------------------------------------------------ 生命周期 */

function stopTimers(): void {
  if (elapsedTimer !== null) {
    window.clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

onBeforeUnmount(() => {
  stopTimers();
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
  const size = Math.max(1, Math.min(ROUND_SIZE, pool.length));
  const win = pool.slice(0, size);
  roundNo.value += 1;

  targets.value = win;
  ink.value = win.map(() => []);
  written.value = win.map(() => false);
  index.value = 0;
  taskResult.value = null;
  manual.value = {};
  errorMsg.value = "";
  summary.value = "";
  completedThisRound = false;
  phase.value = "writing";

  void nextTick(() => {
    board.value?.clear();
    board.value?.resize();
  });
  speakCurrent();
  ui.toast(`第 ${roundNo.value} 轮开始，听到读音就在格子里写下来吧`);
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

/** 「下一个 / 上一个 / 去写」统一走这里 */
function goTo(i: number): void {
  saveCurrent();
  if (i < 0) {
    loadIndex(0);
    return;
  }
  if (i >= targets.value.length) {
    phase.value = "reviewing";
    stopAudio();
    return;
  }
  loadIndex(i);
  speakCurrent();
}

function clearBoard(): void {
  board.value?.clear();
  ui.toast("擦干净了，重新写一次吧");
}

/* ---------------------------------------------------------- 提交给 AI 批改 */

function cells(): Cell[] {
  return targets.value.map((_, i) => ({ index: i + 1, strokes: ink.value[i] ?? [] }));
}

function buildSheet(): string {
  return sheetDataUrl(cells(), {
    cell: 300,
    cols: targets.value.length <= 4 ? targets.value.length : 4,
    showIndex: true,
    showGrid: true,
  });
}

function buildSingles(): string[] {
  return targets.value.map((_, i) => singleDataUrl(ink.value[i] ?? [], 512));
}

async function submitAi(): Promise<void> {
  if (!lesson.value || !targets.value.length) return;

  const image = buildSheet();
  if (!image) {
    ui.toast("合成图片失败，请刷新页面后重试");
    return;
  }
  const singles = buildSingles();

  errorMsg.value = "";
  mode.value = "ai";
  ui.toast("已提交，AI 正在批改这一轮的字…");

  try {
    const r = await api.createMarkTask({
      lessonId: lesson.value.id,
      mode: "composite",
      targets: targets.value.map((t) => t.ch),
      image,
      images: singles,
    });
    phase.value = "marking";
    startElapsed();
    poll(r.taskId);
  } catch (e) {
    phase.value = "reviewing";
    errorMsg.value = describeApiError(e);
    ui.toast("提交失败，可以改用「交给大人审核」");
  }
}

function startElapsed(): void {
  stopTimers();
  elapsed.value = 0;
  elapsedTimer = window.setInterval(() => {
    elapsed.value += 1;
  }, 1000);
}

function poll(taskId: number): void {
  pollTimer = window.setInterval(async () => {
    try {
      const task = await api.getMarkTask(taskId);
      if (task.status === "done" || task.status === "failed") {
        stopTimers();
        await onMarkSettled(task);
      }
    } catch (e) {
      stopTimers();
      phase.value = "reviewing";
      errorMsg.value = describeApiError(e);
    }
  }, 1500);
}

async function onMarkSettled(task: MarkTaskView): Promise<void> {
  if (task.status === "failed") {
    phase.value = "reviewing";
    errorMsg.value = task.error || "AI 批改失败了，可以重试或改用「交给大人审核」";
    ui.toast("这次没批改成功");
    return;
  }
  taskResult.value = task;
  phase.value = "result";
  // 后端已经把掌握度与错字本写好了，这里只要把最新状态拉回来
  await refreshMastery();
  const ok = task.items.filter((i) => i.correct).length;
  if (ok === task.items.length && ok > 0) {
    playDing();
    // 听写这一轮全对 → 额外 +10（后端幂等）
    await progress.awardPoints("dictation_perfect");
    ui.celebrate({ title: "这一轮全写对啦！🎉", sub: `${task.items.length} 个字一个都没错` });
  } else {
    playBuzz();
  }
  await finishRound(task.items.length);
}

async function refreshMastery(): Promise<void> {
  try {
    const snap = await api.listState(undefined, 1);
    mastery.snapshot(snap.mastery, snap.wrong);
  } catch {
    /* 拉不到就算了，下次启动会同步 */
  }
}

/* ---------------------------------------------------------- 交给大人审核 */

function startParentReview(): void {
  mode.value = "parent";
  const init: Record<number, boolean | null> = {};
  targets.value.forEach((_, i) => {
    init[i] = null;
  });
  manual.value = init;
  taskResult.value = null;
  errorMsg.value = "";
  phase.value = "result";
  ui.toast("请大人看着孩子写的字，逐个点「写对 / 写错」");
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
  if (mode.value === "ai") {
    const it = taskResult.value?.items.find((x) => x.index === i + 1);
    return !!it && it.correct === false;
  }
  return manual.value[i] === false;
}

function countCorrect(): number {
  if (mode.value === "ai") return taskResult.value?.items.filter((x) => x.correct).length ?? 0;
  return Object.values(manual.value).filter((v) => v === true).length;
}

/** 家长改判（AI 结果） */
async function reviewOne(index1: number, correct: boolean): Promise<void> {
  const task = taskResult.value;
  if (!task) return;
  try {
    const next = await api.reviewMarkTask(task.taskId, [{ index: index1, correct }]);
    taskResult.value = next;
    await refreshMastery();
    if (correct) playDing();
    else playBuzz();
    ui.toast("已记录大人的判定");
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

function end(): void {
  stopTimers();
  stopAudio();
  targets.value = [];
  ink.value = [];
  written.value = [];
  taskResult.value = null;
  manual.value = {};
  errorMsg.value = "";
  phase.value = "idle";
  summary.value = "";
}

/* ------------------------------------------------------------------ 展示辅助 */

function thumbOf(i: number): string {
  return thumbDataUrl(ink.value[i] ?? [], 180);
}

function itemOf(i: number): MarkItem | undefined {
  return taskResult.value?.items.find((x) => x.index === i + 1);
}

/** 结果格子的状态样式（避免在模板里写嵌套三元） */
function cellClass(i: number): string {
  if (mode.value === "ai") {
    const it = itemOf(i);
    if (!it) return "none";
    return it.correct ? "ok" : "no";
  }
  const m = manual.value[i];
  if (m === true) return "ok";
  if (m === false) return "no";
  return "none";
}

/** 第一个还没写的字；都写了就回最后一个 */
function firstUnwritten(): number {
  const i = written.value.findIndex((w) => !w);
  return i >= 0 ? i : Math.max(0, targets.value.length - 1);
}

function pinyinOfCurrent(): string {
  return current.value?.pinyin || "请点「再听一遍」";
}

function statusText(it: MarkItem | undefined): string {
  if (it?.reviewedBy === "parent") return "（大人判定）";
  return "";
}

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
        <span class="t">屏上听写 · 整轮一起批改</span>
        <span class="s">在田字格里逐字写，写完整轮再一起交给 AI 或大人</span>
      </div>
    </div>

    <!-- ---------------------------------------------------------- 待开始 -->
    <div v-if="phase === 'idle'" class="hw-idle">
      <p>
        选好课文后点下面的按钮，听到读音就在格子里写下来 —— 一个字写一格，写错了点「清空重写」。
        <b>一轮的字全部写完</b>，再一次性交给 AI 批改（也可以交给大人审核）。写错的字会自动进错字本。
      </p>
      <p class="tip" style="text-align: center; margin-bottom: 12px">
        课文共 {{ lessonChars.length }} 个生字，每轮最多写 6 个。
      </p>
      <button class="btn purple wide" type="button" :disabled="!canStart" @click="start()">
        <Icon name="pen" :size="18" />开始屏上听写
      </button>
      <p v-if="!canStart" class="tip" style="text-align: left">这篇课文还没有生字表，请家长先到内容后台录入生字。</p>
      <p v-if="roundNo > 0" class="tip" style="text-align: left">已完成 {{ roundNo }} 轮，再开始会练还没掌握的字。</p>
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
        <button class="btn primary" type="button" @click="goTo(index + 1)">
          <Icon name="arrowRight" :size="18" />{{ isLast ? "写完了，去提交" : "写好了，下一个" }}
        </button>
      </div>

      <div class="hw-tools">
        <button class="btn ghost sm" type="button" @click="end()"><Icon name="stop" :size="16" />结束本轮听写</button>
      </div>
    </div>

    <!-- -------------------------------------------------------- 待提交 -->
    <div v-if="phase === 'reviewing'" class="hw-stage on">
      <p style="font-size: 13.5px; font-weight: 700; color: var(--ink2); margin: 4px 0 0">
        {{ allWritten ? "全部写完啦！确认一下，然后一起交上去：" : "还有没写的字，也可以直接交（空格会被判为没写对）：" }}
      </p>

      <div class="hw-cells">
        <div v-for="(t, i) in targets" :key="`${t.ch}-${i}`" class="hw-cell" :class="written[i] ? 'ok' : 'none'">
          <div class="hc-i">第 {{ i + 1 }} 个</div>
          <img v-if="written[i]" class="hw-thumb" :src="thumbOf(i)" :alt="`第 ${i + 1} 个字的手写`" @error="onImageError" />
          <div v-else class="hc-w">（空着）</div>
          <button class="btn ghost sm" type="button" style="width: 100%; margin-top: 6px" @click="goTo(i)">
            <Icon name="pen" :size="14" />去写
          </button>
        </div>
      </div>

      <div v-if="errorMsg" class="hw-res on no" style="display: block">
        {{ errorMsg }}
        <span class="cm">可以再点一次「一起交给 AI 批改」重试，或者改用「交给大人审核」。</span>
      </div>

      <div class="hw-tools">
        <button class="btn primary" type="button" @click="submitAi()"><Icon name="check" :size="18" />一起交给 AI 批改</button>
        <button class="btn green" type="button" @click="startParentReview()"><Icon name="eye" :size="18" />交给大人审核</button>
      </div>
      <div class="hw-tools">
        <button class="btn ghost sm" type="button" @click="goTo(firstUnwritten())">
          <Icon name="arrowLeft" :size="16" />回去补写
        </button>
        <button class="btn ghost sm" type="button" @click="end()"><Icon name="stop" :size="16" />结束本轮听写</button>
      </div>
    </div>

    <!-- -------------------------------------------------------- 批改中 -->
    <div v-if="phase === 'marking'" class="hw-stage on">
      <div class="hw-res on info" style="display: block">
        AI 正在批改这 {{ targets.length }} 个字…已等待 {{ elapsed }} 秒
        <span class="cm">一轮一次请求，通常 5-15 秒。可以先去喝口水。</span>
      </div>
      <div class="hw-cells">
        <div v-for="(t, i) in targets" :key="`${t.ch}-${i}`" class="hw-cell">
          <div class="hc-i">第 {{ i + 1 }} 个</div>
          <img v-if="written[i]" class="hw-thumb" :src="thumbOf(i)" :alt="`第 ${i + 1} 个字的手写`" @error="onImageError" />
        </div>
      </div>
      <div class="hw-tools">
        <button class="btn ghost sm" type="button" @click="end()"><Icon name="stop" :size="16" />先不等了</button>
      </div>
    </div>

    <!-- ---------------------------------------------------- 结果 / 审核 -->
    <div v-if="phase === 'result'" class="hw-stage on">
      <div class="hw-cells">
        <div v-for="(t, i) in targets" :key="`${t.ch}-${i}`" class="hw-cell" :class="cellClass(i)">
          <div class="hc-i">第 {{ i + 1 }} 个</div>
          <div class="hc-t">{{ t.ch }}</div>
          <div class="hc-w">
            <template v-if="mode === 'ai'">AI 认读：{{ itemOf(i)?.written || "?" }} {{ statusText(itemOf(i)) }}</template>
            <template v-else>大人判定</template>
          </div>
          <img v-if="written[i]" class="hw-thumb" :src="thumbOf(i)" :alt="`第 ${i + 1} 个字的手写`" @error="onImageError" />
          <div v-if="mode === 'ai'" class="hc-c">{{ itemOf(i)?.comment || "" }}</div>

          <div v-if="mode === 'ai'" class="hc-rev">
            <button type="button" :class="{ on: itemOf(i)?.correct === true }" @click="reviewOne(i + 1, true)">写对</button>
            <button type="button" :class="{ on: itemOf(i)?.correct === false }" @click="reviewOne(i + 1, false)">写错</button>
          </div>
          <div v-else class="hc-rev">
            <button type="button" :class="{ on: manual[i] === true }" @click="manual[i] = true">写对</button>
            <button type="button" :class="{ on: manual[i] === false }" @click="manual[i] = false">写错</button>
          </div>
        </div>
      </div>

      <div class="hw-sum on" style="display: block">{{ summary || "看完每个字，确认后保存。" }}</div>
      <div v-if="taskResult?.degraded" class="hw-res on info" style="display: block">
        本轮批量结果不完整，后端已自动降级为逐字批改 —— 结果同样可信。
      </div>

      <div class="hw-tools">
        <button v-if="mode === 'parent'" class="btn primary" type="button" @click="saveParentReview()">
          <Icon name="save" :size="18" />保存审核结果
        </button>
        <button v-else class="btn ghost" type="button" @click="refreshMastery()">
          <Icon name="refresh" :size="18" />刷新掌握状态
        </button>
        <button class="btn green" type="button" @click="start()">
          <Icon name="arrowRight" :size="18" />{{ nextRoundHint }}
        </button>
      </div>
      <div class="hw-tools">
        <button class="btn ghost sm" type="button" @click="end()"><Icon name="check" :size="16" />结束本轮听写</button>
      </div>
    </div>
  </div>
</template>
