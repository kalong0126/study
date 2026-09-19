<script setup lang="ts">
/**
 * 智能拼音童话
 *
 * 这一页是「打开就能读」的：进来先问后端今天有没有童话，有就接着读、没有就写一篇，
 * 然后把阅读倒计时跑起来 —— 孩子不需要先看懂「生成」按钮是干什么的。
 *
 * 「今天」由后端认定（`/story/today`），不带 force 的生成请求在当天已有童话时
 * 原样返回那一篇，所以刷新、切页回来、换台设备打开，都不会重复花钱。
 * 「换一篇童话」是显式的换一篇（force），才真的重新生成。
 *
 * 「读过不重复」由后端保证：生成前把已读主题列表发过去，让模型避开。
 * 朗读走按句串行 + 高亮（见 StoryReader）。
 */
import { computed, onMounted, ref, watch } from "vue";
import { describeApiError } from "@/api";
import Icon from "@/components/Icon.vue";
import StoryReader from "@/components/StoryReader.vue";
import { stopAudio, useAudioState } from "@/composables/useAudio";
import { useProgressStore } from "@/stores/progress";
import { TIMER_SECONDS, useStoryStore } from "@/stores/story";
import { useUiStore } from "@/stores/ui";

const story = useStoryStore();
const progress = useProgressStore();
const ui = useUiStore();
const { playing: isPlaying } = useAudioState();

const reader = ref<InstanceType<typeof StoryReader> | null>(null);

const hasStory = computed(() => !!story.current?.text);
const readCount = computed(() => story.readTitles.length);
const timerMinutes = TIMER_SECONDS / 60;
/** 今天阅读已经完成了就别再自动开一轮倒计时 —— 那是白等 15 分钟 */
const readingDone = computed(() => progress.isDone("reading"));

onMounted(async () => {
  try {
    await story.ensureToday();
  } catch (e) {
    ui.toast(describeApiError(e));
  }
  // 有故事可读、今天还没读完 → 倒计时自己跑起来（读满 15 分钟即完成「阅读」任务）
  if (hasStory.value && !readingDone.value && !story.timer.running) story.startTimer();
});

/** 「换一篇」是显式要求新内容，走 force —— 不然当天会被幂等挡回来，点了没反应 */
async function regenerate(): Promise<void> {
  try {
    await story.generate(true);
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

function toggleRead(): void {
  if (!story.current?.text) {
    ui.toast("还没有故事哦");
    return;
  }
  if (isPlaying.value) {
    reader.value?.stop();
    ui.toast("已停止朗读");
  } else {
    reader.value?.start();
    ui.toast("开始朗读啦，会一句一句读哦");
  }
}

watch(
  () => story.current?.id,
  () => stopAudio(),
);

function openHistory(id: number): void {
  const s = story.stories.find((x) => x.id === id);
  if (s) story.load(s);
}

async function remove(title: string): Promise<void> {
  if (!window.confirm(`确定要移除《${title}》吗？\n移除后这个主题可以再次生成。`)) return;
  try {
    await story.remove(title);
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}
</script>

<template>
  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #F3EFFF; color: var(--purple-d)">
        <Icon name="story" :size="19" />
      </span>
      <div><h2>智能拼音童话</h2><span class="sub">大模型生成 · 自动注音 · 读过不重复</span></div>
    </div>

    <!-- 倒计时和生成按钮在同一行：这一页进来就在读，操作只有「换一篇」「朗读」「结束计时」 -->
    <div class="story-bar">
      <span class="timer-chip" :class="{ run: story.timer.running }">
        <Icon name="clock" :size="20" />
        <b class="timer-clock" :class="{ run: story.timer.running }">{{ story.timerClock }}</b>
      </span>

      <button class="btn purple" type="button" :disabled="story.generating" @click="regenerate()">
        <Icon name="sparkle" :size="18" />{{ story.generating ? "正在写故事…" : "换一篇童话" }}
      </button>

      <button class="btn" :class="isPlaying ? 'yellow' : 'ghost'" type="button" @click="toggleRead()">
        <Icon :name="isPlaying ? 'stop' : 'speakerLoud'" :size="18" />{{ isPlaying ? "停止朗读" : "朗读故事" }}
      </button>

      <button v-if="story.timer.running" class="btn ghost" type="button" @click="story.finishTimerEarly()">
        <Icon name="stop" :size="18" />结束计时
      </button>
      <button v-else-if="!readingDone" class="btn green" type="button" @click="story.startTimer()">
        <Icon name="clock" :size="18" />开启 {{ timerMinutes }} 分钟计时
      </button>
    </div>

    <p class="story-bar-tip">
      {{
        story.timer.running
          ? `阅读计时中，认真读满 ${timerMinutes} 分钟就完成今天的「阅读」任务，读完记得让眼睛休息一下～`
          : readingDone
            ? "今天的阅读任务已经完成啦，想再读一篇随时欢迎。"
            : `认真读满 ${timerMinutes} 分钟就能完成今日「阅读」任务`
      }}
    </p>

    <div v-if="story.lastError" class="tip" style="border-left-color: #E95252">
      上次生成失败：{{ story.lastError }}<br />
      家长可以到「运行诊断」里点「测试故事模型」确认链路。
    </div>

    <div class="story-box" style="margin-top: 16px">
      <StoryReader v-if="hasStory" ref="reader" :title="story.current?.title ?? ''" :text="story.current?.text ?? ''" />
      <div v-else class="story-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="#B9CCDE" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5.5A2 2 0 0 1 6 3.5h5.5v17H6a2 2 0 0 0-2 2z" />
          <path d="M20 5.5a2 2 0 0 0-2-2h-5.5v17H18a2 2 0 0 1 2 2z" />
        </svg>
        <div>{{ story.generating ? "正在写今天的故事，稍等一下下…" : "今天的故事还没写出来" }}</div>
        <div>第一次使用请先让家长在服务器的 config.yaml 里配好大模型</div>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #E9FBF3; color: var(--green-d)">
        <Icon name="calendar" :size="19" />
      </span>
      <div>
        <h2>读过的故事</h2>
        <span class="sub">已读过 {{ readCount }} 个主题，生成新故事时会自动避开</span>
      </div>
    </div>

    <div class="hist">
      <div v-if="!story.stories.length" class="wb-empty">还没有读过故事，快去生成一篇吧！</div>
      <div
        v-for="s in story.stories"
        :key="s.id"
        class="hist-item"
        :class="{ cur: story.current?.id === s.id }"
        style="cursor: pointer"
        @click="openHistory(s.id)"
      >
        <span class="h-t">{{ s.title }}</span>
        <span class="h-d">{{ String(s.createdAt).slice(0, 10) }}</span>
        <button class="h-x" type="button" title="删除这条记录，之后可以再生成这个主题" @click.stop="remove(s.title)">
          <Icon name="cross" :size="15" :stroke="2.2" />
        </button>
      </div>
    </div>
  </section>
</template>
