<script setup lang="ts">
/**
 * 语文乐园 · 课文听写
 *
 * 三种玩法都在这一页：
 *   · 生字表：点字听读音（先读组词再读单字，用来消歧音近字），可标记已掌握/未掌握
 *   · 纸上听写：生字变「?」，听读音在纸上写，写完揭晓答案
 *   · 屏上听写：在田字格里手写，整轮写完一起交给 AI 或大人（见 DictationPanel）
 */
import { computed, ref, watch } from "vue";
import Icon from "@/components/Icon.vue";
import DictationPanel from "@/components/DictationPanel.vue";
import { dictationItems, playSequence, preloadMany, stopAudio, useAudioState } from "@/composables/useAudio";
import { playBuzz, playDing } from "@/composables/useSound";
import { useContentStore } from "@/stores/content";
import { useMasteryStore } from "@/stores/mastery";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";

const content = useContentStore();
const mastery = useMasteryStore();
const progress = useProgressStore();
const ui = useUiStore();
const { playing: isPlaying } = useAudioState();

const masked = ref(false);
/** 顺序朗读是否进行中（与页面朗读状态解耦，用于按钮文案） */
const readingAll = ref(false);

const chars = computed(() => content.chars);
const stat = computed(() => mastery.lessonStats(content.current?.id ?? 0, chars.value.map((c) => c.ch)));

function speakChar(ch: string, word: string): void {
  readingAll.value = false;
  void playSequence(dictationItems(ch, word));
}

function toggleMask(): void {
  masked.value = !masked.value;
  if (masked.value) {
    readingAll.value = false;
    const first = chars.value[0];
    ui.toast("听写开始！音会念给你听，在纸上写下来吧");
    if (first) void playSequence(dictationItems(first.ch, first.word));
  } else {
    stopAudio();
    readingAll.value = false;
    void progress.completeTask("dictation");
    ui.toast("听写结束，来对对答案吧～");
  }
}

async function toggleReadAll(): Promise<void> {
  if (readingAll.value || isPlaying.value) {
    readingAll.value = false;
    stopAudio();
    ui.toast("已停止朗读");
    return;
  }
  if (!chars.value.length) return;
  masked.value = false;
  readingAll.value = true;
  ui.toast("正在依次朗读，再点一次可停止");
  // 只读单字，串行推进（用 ended 事件，不用定时器）
  await playSequence(
    chars.value.map((c) => ({ text: c.ch, kind: "char" as const })),
    {
      onIndex: (i) => {
        if (i < 0) readingAll.value = false;
      },
    },
  );
  readingAll.value = false;
}

async function mark(ch: string, state: 0 | 1): Promise<void> {
  const lesson = content.current;
  if (!lesson) return;
  try {
    const r = await mastery.toggleChar(lesson.id, ch, state, lesson.title);
    if (r === "cleared") {
      ui.toast(`「${ch}」已取消标记`);
      return;
    }
    if (state === 1) {
      playDing();
      ui.toast(`「${ch}」已标记为掌握`);
    } else {
      playBuzz();
      ui.toast(`「${ch}」已加入错字本，多写几遍吧`);
    }
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : "标记失败");
  }
}

function onLessonChange(e: Event): void {
  const id = Number((e.target as HTMLSelectElement).value);
  stopAudio();
  readingAll.value = false;
  masked.value = false;
  content.selectLesson(id);
}

/** 进入课文（或换课）时，后台把该课生字的音频拉进 Blob 缓存，点击即播 */
watch(
  () => content.current?.id,
  (id) => {
    if (!id) return;
    const items = chars.value.flatMap((c) => dictationItems(c.ch, c.word));
    if (items.length) void preloadMany(items, 3);
  },
  { immediate: true },
);
</script>

<template>
  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #FBEFEA; color: #D9714E">
        <Icon name="chinese" :size="19" />
      </span>
      <div>
        <h2>语文乐园 · 课文听写</h2>
        <span class="sub">二年级上册生字表 · 读音由服务器本地合成</span>
      </div>
    </div>

    <div class="row">
      <select class="sel" style="flex: 1; min-width: 180px" :value="content.current?.id ?? ''" @change="onLessonChange">
        <option v-for="l in content.lessons" :key="l.id" :value="l.id">
          {{ l.title }}<template v-if="l.unit"> · {{ l.unit }}</template>
        </option>
      </select>
      <button class="btn" :class="masked ? 'yellow' : 'green'" type="button" @click="toggleMask()">
        <Icon :name="masked ? 'check' : 'play'" :size="18" />{{ masked ? "结束听写" : "开始听写" }}
      </button>
      <button class="btn" :class="readingAll || isPlaying ? 'yellow' : 'ghost'" type="button" @click="toggleReadAll()">
        <Icon :name="readingAll || isPlaying ? 'stop' : 'speaker'" :size="18" />{{ readingAll || isPlaying ? "停止朗读" : "顺序朗读" }}
      </button>
    </div>

    <DictationPanel />

    <div class="zi-grid" :class="{ masked }">
      <div
        v-for="c in chars"
        :key="c.ch"
        class="zi"
        :class="mastery.charState(content.current?.id ?? 0, c.ch) === 1 ? 'mastered' : mastery.charState(content.current?.id ?? 0, c.ch) === 0 ? 'failed' : ''"
      >
        <button class="zi-face" type="button" :aria-label="`朗读 ${c.ch}`" @click="speakChar(c.ch, c.word)">
          <span class="zi-char">{{ c.ch }}</span>
          <span class="zi-py">{{ content.pinyinOf(c.ch, c) }}</span>
        </button>
        <div class="zi-btns">
          <button
            class="zi-b"
            :class="{ 'on-ok': mastery.charState(content.current?.id ?? 0, c.ch) === 1 }"
            type="button"
            title="已掌握"
            @click="mark(c.ch, 1)"
          >
            <Icon name="check" :size="16" :stroke="2.6" />
          </button>
          <button
            class="zi-b"
            :class="{ 'on-no': mastery.charState(content.current?.id ?? 0, c.ch) === 0 }"
            type="button"
            title="未掌握，加入错字本"
            @click="mark(c.ch, 0)"
          >
            <Icon name="cross" :size="16" :stroke="2.6" />
          </button>
        </div>
      </div>
    </div>

    <div class="zi-stat">
      <span><span class="dot" style="background: #8FE0C2"></span>已掌握 <b>{{ stat.ok }}</b></span>
      <span><span class="dot" style="background: #FFBDBD"></span>未掌握 <b>{{ stat.no }}</b></span>
      <span><span class="dot" style="background: #DDE9F5"></span>未检查 <b>{{ stat.none }}</b></span>
    </div>

    <p class="tip">
      点击生字方块可以听读音（先读组词、再读单字，用来区分「睛 / 晴」这类音近字）。<br />
      纸上听写模式下生字会变成「?」，写完再点「结束听写」揭晓答案；屏上听写则会自动批改并记录到错字本。
    </p>
  </section>
</template>
