<script setup lang="ts">
/**
 * 特效层：彩带画布 + 轻提示 + 庆祝横幅。
 * 放在 App 根部，任何页面触发的庆祝都能覆盖全屏。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { attachConfetti, resizeConfetti } from "@/composables/useConfetti";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();
const canvas = ref<HTMLCanvasElement | null>(null);

function onResize(): void {
  resizeConfetti();
}

onMounted(() => {
  attachConfetti(canvas.value);
  window.addEventListener("resize", onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  attachConfetti(null);
});
</script>

<template>
  <canvas ref="canvas" id="fxCanvas" aria-hidden="true"></canvas>

  <div id="toast" :class="{ on: ui.toastOn }">{{ ui.toastText }}</div>

  <div class="banner" :class="{ on: ui.bannerOn, gold: ui.bannerGold }" aria-hidden="true">
    <div class="b-t">{{ ui.bannerTitle }}</div>
    <div class="b-s">{{ ui.bannerSub }}</div>
  </div>
</template>
