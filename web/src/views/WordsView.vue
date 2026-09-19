<script setup lang="ts">
/**
 * 已掌握词语（首页「学习小档案」第二张卡点进来的页面）
 *
 * 把语言强化训练里**曾经出现过的词语**全部罗列出来（跨天汇总，按最近出现倒序），
 * 数据来自后端 `/language/words`（扫所有按天存的题集汇总）。
 *
 * 每个词可以点：读一遍词语；释义 / 例句直接摆在卡上 ——
 * 这一页是「我的词语本」，不是做题页。
 */
import { computed, onMounted, ref } from "vue";
import { describeApiError } from "@/api";
import Icon from "@/components/Icon.vue";
import PageTool from "@/components/PageTool.vue";
import { playSequence, stopAudio, useAudioState } from "@/composables/useAudio";
import { api } from "@/api";
import { useContentStore } from "@/stores/content";
import type { LearnedWord } from "@/api/types";

const content = useContentStore();
const { playing: isPlaying } = useAudioState();

const words = ref<LearnedWord[]>([]);
const loading = ref(true);
const loadError = ref("");

onMounted(async () => {
  try {
    words.value = await api.languageWords();
  } catch (e) {
    loadError.value = describeApiError(e);
  } finally {
    loading.value = false;
  }
});

/** 当前正在读的那个词（卡片上给个小小的播放态） */
const speakingWord = ref("");

function speak(w: LearnedWord): void {
  if (speakingWord.value === w.word || isPlaying.value) {
    stopAudio();
    speakingWord.value = "";
    return;
  }
  stopAudio();
  speakingWord.value = w.word;
  void playSequence([{ text: w.word, kind: "word" }]).finally(() => {
    if (speakingWord.value === w.word) speakingWord.value = "";
  });
}

/** 词语的逐字拼音（pinyin-pro 现算，多音字按词取大概率读音，够展示用） */
function pyOf(word: string): string {
  return content.pinyinArray(word).join(" ");
}

const note = [
  "这里收的是语言强化训练里出现过的词语，每做过一套题，新词就会进来。",
  "点一张卡片可以听这个词的读音；卡片上写着它的意思和例句。",
  "右上角是小本本的厚度：做过越多天，词语就越多。",
].join("\n");

const subtitle = computed(() => `${words.value.length} 个词`);
</script>

<template>
  <PageTool icon="wand" tint="#FFEFF3" color="#D9557C" title="已掌握词语" :meta="subtitle" :note="note">
    <template #head>
      <span class="pt-pill">来自语言强化训练</span>
    </template>
  </PageTool>

  <section v-if="loading" class="card">
    <p class="tip" style="margin: 0">正在翻词语小本本…</p>
  </section>

  <section v-else-if="loadError" class="card">
    <p class="tip" style="margin: 0; border-left-color: #E95252">{{ loadError }}</p>
  </section>

  <section v-else-if="words.length" class="card">
    <div class="word-list">
      <button v-for="w in words" :key="w.word" class="word-card" type="button" @click="speak(w)">
        <span class="word-head">
          <b class="word-w">{{ w.word }}</b>
          <span class="word-py">{{ pyOf(w.word) }}</span>
          <span class="word-play" :class="{ on: speakingWord === w.word }">
            <Icon :name="speakingWord === w.word ? 'stop' : 'speaker'" :size="15" />
          </span>
        </span>
        <span class="word-info">
          <span v-if="w.meaning" class="word-mean">{{ w.meaning }}</span>
          <span v-if="w.example" class="word-ex">例句：{{ w.example }}</span>
        </span>
        <span class="word-meta">
          <span v-if="w.theme" class="word-theme">{{ w.theme }}</span>
          <span>{{ w.date }}<template v-if="w.times > 1"> · 出现过 {{ w.times }} 次</template></span>
        </span>
      </button>
    </div>
  </section>

  <section v-else class="card">
    <div class="wb-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="#B9CCDE" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.4 9.9l6-.9z" />
      </svg>
      <div>词语小本本还是空的</div>
      <div>去「语言练习」做完一套题，学过的词都会记在这里</div>
    </div>
  </section>
</template>

<style scoped>
.word-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.word-card {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  text-align: left;
  padding: 12px 16px;
  border-radius: 16px;
  font-family: inherit;
  background: linear-gradient(160deg, #ffffff, #fdf3f7);
  border: 1.5px solid #fbd9e4;
  cursor: pointer;
  transition: 0.2s;
}
.word-card:hover { border-color: #f3b7ca; }
.word-card:active { transform: scale(0.985); }
.word-head {
  flex: none;
  width: 128px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.word-w {
  font-size: 24px;
  font-weight: 900;
  color: #d9557c;
  line-height: 1.2;
  letter-spacing: 1px;
}
.word-py {
  font-size: 12px;
  font-weight: 700;
  color: #e58aa6;
  letter-spacing: 0.4px;
  line-height: 1.2;
}
.word-play {
  margin-top: 3px;
  width: 26px;
  height: 26px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ffeef4;
  color: #d9557c;
}
.word-play.on { background: #d9557c; color: #fff; }
.word-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.word-mean { font-size: 13.5px; color: var(--ink2); line-height: 1.55; }
.word-ex {
  font-size: 12px;
  color: var(--ink3);
  line-height: 1.55;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.word-meta {
  flex: none;
  max-width: 96px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: 11px;
  color: var(--ink3);
  line-height: 1.5;
  text-align: right;
}
.word-theme {
  color: #d9557c;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 96px;
}
@media (max-width: 599px) {
  .word-card { flex-wrap: wrap; gap: 8px 14px; }
  .word-head { width: auto; flex-direction: row; align-items: baseline; gap: 8px; }
  .word-meta { max-width: none; flex-direction: row; gap: 6px; width: 100%; justify-content: flex-end; }
}
</style>
