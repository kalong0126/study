<script setup lang="ts">
/**
 * 今日：任务清单 + 学习小档案
 *
 * 这一页是**孩子端**，只保留孩子会用、爱点的东西。
 * 「快速开始」那一排放的是几个纯跳转按钮，下面的任务卡片本来就能去同样的页面，
 * 两套入口重复 → 已删掉。
 *
 * 家长的东西（内容后台、数据备份、运行诊断）一律不在这里出现：
 * 孩子不会用，只有误点的份（手滑点了「导入恢复」是要出事的）。
 * 家长请直接访问 /admin —— 孩子端不提供任何指向它的链接。
 */
import { computed } from "vue";
import { useRouter } from "vue-router";
import Icon from "@/components/Icon.vue";
import { useContentStore } from "@/stores/content";
import { useMasteryStore } from "@/stores/mastery";
import { TASK_DEFS, useProgressStore } from "@/stores/progress";
import { useStoryStore } from "@/stores/story";

const router = useRouter();
const progress = useProgressStore();
const mastery = useMasteryStore();
const content = useContentStore();
const story = useStoryStore();

const toneColor: Record<string, string> = {
  blue: "#4FA3DC",
  orange: "#D9714E",
  purple: "#8E7BEF",
  green: "#3FBF8F",
};

const toneIcon: Record<string, string> = {
  blue: "math",
  orange: "chinese",
  purple: "story",
  green: "none",
};

const remaining = computed(() => TASK_DEFS.length - progress.completedCount);
const taskPct = computed(() => Math.round((progress.completedCount / TASK_DEFS.length) * 100));

function taskDesc(key: string, fallback: string): string {
  if (key === "math") {
    const head = `已作答 ${progress.mathAnswered} / ${progress.mathTotal} 题${progress.mathPerfect ? " · 全对" : ""}`;
    // 有真实计时数据才显示时间 —— 否则会写出「用时 0 秒」这种怪东西
    // （比如"今天这套题在加计时之前就已经做完了"）
    if (progress.mathElapsedSec <= 0) return head;
    return progress.mathDone ? `${head} · 用时 ${progress.mathElapsedText}` : `${head} · 已用时 ${progress.mathClock}`;
  }
  if (key === "review") return progress.reviewText;
  return fallback;
}

const stats = computed(() => [
  { n: mastery.masteredCount, l: "已掌握生字", c: "#3FBF8F", bg: "#E9FBF3" },
  { n: mastery.wrongTotal, l: "错题待复习", c: "#C4486B", bg: "#FFEFF3" },
  { n: story.stories.length, l: "读过的故事", c: "#8E7BEF", bg: "#F3EFFF" },
]);

</script>

<template>
  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #FFF6E0; color: #C97F00">
        <Icon name="sun" :size="19" />
      </span>
      <div>
        <h2>今天要处理</h2>
        <span class="sub">{{ remaining > 0 ? `还有 ${remaining} 项没完成，加油！` : "今天的任务全部完成，太厉害了！" }}</span>
      </div>
    </div>

    <button
      v-for="d in TASK_DEFS"
      :key="d.key"
      class="task"
      :class="progress.isDone(d.key) ? 'done' : 'pending'"
      type="button"
      @click="router.push(d.route)"
    >
      <span class="t-ico">
        <span :style="{ color: toneColor[d.tone], display: 'flex' }">
          <Icon v-if="d.key === 'review'" name="wrong" :size="20" />
          <Icon v-else :name="toneIcon[d.tone]" :size="20" />
        </span>
      </span>
      <span class="t-main">
        <span class="t-name">{{ d.name }}</span>
        <span class="t-desc">{{ taskDesc(d.key, d.desc) }}</span>
      </span>
      <span class="t-chip">{{ progress.isDone(d.key) ? "已完成" : "待完成" }}</span>
      <svg v-if="progress.isDone(d.key)" class="t-check" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" fill="#7FDCB8" />
        <path d="M7.5 12.4 10.6 15.5 16.5 9" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <div class="progress-line" style="margin-top: 6px">
      <span>能量值</span>
      <div class="bar"><div class="fill" :style="{ width: `${taskPct}%` }"></div></div>
      <span>{{ taskPct }}%</span>
    </div>
  </section>

  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #FBF0FF; color: var(--purple-d)">
        <Icon name="star" :size="19" />
      </span>
      <div><h2>学习小档案</h2><span class="sub">你的成长看得见</span></div>
    </div>
    <div class="grid3">
      <div v-for="s in stats" :key="s.l" :style="{ background: s.bg, borderRadius: '16px', padding: '14px', textAlign: 'center' }">
        <div :style="{ fontSize: '30px', fontWeight: 900, color: s.c, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }">{{ s.n }}</div>
        <div style="font-size: 13px; color: #6C8098; font-weight: 700; margin-top: 4px">{{ s.l }}</div>
      </div>
    </div>
    <p class="tip">
      当前课文库共 {{ content.lessons.length }} 篇课文。家长可以登录内容后台继续录制新的篇章，孩子这边立刻就能选到。<br />
      （内容后台与数据备份都在 <code>/admin</code>，只能靠网址打开，孩子端不放入口。）
    </p>
  </section>
</template>
