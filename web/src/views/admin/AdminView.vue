<script setup lang="ts">
/**
 * 家长内容后台 · 版式
 *
 * 与孩子端完全分开：独立顶栏、独立标签页，不出现底部导航和任何孩子端的入口。
 * 内网不鉴权，靠「不把 /admin 这个网址告诉孩子」做隔离；将来要上公网再开 auth.enabled。
 */
import { onMounted, ref } from "vue";
import { api } from "@/api";
import Icon from "@/components/Icon.vue";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();
const health = ref<{ db: { driver: string; lessons: number; chars: number }; llm: { storyModel: string; markModel: string }; tts: { voice: string; cacheCount: number } } | null>(null);

onMounted(async () => {
  try {
    health.value = await api.health();
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : "读取服务状态失败");
  }
});
</script>

<template>
  <div class="topbar">
    <header class="hd">
      <RouterLink to="/" class="brand" title="回到孩子端">
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M12 3 2.5 8 12 13l9.5-5L12 3Z" fill="#fff" />
            <path d="M6 10.6V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.4l-6 3.2-6-3.2Z" fill="#fff" opacity=".78" />
          </svg>
        </span>
        <span>家长内容后台</span>
      </RouterLink>
      <div class="spacer"></div>
      <span v-if="health" class="badge-lite">数据库 {{ health.db.driver }} · 课文 {{ health.db.lessons }} 篇 · 生字 {{ health.db.chars }}</span>
      <span v-if="health" class="badge-lite">判卷模型 {{ health.llm.markModel || "未配置" }}</span>
      <RouterLink class="btn ghost sm" to="/"><Icon name="back" :size="16" />回到孩子端</RouterLink>
    </header>
  </div>

  <div class="admin-body">
    <div class="admin-tabs">
      <RouterLink to="/admin" exact-active-class="on"><Icon name="list" :size="17" />课文管理</RouterLink>
      <RouterLink to="/admin/system" active-class="on"><Icon name="server" :size="17" />系统与数据</RouterLink>
    </div>

    <RouterView />
  </div>
</template>
