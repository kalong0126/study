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
import { onMounted, onUnmounted } from "vue";
import Icon from "@/components/Icon.vue";
import { useProgressStore } from "@/stores/progress";

const progress = useProgressStore();

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
  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #EAF3FB; color: var(--blue-d)">
        <Icon name="math" :size="19" />
      </span>
      <div>
        <h2>每日口算</h2>
        <span class="sub">20 道 · 100 以内加减法 &amp; 表内乘法</span>
      </div>
      <div class="spacer"></div>
      <button class="btn yellow sm" type="button" :disabled="progress.mathBusy" @click="progress.newMathSet()">
        <Icon name="refresh" :size="16" :stroke="2.2" />换一批题目
      </button>
    </div>

    <div class="timer-box" style="margin-top: 0; margin-bottom: 14px">
      <div class="timer-clock" :class="{ run: progress.mathTimerRunning }">{{ progress.mathClock }}</div>
      <span style="font-size: 12.5px; color: var(--ink3)">
        <template v-if="progress.mathDone">
          <template v-if="progress.mathElapsedSec > 0">
            这一轮做完啦，用时 <b style="color: var(--green-d)">{{ progress.mathElapsedText }}</b>。
          </template>
          <template v-else>这一轮已经做完啦。点「换一批题目」再来一轮，计时会自动开始～</template>
        </template>
        <template v-else-if="progress.mathTimerRunning">正在计时，专心做就好，离开这一页会自动暂停～</template>
        <template v-else>计时暂停中。翻回这一页就会自动开始计时。</template>
      </span>
    </div>

    <div class="progress-line" style="margin-bottom: 14px">
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

    <p class="tip">
      小提示：输入答案后会自动批改。答对变绿并「叮咚」一声，答错变红，这道题会自动进「错题小本本」。<br />
      20 道题<b>全部作答</b>就算完成今天的口算任务，答错也没关系；要是<b>一道都没错</b>，会有满分大惊喜哦。<br />
      计时是<b>自动</b>的：进这一页就开始，做完自动停，用时会在首页的「每日口算」上看到。
    </p>
  </section>
</template>
