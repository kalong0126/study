<script setup lang="ts">
/**
 * 语文乐园 · 课文听写
 *
 * 三种玩法都在这一页：
 *   · 生字表：点字听读音（先读组词再读单字，用来消歧音近字），可标记已掌握/未掌握
 *   · 纸上听写：生字变「?」，听读音在纸上写，写完揭晓答案
 *   · 屏上听写：在田字格里手写，整轮写完交给大人逐个判定（见 DictationPanel；已不接大模型判卷）
 */
import { computed, ref, watch } from "vue";
import Icon from "@/components/Icon.vue";
import PageTool from "@/components/PageTool.vue";
import DictationPanel from "@/components/DictationPanel.vue";
import { dictationItems, playSequence, preloadMany, stopAudio, useAudioState } from "@/composables/useAudio";
import { playBuzz, playDing } from "@/composables/useSound";
import { useContentStore } from "@/stores/content";
import { useMasteryStore } from "@/stores/mastery";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";
import { speakableSentences } from "@/utils/sentences";

const content = useContentStore();
const mastery = useMasteryStore();
const progress = useProgressStore();
const ui = useUiStore();
const { playing: isPlaying } = useAudioState();

/** 纸上听写是否遮住生字（开始听写 → 生字变「?」） */
const paperMasked = ref(false);
/** 屏上听写是否进行中（进行中同样要遮住下方生字，防止偷看答案） */
const screenDictating = ref(false);
/** 生字是否需要遮住：纸上听写 或 屏上听写进行中，任一为真就遮 */
const masked = computed(() => paperMasked.value || screenDictating.value);

/** 两页式：text = 课文原文（朗读 + 生字红标）；dictation = 生字听写 */
const tab = ref<"text" | "dictation">("text");

const chars = computed(() => content.chars);

/** 课文原文（可能为空——家长尚未录入） */
const lessonText = computed(() => (content.current?.content ?? "").trim());

/** 生字集合（用于在课文里红色标注） */
const newCharSet = computed(() => new Set(chars.value.map((c) => c.ch)));

/**
 * 课文分段：按自然段（\n）切，每段再按「是否生字」切成长短片段，
 * 生字段用 .lesson-new 红色渲染，非生字段原样输出。
 */
const paragraphs = computed(() => {
  const set = newCharSet.value;
  return lessonText.value
    .split("\n")
    .filter((p) => p.trim())
    .map((para) => {
      const segs: { text: string; isNew: boolean }[] = [];
      let cur = "";
      let curNew = false;
      for (const ch of para) {
        const isNew = set.has(ch);
        if (cur && isNew !== curNew) {
          segs.push({ text: cur, isNew: curNew });
          cur = "";
        }
        cur += ch;
        curNew = isNew;
      }
      if (cur) segs.push({ text: cur, isNew: curNew });
      return segs;
    });
});

const lessonPlaying = ref(false);

function switchTab(next: "text" | "dictation"): void {
  if (tab.value === next) return;
  tab.value = next;
  stopAudio();
  lessonPlaying.value = false;
}

/** 朗读整篇课文（分句串行，点一次读、再点停止） */
async function toggleLessonRead(): Promise<void> {
  if (lessonPlaying.value || isPlaying.value) {
    lessonPlaying.value = false;
    stopAudio();
    ui.toast("已停止朗读");
    return;
  }
  const sentences = speakableSentences(lessonText.value);
  if (!sentences.length) {
    ui.toast("这篇课文还没有原文，先选一篇有原文的吧");
    return;
  }
  lessonPlaying.value = true;
  await playSequence(
    sentences.map((s) => ({ text: s, kind: "sentence" as const })),
    { onIndex: (i) => { if (i < 0) lessonPlaying.value = false; } },
  );
  lessonPlaying.value = false;
}
const stat = computed(() => mastery.lessonStats(content.current?.id ?? 0, chars.value.map((c) => c.ch)));

/** 备注（原「红色是本课生字…」那行小字 + 卡片底部那段提示），收进工具栏最右侧的 ⓘ */
const cnNote = computed(() =>
  tab.value === "text"
    ? [
        "红色标出的是这一课的生字。",
        "点「朗读课文」听全文，再点一次停下来；读音由服务器本地合成，不需要联网的语音服务。",
        "换课文用工具栏左边那个下拉（章节和课文在一起）。",
      ].join("\n")
    : [
        "点击生字方块可以听读音：先读组词、再读单字，用来区分「睛 / 晴」这类音近字。",
        "「开始听写」＝纸上听写：生字会变成「?」，写完再点一次揭晓答案。",
        "下面那块屏上听写是在田字格里手写，写完整轮交给大人看，不经大模型；大人逐个点「写对 / 写错」。",
        "每个字下面的 ✓ / ✗ 是大人的手动标记：点 ✓ 记掌握、点 ✗ 进错字本，再点一次取消。",
      ].join("\n"),
);

function speakChar(ch: string, word: string): void {
  stopAudio();
  void playSequence(dictationItems(ch, word));
}

function toggleMask(): void {
  paperMasked.value = !paperMasked.value;
  if (paperMasked.value) {
    const first = chars.value[0];
    ui.toast("听写开始！音会念给你听，在纸上写下来吧");
    if (first) void playSequence(dictationItems(first.ch, first.word));
  } else {
    stopAudio();
    void progress.completeTask("dictation");
    ui.toast("听写结束，来对对答案吧～");
  }
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
  paperMasked.value = false;
  content.selectLesson(id);
}

/** 屏上听写开始/结束时回调：进行中遮住下方生字，结束再恢复显示 */
function onScreenDictation(active: boolean): void {
  screenDictating.value = active;
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
  <!-- 详情页统一工具栏：标题（含当前模式）/ 章节下拉 / 两个模式的分段切换 /
       主操作 / 轻量操作 / 备注图标，全在一条 53px 的行上。
       以前是「卡片头 → 一排下拉 → 一排分区标签 → 一排按钮」四层竖排。 -->
  <PageTool icon="chinese" tint="#FBEFEA" color="#D9714E" :note="cnNote">
    <template #title>
      <span>语文乐园</span>
      <span class="pt-slash" aria-hidden="true">/</span>
      <span>{{ tab === "text" ? "课文朗读" : "生字听写" }}</span>
    </template>

    <template #mid>
      <select class="sel lesson-sel" :value="content.current?.id ?? ''" aria-label="选择课文" @change="onLessonChange">
        <option v-for="l in content.lessons" :key="l.id" :value="l.id">
          {{ l.title }}<template v-if="l.unit"> · {{ l.unit }}</template>
        </option>
      </select>

      <div class="seg" style="--seg-c: #E95252">
        <button class="seg-btn" :class="{ on: tab === 'text' }" type="button" @click="switchTab('text')">
          <Icon name="story" :size="16" />课文朗读
        </button>
        <button class="seg-btn" :class="{ on: tab === 'dictation' }" type="button" @click="switchTab('dictation')">
          <Icon name="chinese" :size="16" />生字听写 <span class="n">{{ chars.length }}</span>
        </button>
      </div>
    </template>

    <template v-if="tab === 'text'">
      <button class="btn green sm" type="button" @click="toggleLessonRead()">
        <Icon :name="lessonPlaying || isPlaying ? 'stop' : 'speaker'" :size="16" />
        {{ lessonPlaying || isPlaying ? "停止朗读" : "朗读课文" }}
      </button>
    </template>
    <template v-else>
      <button class="btn green sm" type="button" @click="toggleMask()">
        <Icon :name="paperMasked ? 'check' : 'play'" :size="16" />{{ paperMasked ? "结束听写" : "开始听写" }}
      </button>
    </template>
  </PageTool>

  <!-- 第 1 页：课文原文（支持朗读 + 生字红标） -->
  <section v-if="tab === 'text'" class="card">
    <div v-if="paragraphs.length" class="story-text">
      <p v-for="(segs, pi) in paragraphs" :key="pi">
        <template v-for="(seg, si) in segs" :key="si">
          <span v-if="seg.isNew" class="lesson-new">{{ seg.text }}</span>
          <template v-else>{{ seg.text }}</template>
        </template>
      </p>
    </div>
    <div v-else class="wb-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="#B9CCDE" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
      这篇课文还没有录入原文，家长可以在内容后台补上。
    </div>
  </section>

  <!-- 第 2 页：生字听写 -->
  <section v-else class="card">
    <DictationPanel @active="onScreenDictation" />

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
  </section>
</template>
