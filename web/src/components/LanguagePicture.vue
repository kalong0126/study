<script setup lang="ts">
/**
 * 看图题的配图块（语言强化 ·「看图观察」「看图说话」两题共用同一张图）。
 *
 * 三种状态：
 *   · 画好了     → 直接显示图片
 *   · 正在画     → 显示「AI 正在画这幅图」，给孩子一个等待的理由
 *   · 没画 / 失败 → 显示占位 + 「画一张」按钮（家长可以手动重试），
 *                  同时把画面文字描述交给父组件兜底展示，没图也能把题做完
 *
 * 图片是后端画好后存在自己磁盘上的，`:src` 拿的是 /api/language/image/<date>?v=<版本>，
 * 版本号随重画变化，所以浏览器不会把上一张旧图缓存给你。
 */
import type { LanguageImageInfo } from "@/api/types";
import Icon from "@/components/Icon.vue";

defineProps<{
  image: LanguageImageInfo | null;
  /** 正在画图 */
  busy: boolean;
  /** 失败原因（给家长看的具体信息） */
  error: string;
  /** 图注，例如第 8 题的「还是这幅图」 */
  caption?: string;
}>();

const emit = defineEmits<{
  (e: "redraw"): void;
  /** 图片加载失败（文件被删 / 网络抖动），父组件据此退回文字描述 */
  (e: "broken"): void;
}>();
</script>

<template>
  <div class="lg-imgwrap">
    <div v-if="caption" class="lg-imgcap">
      <Icon name="eye" :size="15" />{{ caption }}
    </div>

    <img
      v-if="image?.ready"
      class="lg-img"
      :src="image.url"
      :alt="caption || '看图题的画面'"
      @error="emit('broken')"
    />

    <div v-else class="lg-imgph">
      <template v-if="busy">
        <span class="lg-imgph-i"><Icon name="wand" :size="30" /></span>
        <b>AI 正在画这幅图…</b>
        <span class="lg-imgph-s">大约要 10 秒，等一下下～</span>
      </template>
      <template v-else>
        <span class="lg-imgph-i"><Icon name="eye" :size="30" /></span>
        <b>这幅图还没画出来</b>
        <span class="lg-imgph-s">{{ error || "点下面的按钮，让 AI 画一张。" }}</span>
        <button class="btn green sm" type="button" @click="emit('redraw')">
          <Icon name="wand" :size="16" />画一张
        </button>
      </template>
    </div>
  </div>
</template>
