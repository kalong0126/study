<script setup lang="ts">
/**
 * 语文乐园 · 课文听写
 *
 * 两种玩法都在这一页（2026-09-19 改版，用户要求）：
 *   · 课文朗读：全文分句朗读，课文里的生字红色标注
 *   · 生字听写：
 *       上方一条「生字条」——整课生字 + 注音一次排开、一行显示完（一般 ≤ 12 个），
 *       纯展示：点一下听读音（先组词再单字），不再挂 ✓/✗ 判定按钮，也不再有统计行。
 *       下方「屏上听写」——**默认隐藏**，点工具栏的「开始听写」才展开，
 *       并且一展开就直接进书写（没有中间那个「点我开始」的空转页面）。
 *
 * 听写期间生字条会遮成「?」（还是不许偷看），但**系统不判对错**：
 * 一轮把该练的字（首轮＝整课还没掌握的）**全部写完**，再一次交给大人，
 * 大人点「写对 / 写错」才落库（掌握度 / 错字本）—— 不再按 6 个字切轮，
 * 也不再有大模型判卷。纸上听写（生字变 ? + 揭晓答案）那条路已删。
 */
import { computed, ref, watch } from "vue";
import Icon from "@/components/Icon.vue";
import PageTool from "@/components/PageTool.vue";
import DictationPanel from "@/components/DictationPanel.vue";
import { dictationItems, playSequence, preloadMany, stopAudio, useAudioState } from "@/composables/useAudio";
import { useContentStore } from "@/stores/content";
import { useMasteryStore } from "@/stores/mastery";
import { useUiStore } from "@/stores/ui";
import { speakableSentences } from "@/utils/sentences";

const content = useContentStore();
const mastery = useMasteryStore();
const ui = useUiStore();
const { playing: isPlaying } = useAudioState();

/** 屏上听写是否展开（默认隐藏）——展开即听写进行中，生字条要遮上 */
const dictating = ref(false);
const panel = ref<InstanceType<typeof DictationPanel> | null>(null);
/** 生字条是否需要遮住：听写全程都遮（不判对错，写好交给大人看） */
const masked = computed(() => dictating.value);

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
  dictating.value = false; // 切页收起屏上听写（组件 v-if 卸载时会自己停音频）
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

/** 备注（原「红色是本课生字…」那行小字 + 卡片底部那段提示），收进工具栏最右侧的 ⓘ */
const cnNote = computed(() =>
  tab.value === "text"
    ? [
        "红色标出的是这一课的生字。",
        "点「朗读课文」听全文，再点一次停下来；读音由服务器本地合成，不需要联网的语音服务。",
        "换课文用工具栏左边那个下拉（章节和课文在一起）。",
      ].join("\n")
    : [
        "上面那条是这一课的生字表，点一个字可以听读音（先读组词、再读单字，用来区分「睛 / 晴」这类音近字）。",
        "点「开始听写」打开下面的田字格，听到读音就写下来；听写时生字表会遮住，写完再恢复。",
        "系统不判对错：写完整轮交给大人，大人点「写对 / 写错」——写对的记掌握，写错的进错字本。",
        "一块田字格写一个字，「清空重写」可以擦掉重来；一轮把这课（或剩下没掌握的）生字全部写完，再统一交给大人。",
      ].join("\n"),
);

function speakChar(ch: string, word: string): void {
  stopAudio();
  void playSequence(dictationItems(ch, word));
}

/** 开始 / 结束屏上听写（工具栏上唯一的那个主操作按钮） */
function toggleDictation(): void {
  if (dictating.value) {
    panel.value?.end();
    return;
  }
  if (!chars.value.length) {
    ui.toast("这篇课文还没有生字表，请家长先到内容后台录入");
    return;
  }
  // 只置 true：面板挂载时自己 start()（见 DictationPanel 的 onMounted），
  // 这里再调一次就会开两轮（roundNo 跳号、读音播两遍）。
  dictating.value = true;
}

/** 生字条上的掌握状态：只用于底色（写对的浅绿、写错的浅红），不再是可点的判定按钮 */
function stateOf(ch: string): string {
  const s = mastery.charState(content.current?.id ?? 0, ch);
  return s === 1 ? "mastered" : s === 0 ? "failed" : "";
}

/** 换课文时收起听写，并把该课生字的音频拉进 Blob 缓存，点击即播 */
watch(
  () => content.current?.id,
  (id) => {
    dictating.value = false;
    if (!id) return;
    const items = chars.value.flatMap((c) => dictationItems(c.ch, c.word));
    if (items.length) void preloadMany(items, 3);
  },
  { immediate: true },
);

function onLessonChange(e: Event): void {
  const id = Number((e.target as HTMLSelectElement).value);
  stopAudio();
  content.selectLesson(id);
}
</script>

<template>
  <!-- 详情页统一工具栏：标题（含当前模式）/ 章节下拉 / 两个模式的分段切换 /
       主操作 / 备注图标，全在一条 53px 的行上。 -->
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
      <button class="btn green sm" type="button" :disabled="!chars.length" @click="toggleDictation()">
        <Icon :name="dictating ? 'stop' : 'play'" :size="16" />{{ dictating ? "结束听写" : "开始听写" }}
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

  <!-- 第 2 页：生字听写 —— 上：生字条（一行展示，听写时遮住）；下：屏上听写（默认隐藏） -->
  <section v-else class="card">
    <div v-if="chars.length" class="zi-strip" :class="{ masked }">
      <button
        v-for="c in chars"
        :key="c.ch"
        class="zi"
        :class="stateOf(c.ch)"
        type="button"
        :aria-label="masked ? '听写中' : `朗读 ${c.ch}`"
        @click="speakChar(c.ch, c.word)"
      >
        <span class="zi-char">{{ c.ch }}</span>
        <span class="zi-py">{{ content.pinyinOf(c.ch, c) }}</span>
      </button>
    </div>
    <p v-else class="tip">这篇课文还没有生字表，家长可以在内容后台录入。</p>

    <DictationPanel
      v-if="dictating"
      ref="panel"
      @close="dictating = false"
    />
  </section>
</template>
