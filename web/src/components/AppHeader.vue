<script setup lang="ts">
/**
 * 顶栏：品牌 + 今日完成数 + 能量值。
 * 注意这里**没有**家长入口 —— 家长后台是独立路由 /admin，与孩子的界面完全分开。
 */
import { computed } from "vue";
import { useProgressStore } from "@/stores/progress";

const progress = useProgressStore();
const total = 4;
const pct = computed(() => Math.round((progress.completedCount / total) * 100));
const full = computed(() => progress.completedCount >= total);
</script>

<template>
  <div class="topbar">
    <header class="hd">
      <RouterLink to="/" class="brand">
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M12 3 2.5 8 12 13l9.5-5L12 3Z" fill="#fff" />
            <path d="M6 10.6V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.4l-6 3.2-6-3.2Z" fill="#fff" opacity=".78" />
          </svg>
        </span>
        <span>二年级快乐学习台</span>
      </RouterLink>

      <div class="spacer"></div>

      <div class="stat-pill" :class="{ full }">今日已完成 <b>{{ progress.completedCount }}</b> / {{ total }} 项任务</div>

      <div class="energy" :title="`能量值 ${pct}%`">
        <span class="stars" aria-hidden="true">
          <svg v-for="i in total" :key="i" viewBox="0 0 24 24">
            <path
              d="M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.4 9.9l6-.9z"
              :fill="i <= progress.completedCount ? '#FFD93D' : '#E4ECF5'"
              :stroke="i <= progress.completedCount ? '#E8A800' : 'none'"
              stroke-width="1"
            />
          </svg>
        </span>
        <div class="bar"><div class="fill" :style="{ width: `${pct}%` }"></div></div>
      </div>
    </header>
  </div>
</template>
