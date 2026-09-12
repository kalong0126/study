<script setup lang="ts">
/**
 * 田字格手写板（双层 Canvas）
 *
 * 对外只暴露 getStrokes / setStrokes / clear / resize，
 * 笔迹在内部是归一化坐标，换尺寸、旋转屏幕都不会丢。
 */
import { onMounted, ref, watch } from "vue";
import { useHandCanvas, type Stroke } from "@/composables/useHandCanvas";

const props = withDefaults(defineProps<{ active?: boolean; label?: string }>(), { active: true, label: "手写区域" });

const square = ref<HTMLDivElement | null>(null);
const grid = ref<HTMLCanvasElement | null>(null);
const ink = ref<HTMLCanvasElement | null>(null);

const canvas = useHandCanvas(() => {
  if (!square.value || !grid.value || !ink.value) return null;
  return { square: square.value, grid: grid.value, ink: ink.value };
});

onMounted(() => {
  canvas.start();
  // 从「视图不可见」切回来时宽度才有值，这里补一次
  window.setTimeout(() => canvas.refresh(), 60);
});

watch(
  () => props.active,
  (on) => {
    if (on) {
      canvas.refresh();
      window.setTimeout(() => canvas.refresh(), 60);
    }
  },
);

/** 容器尺寸变化（旋转屏幕 / 侧栏展开）后重绘 */
function resize(): void {
  canvas.refresh();
}

function getStrokes(): Stroke[] {
  return canvas.strokes.value;
}

function setStrokes(strokes: Stroke[]): void {
  canvas.load(strokes);
}

function clear(): void {
  canvas.clear();
}

defineExpose({ getStrokes, setStrokes, clear, resize, isEmpty: canvas.isEmpty });
</script>

<template>
  <div class="hw-board">
    <div ref="square" class="hw-sq">
      <canvas ref="grid" class="hw-grid" aria-hidden="true"></canvas>
      <canvas ref="ink" class="hw-ink" :aria-label="label"></canvas>
    </div>
  </div>
</template>
