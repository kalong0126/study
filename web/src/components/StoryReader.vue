<script setup lang="ts">
/**
 * 故事阅读器
 *
 * 关键设计（来自改造计划 §9.3）：**不要**把整篇合成一个 mp3 从头播到底。
 * 按句切分，每句一段音频，前端串行播放 + 高亮当前句，好处是：
 *   · 孩子能跟着高亮跟读
 *   · 单句可以重复听（点句子即从这句开始）
 *   · 缓存粒度是句子，长文也不会一次合成很久
 *
 * 正文是**整页滚动**阅读（不是翻页、也不再是内层滚动）：
 * 2026-09-19 按用户规则③去掉正文自己的滚动条 —— 页面只保留浏览器主滚动，
 * 卡片里不许再嵌一条滚动条。之前正文高度锁 5 行、overflow-y:auto，
 * 平板上一划就滚错层（内层滚到底才带动外层）。
 * 翻页那版是按「量出来的句子坐标」切页的，可注音 ruby 的行高、字体换入的时机、
 * 平板的实际宽度都会让换行变化 —— 量得再准也会在孩子翻到一半时错位（实测结论：不够准）。
 * 现在内容就是内容：长文把页面撑开，由浏览器滚，读到哪里看哪里。
 */
import { computed, ref, watch } from "vue";
import { playSequence, stopAudio, useAudioState } from "@/composables/useAudio";
import { useContentStore } from "@/stores/content";
import { isSpeakable, splitSentences } from "@/utils/sentences";

const props = defineProps<{
  title: string;
  text: string;
}>();

const content = useContentStore();
const { playing: isPlaying, currentText } = useAudioState();

/** 统一成一种 token 形状：han=true 是汉字（带拼音），否则是标点/空白 */
interface Token {
  han: boolean;
  ch: string;
  py: string;
  text: string;
}
interface Sentence {
  index: number;
  tokens: Token[];
}
interface Line {
  sentences: Sentence[];
}

/** 把一段连续汉字切成「拼音 + 字」的 token；标点作为普通文本 */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[\u4e00-\u9fa5]+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ han: false, ch: "", py: "", text: text.slice(last, m.index) });
    const run = m[0];
    const py = content.pinyinArray(run);
    for (let i = 0; i < run.length; i++) {
      out.push({ han: true, ch: run[i], py: py[i] ?? "", text: run[i] });
    }
    last = m.index + run.length;
  }
  if (last < text.length) out.push({ han: false, ch: "", py: "", text: text.slice(last) });
  return out;
}

const lines = computed<Line[]>(() => {
  const raw = String(props.text || "").split(/\n+/).filter((l) => l.trim().length > 0);
  const src = raw.length ? raw : [String(props.text || "")];
  const out: Line[] = [];
  let idx = 0;
  for (const line of src) {
    // 断句统一走 utils/sentences：收尾引号会黏在上一句，
    // 不会再切出孤立的 `”`（那个曾被当成一句话送去合成 → 空音频 → 503）
    const sentences: Sentence[] = [];
    for (const t of splitSentences(line)) {
      sentences.push({ index: idx++, tokens: tokenize(t) });
    }
    if (sentences.length) out.push({ sentences });
  }
  return out;
});

/** 扁平句子列表：下标连续，是「第几句」与高亮的唯一基准 */
const allSentences = computed<Sentence[]>(() => lines.value.flatMap((l) => l.sentences));

const textOf = (s: Sentence): string => s.tokens.map((tok) => tok.text).join("");

const currentIdx = ref(-1);

/** 正文容器（整页滚动，不再自己滚） */
const viewEl = ref<HTMLElement | null>(null);

/**
 * 朗读走到下一句时把那句带进视野。
 * 整页滚动之后「有没有滚」看的是**视口**，不再是容器：
 * 已经能看见就不动它（每句都滚会让正文一直在动，孩子反而跟不住），
 * 看不见才 `scrollIntoView`。`block:"center"` 让它落在视口中间，
 * 顶栏是 sticky 的（64px），落在中间就不会被压住。
 */
watch(currentIdx, (idx) => {
  const el = viewEl.value?.querySelector<HTMLElement>(`.sent[data-i="${idx}"]`);
  if (idx < 0 || !el) return;
  const r = el.getBoundingClientRect();
  const top = 76; // 顶栏 64 + 一点余量
  const bottom = window.innerHeight - 24;
  if (r.top >= top && r.bottom <= bottom) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
});

/* ------------------------------ 朗读 ------------------------------ */

async function playFrom(start: number): Promise<void> {
  // 只把「有字可读」的句子排进队列：纯标点片段（单独一行的 `……` 之类）跳过，
  // 但仍保留下标，让高亮落在正确的那一句上。
  const queue = allSentences.value.slice(start).filter((s) => isSpeakable(textOf(s)));
  if (!queue.length) return;
  const items = queue.map((s) => ({ text: textOf(s), kind: "sentence" as const }));
  await playSequence(items, {
    onIndex: (i) => {
      currentIdx.value = i < 0 ? -1 : queue[i].index;
    },
  });
}

function start(): void {
  currentIdx.value = -1;
  void playFrom(0);
}

function stop(): void {
  stopAudio();
  currentIdx.value = -1;
}

function onSentenceClick(idx: number): void {
  stopAudio();
  void playFrom(idx);
}

defineExpose({ start, stop });
</script>

<template>
  <div v-if="title" class="story-title">{{ title }}</div>

  <!-- 正文：普通文档流（整页由浏览器滚），不再有自己的滚动条 -->
  <div ref="viewEl" class="story-text">
    <p v-for="(line, li) in lines" :key="li">
      <span
        v-for="s in line.sentences"
        :key="s.index"
        class="sent"
        :data-i="s.index"
        :class="{ cur: currentIdx === s.index }"
        @click="onSentenceClick(s.index)"
      >
        <template v-for="(tok, ti) in s.tokens" :key="ti">
          <span v-if="!tok.han" class="punct">{{ tok.text }}</span>
          <ruby v-else>{{ tok.ch }}<rt>{{ tok.py }}</rt></ruby>
        </template>
      </span>
    </p>
  </div>

  <!-- 「点句子可以朗读」这种说明已收进工具栏的 ⓘ；这里只留正在读哪一句的**实时**状态 -->
  <p v-if="isPlaying" class="tip" style="margin-top: 14px">正在朗读：{{ currentText }}</p>
</template>
