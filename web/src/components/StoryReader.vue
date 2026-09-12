<script setup lang="ts">
/**
 * 故事阅读器
 *
 * 关键设计（来自改造计划 §9.3）：**不要**把整篇合成一个 mp3 从头播到底。
 * 按句切分，每句一段音频，前端串行播放 + 高亮当前句，好处是：
 *   · 孩子能跟着高亮跟读
 *   · 单句可以重复听（点句子即从这句开始）
 *   · 缓存粒度是句子，长文也不会一次合成很久
 */
import { computed, ref } from "vue";
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
  <div class="story-text">
    <p v-for="(line, li) in lines" :key="li">
      <span
        v-for="s in line.sentences"
        :key="s.index"
        class="sent"
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
  <p class="tip" style="margin-top: 14px">
    点任意一句可以从那句开始朗读，正在读的句子会高亮。
    <template v-if="isPlaying">正在朗读：{{ currentText }}</template>
  </p>
</template>
