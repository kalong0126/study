<script setup lang="ts">
/**
 * 顶栏：品牌 + 今日完成数 + 能量值。
 * 注意这里**没有**家长入口 —— 家长后台是独立路由 /admin，与孩子的界面完全分开。
 *
 * 「回小岛」是各功能页回首页的入口：底部导航整体去掉之后，
 * 孩子从岛上点进某一页，回来的路就是它（品牌 logo 虽然也回首页，但它更像标题）。
 */
import { computed } from "vue";
import { useRoute } from "vue-router";
import Icon from "@/components/Icon.vue";
import { TASK_DEFS, useProgressStore } from "@/stores/progress";

const route = useRoute();
const progress = useProgressStore();
// 任务条数只认 TASK_DEFS，别再写死 4 —— 加一项任务（如语言强化）这里会自动跟上
const total = TASK_DEFS.length;
const pct = computed(() => Math.round((progress.completedCount / total) * 100));
const full = computed(() => progress.completedCount >= total);
/** 「回小岛」只在不在一页时出现（底部导航已按用户要求整体去掉） */
const isHome = computed(() => route.path === "/");
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

      <RouterLink v-if="!isHome" to="/" class="hd-back" aria-label="回到今天的学习小岛">
        <Icon name="arrowLeft" :size="18" :stroke="2.6" /><span>回小岛</span>
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

      <!-- 我的积分入口：数字 + 闪光五角星，点进兑换历史页 -->
      <RouterLink to="/points" class="pts-pill" aria-label="我的积分" :title="`我的积分 ${progress.balance} 分，点开看兑换历史`">
        <span class="pts-star" aria-hidden="true">
          <svg viewBox="0 0 24 24" class="star">
            <defs>
              <linearGradient id="ptsGold" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#FFE873" />
                <stop offset="1" stop-color="#F5A623" />
              </linearGradient>
            </defs>
            <path
              d="M12 2.5 14.9 8.6 21.5 9.4 16.7 14 18 20.6 12 17.3 6 20.6 7.3 14 2.5 9.4 9.1 8.6z"
              fill="url(#ptsGold)"
              stroke="#E8A800"
              stroke-width="1.1"
              stroke-linejoin="round"
            />
          </svg>
          <svg viewBox="0 0 24 24" class="spark">
            <path d="M12 3 13.4 9.6 20 11l-6.6 1.4L12 19l-1.4-6.6L4 11l6.6-1.4z" fill="#FFFFFF" />
          </svg>
        </span>
        <b>{{ progress.balance }}</b>
      </RouterLink>
    </header>
  </div>
</template>
