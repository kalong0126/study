<script setup lang="ts">
/**
 * 每日口算
 *
 * 完成标准：20 题**全部作答**即算完成，答错也没关系（答错自动进错题本）；
 * 20 题全对再额外给一次满分庆祝。
 *
 * 计时：进页面自动开始，离开页面 / 切到后台自动暂停（离开的时间不算用时），
 * 做完自动停表，用时显示在这里和首页的「每日口算」任务卡上。
 */
import { computed, onMounted, onUnmounted } from "vue";
import Icon from "@/components/Icon.vue";
import PageTool from "@/components/PageTool.vue";
import { useProgressStore } from "@/stores/progress";

const progress = useProgressStore();

/**
 * 计时状态那一小段文字（跟在 mm:ss 后面）。
 * 做完 → 「用时 3 分 12 秒」（这是给孩子的奖励，必须留在明面上）；
 * 计时中 → 「计时中」；否则 → 「已暂停」。
 */
const timerSay = computed(() => {
  if (progress.mathDone) return `用时 ${progress.mathElapsedText}`;
  return progress.mathTimerRunning ? "计时中" : "已暂停";
});

/** 备注：原来卡片下面那一整块「小提示」三行字，现在收进工具栏最右侧的 ⓘ */
const mathNote = [
  "输入答案后会自动批改：答对变绿并「叮咚」一声，答错变红，这道题会自动进「错题小本本」。",
  "20 道题全部作答就算完成今天的口算任务，答错也没关系；一道都没错会有满分大惊喜。",
  "计时是自动的：进这一页就开始、做完自动停；离开这一页（或切到后台）会自动暂停，离开的时间不算用时。",
].join("\n");

function onInput(idx: number, e: Event): void {
  const el = e.target as HTMLInputElement;
  void progress.inputMath(idx, el.value);
}

function onEnter(e: KeyboardEvent): void {
  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
}

function resultOf(idx: number): string {
  return progress.resultOf(idx);
}

/** 切到后台（比如家长来电话、切去别的 App）就暂停，别把离开的时间也算进用时 */
function onVisibility(): void {
  if (document.visibilityState === "visible") progress.startMathTimer();
  else progress.pauseMathTimer();
}

onMounted(() => {
  void progress.ensureMathSet();
  progress.startMathTimer();
  document.addEventListener("visibilitychange", onVisibility);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisibility);
  progress.pauseMathTimer();
});
</script>

<template>
  <!-- 详情页统一工具栏：标题 / 题量 / 计时状态 / 作答进度 / 主操作 全在一条 53px 的行上，
       备注（原来下面那三行小提示）收进最右侧的 ⓘ。 -->
  <PageTool
    icon="math"
    tint="#EAF3FB"
    color="var(--blue-d)"
    title="每日口算"
    meta="20 题 · 100 以内加减法"
    :note="mathNote"
  >
    <!-- 计时胶囊与作答进度都是「中段控件」，放 #mid；右段只留一个主操作按钮。
         原先它们写在默认插槽（右段）里，`.pt-act` 被撑到 500px+ 且 `flex:none` 不肯缩，
         360px 手机上整条工具栏横向溢出 252px（smoke 用例抓到的）。 -->
    <template #mid>
      <span class="timer-chip" :class="{ run: progress.mathTimerRunning }">
        <Icon name="clock" :size="17" />
        <b class="timer-clock" :class="{ run: progress.mathTimerRunning }">{{ progress.mathClock }}</b>
        <span class="tb-say">{{ timerSay }}</span>
      </span>

      <div class="progress-line">
        <span class="notranslate">
          已作答 {{ progress.mathAnswered }} / {{ progress.mathTotal }}
          <template v-if="progress.mathAnswered >= progress.mathTotal">
            · {{ progress.mathPerfect ? "全部答对" : `答对 ${progress.mathCorrect} 题` }}
          </template>
        </span>
        <div class="bar">
          <div class="fill" :class="{ gold: progress.mathPerfect }" :style="{ width: `${progress.mathPct}%` }"></div>
        </div>
      </div>
    </template>

    <button class="btn yellow sm" type="button" :disabled="progress.mathBusy" @click="progress.newMathSet()">
      <Icon name="refresh" :size="16" :stroke="2.2" />换一批题目
    </button>
  </PageTool>

  <section class="card">
    <div class="m-list">
      <div
        v-for="(q, i) in progress.mathSet?.qs ?? []"
        :key="i"
        class="m-row"
        :class="resultOf(i)"
      >
        <span class="m-no">{{ i + 1 }}</span>
        <span class="m-q">{{ q.text }}</span>
        <input
          class="m-in"
          :class="resultOf(i)"
          type="number"
          inputmode="numeric"
          autocomplete="off"
          :value="progress.answers[i] ?? ''"
          :disabled="resultOf(i) !== ''"
          :aria-label="`第 ${i + 1} 题 ${q.text}`"
          @input="onInput(i, $event)"
          @keydown="onEnter"
        />
        <span class="m-mark">
          <svg v-if="resultOf(i) === 'ok'" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" fill="#7FDCB8" />
            <path d="M7.4 12.4 10.6 15.6 16.6 8.9" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else-if="resultOf(i) === 'bad'" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" fill="#FF8C8C" />
            <path d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8" stroke="#fff" stroke-width="2.4" stroke-linecap="round" />
          </svg>
        </span>
      </div>
    </div>
  </section>
</template>
