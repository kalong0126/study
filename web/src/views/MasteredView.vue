<script setup lang="ts">
/**
 * 已掌握生字（首页「学习小档案」第一张卡点进来的页面）
 *
 * 把**所有听写判对的生字**（大人点过「写对」、或掌握度被标为 ✓ 的字）按课文分组罗列。
 * 数据不用新接口：掌握度全表在启动时已经拿到（useBootstrap → mastery.snapshot），
 * 这页只负责把它和课文生字表（拼音 / 组词）对上、按课分组画出来。
 *
 * 每个字可以点：先读组词再读单字 —— 和语文乐园生字条同一套读音规则，
 * 孩子点着复习「这个字我又认识一遍」。
 */
import { computed, onMounted } from "vue";
import PageTool from "@/components/PageTool.vue";
import { dictationItems, playSequence, stopAudio } from "@/composables/useAudio";
import { useContentStore } from "@/stores/content";
import { useMasteryStore } from "@/stores/mastery";

const content = useContentStore();
const mastery = useMasteryStore();

onMounted(() => {
  // 掌握度由启动流程保证已加载；课文/生字表这里再保底拉一次（store 内部幂等）
  void content.load();
});

/** 有已掌握生字的课文，按课文顺序分组 */
const groups = computed(() =>
  content.lessons
    .map((l) => {
      const book = mastery.mastery[String(l.id)] ?? {};
      const chars = l.chars.filter((c) => !c.hidden && book[c.ch] === 1);
      return { id: l.id, title: l.title, unit: l.unit, chars };
    })
    .filter((g) => g.chars.length > 0),
);

const total = computed(() => groups.value.reduce((n, g) => n + g.chars.length, 0));
/** 课文表还在路上（首页点进来第一次打开时可能没拉完） */
const loading = computed(() => !content.loaded && !content.loadError);

const note = [
  "这里列的是听写时判对的生字（大人点过「写对」的字），按课文分组。",
  "点任何一个字可以再听一遍读音（先读组词、再读单字）。",
  "想复习某个字回到「语文乐园 → 生字听写」重新写一遍就好。",
].join("\n");

function speak(ch: string, word: string): void {
  stopAudio();
  void playSequence(dictationItems(ch, word));
}
</script>

<template>
  <PageTool icon="chinese" tint="#E9FBF3" color="#2FA37A" title="已掌握生字" :meta="`${total} 个字`" :note="note">
    <template #head>
      <span class="pt-pill">点字听读音</span>
    </template>
  </PageTool>

  <section v-if="loading" class="card">
    <p class="tip" style="margin: 0">正在拿生字表…</p>
  </section>

  <section v-else-if="groups.length" class="card">
    <div v-for="g in groups" :key="g.id" class="m-group">
      <span class="m-lesson">{{ g.title }}<template v-if="g.unit"> · {{ g.unit }}</template></span>
      <div class="zi-grid">
        <button
          v-for="c in g.chars"
          :key="g.id + c.ch"
          class="zi mastered"
          type="button"
          :aria-label="`朗读 ${c.ch}`"
          @click="speak(c.ch, c.word)"
        >
          <span class="zi-char">{{ c.ch }}</span>
          <span class="zi-py">{{ content.pinyinOf(c.ch, c) }}</span>
        </button>
      </div>
    </div>
  </section>

  <section v-else class="card">
    <div class="wb-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="#B9CCDE" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
      <div>还没有掌握的生字</div>
      <div>去「语文乐园」完成一轮听写，写对的字都会记在这里</div>
    </div>
  </section>
</template>

<style scoped>
.m-group + .m-group { margin-top: 18px; }
.m-lesson {
  display: inline-block;
  font-size: 13px;
  font-weight: 800;
  color: #2FA37A;
  background: #E9FBF3;
  border-radius: 999px;
  padding: 3px 12px;
  margin-bottom: 10px;
}
</style>
