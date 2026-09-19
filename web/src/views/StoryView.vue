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
import { useRoute } from "vue-router";
import { describeApiError } from "@/api";
import Icon from "@/components/Icon.vue";
import PageTool from "@/components/PageTool.vue";
import StoryReader from "@/components/StoryReader.vue";
import { stopAudio, useAudioState } from "@/composables/useAudio";
import { useProgressStore } from "@/stores/progress";
import { TIMER_SECONDS, useStoryStore } from "@/stores/story";
import { useUiStore } from "@/stores/ui";

const route = useRoute();
const story = useStoryStore();
const progress = useProgressStore();
const ui = useUiStore();
const { playing: isPlaying } = useAudioState();

const reader = ref<InstanceType<typeof StoryReader> | null>(null);

const hasStory = computed(() => !!story.current?.text);
const timerMinutes = TIMER_SECONDS / 60;
/** 今天阅读已经完成了就别再自动开一轮倒计时 —— 那是白等 15 分钟 */
const readingDone = computed(() => progress.isDone("reading"));

/**
 * 工具栏里那个下拉：换回读过的一篇。
 *
 * 「读过的故事」那张列表卡按用户要求删掉了，但**读过的还是得能翻回去**
 * —— 所以改成工具栏里一个只占一行宽度的下拉（参考图就是这么画的）。
 * 选项只收正文非空的，空白条目选进去只会得到一个空壳。
 */
const storyOptions = computed(() => story.stories.filter((s) => (s.text ?? "").trim().length > 0));
const pickedId = computed({
  get: () => story.current?.id ?? 0,
  set: (id: number) => {
    const row = story.stories.find((s) => s.id === id);
    if (row) story.load(row);
  },
});

/** 计时胶囊：既是状态也是开关（正在计时 → 点一下结束这一轮；没计时 → 点一下开始） */
const canToggleTimer = computed(() => story.timer.running || !readingDone.value);
const timerLabel = computed(() => {
  if (story.timer.running) return "";
  return readingDone.value ? "今日已读满" : `点一下开始 ${timerMinutes} 分钟计时`;
});

const storyNote = [
  `进来就自动写一篇今天的童话；当天只写一次，刷新、换设备都不会重复生成。`,
  `读满 ${timerMinutes} 分钟就完成今天的「阅读」任务。计时是自动开的：右边那枚胶囊在走就说明正在计时，点一下可以提前结束（读够 20 秒就算读完）。`,
  "点正文里的任意一句可以从那句开始朗读，正在读的句子会高亮。",
  "读到喜欢的一篇，点一下星星收进「收藏的故事」，以后随时从首页再读一遍。",
  "「读过不重复」由后端按已读标题保证：写新的一篇时会避开以前读过的主题。",
].join("\n");

/* ---------------------------------------------------------------- 故事收藏 */

/** 当前这篇是否已收藏（按标题） */
const fav = computed(() => !!story.current?.title && story.isFav(story.current.title));

/** 收藏 / 取消收藏当前这篇（正文随收藏一起存，历史故事删了也还能重读） */
async function toggleFav(): Promise<void> {
  if (!story.current) return;
  try {
    await story.toggleFav({ id: story.current.id, title: story.current.title, text: story.current.text });
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : "收藏失败，请再试一次");
  }
}

onMounted(async () => {
  void story.loadFavs(); // 星星的高亮状态要靠它（拉取失败也不影响阅读）
  // 从「收藏的故事」点进来重读（?from=fav）→ 不要用「今天的那篇」把孩子正读着的顶掉；
  // 直接刷新落在这条链接上而 store 里还没有故事时，才照常走「今天的一篇」。
  if (route.query.from === "fav" && story.current) {
    // 收藏重读不自动开计时：阅读任务今天多半已经完成，再计时只会让孩子莫名其妙
    return;
  }
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

/** 点计时胶囊：正在计时就结束这一轮，没在计时就开始 */
function toggleTimer(): void {
  if (story.timer.running) story.finishTimerEarly();
  else if (!readingDone.value) story.startTimer();
}

watch(
  () => story.current?.id,
  () => stopAudio(),
);
</script>

<template>
  <!-- 详情页统一工具栏：标题 + 说明胶囊 + 「读哪一篇」下拉 + 计时胶囊 + 换一篇 / 朗读，
       备注收进最右侧的 ⓘ。原来是「卡片头 / 计时区 / 操作行」三块竖排，占掉近半屏。 -->
  <PageTool
    icon="story"
    tint="#F3EFFF"
    color="var(--purple-d)"
    title="智能拼音童话"
    :note="storyNote"
  >
    <template #head>
      <span class="pt-pill">自动注音 · 读过不重复</span>
    </template>

    <template #mid>
      <select v-if="storyOptions.length" v-model.number="pickedId" class="sel" aria-label="选择要读的童话">
        <option v-for="s in storyOptions" :key="s.id" :value="s.id">{{ s.title }}</option>
      </select>

      <button
        class="timer-chip"
        :class="{ run: story.timer.running }"
        type="button"
        :disabled="!canToggleTimer"
        :title="story.timer.running ? '点一下结束这一轮计时' : '点一下开始计时'"
        @click="toggleTimer()"
      >
        <Icon name="clock" :size="17" />
        <b class="timer-clock" :class="{ run: story.timer.running }">{{ story.timerClock }}</b>
        <span v-if="timerLabel" class="tb-say">{{ timerLabel }}</span>
      </button>
    </template>

    <button class="btn purple sm" type="button" :disabled="story.generating" @click="regenerate()">
      <Icon name="sparkle" :size="16" />{{ story.generating ? "正在写…" : "换一篇童话" }}
    </button>
    <button
      class="btn ghost sm fav-btn"
      :class="{ on: fav }"
      type="button"
      :disabled="!hasStory"
      :title="fav ? '已收藏，点一下取消' : '收藏这一篇'"
      @click="toggleFav()"
    >
      <!-- 文字恒为「收藏」，宽度不变：多一个字会把工具栏挤换行；
           收藏态用星星变金黄实心 + 按钮变金黄底来表达 -->
      <Icon name="star" :size="16" :stroke="2.2" :fill="fav ? '#F5B301' : 'none'" />
      收藏
    </button>
    <button class="btn ghost sm" type="button" @click="toggleRead()">
      <Icon :name="isPlaying ? 'stop' : 'speakerLoud'" :size="16" />{{ isPlaying ? "停止朗读" : "朗读" }}
    </button>
  </PageTool>

  <section class="card">
    <!-- 生成失败是**异常**不是备注，得留在明面上，不能塞进 ⓘ -->
    <div v-if="story.lastError" class="tip" style="margin: 0 0 14px; border-left-color: #E95252">
      上次生成失败：{{ story.lastError }}<br />
      家长可以到「运行诊断」里点「测试故事模型」确认链路。
    </div>

    <div class="story-box">
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
</template>

<style scoped>
/* 收藏星星的「已收藏」态：金黄底 + 深金字，一眼看得出这篇已经在收藏夹里 */
.fav-btn.on {
  background: #fff6dc;
  border-color: #f1dfa8;
  color: #c99000;
}
</style>
