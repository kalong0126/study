<script setup lang="ts">
/**
 * 智能拼音童话
 *
 * 「读过不重复」由后端保证：生成前把已读主题列表发过去，让模型避开。
 * 朗读走按句串行 + 高亮（见 StoryReader）。
 */
import { computed, ref, watch } from "vue";
import { describeApiError } from "@/api";
import Icon from "@/components/Icon.vue";
import StoryReader from "@/components/StoryReader.vue";
import { stopAudio, useAudioState } from "@/composables/useAudio";
import { TIMER_SECONDS, useStoryStore } from "@/stores/story";
import { useUiStore } from "@/stores/ui";

const story = useStoryStore();
const ui = useUiStore();
const { playing: isPlaying } = useAudioState();

const reader = ref<InstanceType<typeof StoryReader> | null>(null);

const hasStory = computed(() => !!story.current?.text);
const readCount = computed(() => story.readTitles.length);

async function generate(): Promise<void> {
  try {
    await story.generate();
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

function loadSample(): void {
  story.loadSample(Math.floor(Math.random() * 2));
  ui.toast("这是一篇示例故事，先读读看");
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

const timerMinutes = TIMER_SECONDS / 60;
</script>

<template>
  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #F3EFFF; color: var(--purple-d)">
        <Icon name="story" :size="19" />
      </span>
      <div><h2>智能拼音童话</h2><span class="sub">大模型生成 · 自动注音 · 读过不重复</span></div>
    </div>

    <div class="row">
      <button class="btn purple" type="button" :disabled="story.generating" @click="generate()">
        <Icon name="sparkle" :size="18" />{{ story.generating ? "正在写故事…" : "生成新童话" }}
      </button>
      <button class="btn ghost" type="button" @click="loadSample()"><Icon name="story" :size="18" />试读示例故事</button>
      <button class="btn" :class="isPlaying ? 'yellow' : 'ghost'" type="button" @click="toggleRead()">
        <Icon :name="isPlaying ? 'stop' : 'speakerLoud'" :size="18" />{{ isPlaying ? "停止朗读" : "朗读故事" }}
      </button>
    </div>

    <div v-if="story.lastError" class="tip" style="border-left-color: #E95252">
      上次生成失败：{{ story.lastError }}<br />
      家长可以到「运行诊断」里点「测试故事模型」确认链路。
    </div>

    <div class="timer-box">
      <div class="timer-clock" :class="{ run: story.timer.running }">{{ story.timerClock }}</div>
      <button v-if="!story.timer.running" class="btn green" type="button" @click="story.startTimer()">
        <Icon name="clock" :size="18" />开启 {{ timerMinutes }} 分钟阅读计时
      </button>
      <button v-else class="btn ghost" type="button" @click="story.finishTimerEarly()">
        <Icon name="stop" :size="18" />结束计时
      </button>
      <span style="font-size: 12.5px; color: var(--ink3)">
        {{ story.timer.running ? "阅读计时中，读完记得让眼睛休息一下～" : `认真读满 ${timerMinutes} 分钟就能完成今日「阅读」任务` }}
      </span>
    </div>

    <div class="story-box" style="margin-top: 16px">
      <StoryReader v-if="hasStory" ref="reader" :title="story.current?.title ?? ''" :text="story.current?.text ?? ''" />
      <div v-else class="story-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="#B9CCDE" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5.5A2 2 0 0 1 6 3.5h5.5v17H6a2 2 0 0 0-2 2z" />
          <path d="M20 5.5a2 2 0 0 0-2-2h-5.5v17H18a2 2 0 0 1 2 2z" />
        </svg>
        <div>还没有故事哦～点上面的「生成新童话」试试吧！</div>
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
