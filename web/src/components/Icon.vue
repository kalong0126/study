<script setup lang="ts">
/**
 * 内联 SVG 图标集（保持单文件版的「手写 SVG、不引图标库」规范）。
 * 全部为线条风格（stroke），需要实心的图标在各自组件里单独写。
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    name: string;
    size?: number | string;
    stroke?: number;
  }>(),
  { size: 20, stroke: 2 },
);

const ICONS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M9.5 20v-5.5h5V20"/>',
  math: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M8 8.5h8M8 12h2.5M13.5 12H16M8 15.5h2.5M13.5 15.5H16"/>',
  chinese: '<path d="M4 5.5h7v13H4zM13 5.5h7v13h-7z"/><path d="M6.5 9h2M6.5 12h2M15.5 9h2M15.5 12h2"/>',
  story: '<path d="M4 5.5A2 2 0 0 1 6 3.5h5.5v17H6a2 2 0 0 0-2 2z"/><path d="M20 5.5a2 2 0 0 0-2-2h-5.5v17H18a2 2 0 0 1 2 2z"/>',
  wrong: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v3.6M12 16.4v.1"/>',
  gear: '<circle cx="12" cy="12" r="3.1"/><path d="M12 2.6v2M12 19.4v2M4.2 7.5l1.7 1M18.1 15.5l1.7 1M4.2 16.5l1.7-1M18.1 8.5l1.7-1"/>',
  pen: '<path d="M4 20.5h16"/><path d="M15 4.2 19.8 9 9.6 19.2 4.8 20.2l1-4.8z"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>',
  speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>',
  speakerLoud: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>',
  check: '<path d="M5 12.5 10 17.5 19 6.5"/>',
  cross: '<path d="M7 7l10 10M17 7 7 17"/>',
  chevDown: '<path d="M6 9.5 12 15.5 18 9.5"/>',
  chevRight: '<path d="M9.5 6 15.5 12 9.5 18"/>',
  arrowRight: '<path d="M5 12h13M12.5 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H6M11.5 6l-6 6 6 6"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M8 7l.8 12h6.4L16 7"/>',
  download: '<path d="M12 3.5v11M7.5 10 12 14.5 16.5 10"/><path d="M4 18.5h16"/>',
  upload: '<path d="M12 14.5v-11M7.5 8 12 3.5 16.5 8"/><path d="M4 18.5h16"/>',
  sparkle: '<path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5L4.5 11 10 9z"/>',
  star: '<path d="M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.4 9.9l6-.9z"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.6 3.2 8.4 7.5 9.4 4.3-1 7.5-4.8 7.5-9.4V6z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21M11 8v6M11 16.5v.1"/>',
  sun: '<path d="M12 3.5v2M12 18.5v2M4.2 12h2M17.8 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4"/><circle cx="12" cy="12" r="3.4"/>',
  bolt: '<path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z"/>',
  calendar: '<path d="M4 6h16v13.5H4z"/><path d="M8 3.5v5M16 3.5v5M4 10.5h16"/>',
  clock: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.8M9.5 3.5h5"/>',
  list: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/><circle cx="8.5" cy="6.5" r="1.6"/><circle cx="14.5" cy="12" r="1.6"/><circle cx="8" cy="17.5" r="1.6"/>',
  folder: '<path d="M3.5 6.5A2 2 0 0 1 5.5 4.5h3.7l2 2.4h7.3a2 2 0 0 1 2 2v8.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  server: '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7 7.2v.1M7 16.7v.1"/>',
  cloud: '<path d="M6.5 18.5h11a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.3 3.6 3.6 0 0 0-.8 6.7z"/>',
  db: '<ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  wand: '<path d="M4 20.5h16"/><path d="M15 4.2 19.8 9 9.6 19.2 4.8 20.2l1-4.8z"/>',
  eye: '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/><path d="M5.5 15.5h-.5a1.5 1.5 0 0 1-1.5-1.5V5.5A1.5 1.5 0 0 1 5 4h9a1.5 1.5 0 0 1 1.5 1.5v.5"/>',
  eraser: '<path d="M6 6.5h12v11H6z"/><path d="M9.5 6.5V4h5v2.5"/>',
  grid4: '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="2"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="2"/><rect x="13" y="13" width="7.5" height="7.5" rx="2"/>',
  back: '<path d="M19 12H6M11.5 6l-6 6 6 6"/>',
  save: '<path d="M5 4.5h11L19.5 8v11.5H5z"/><path d="M8.5 4.5v5h7v-5M8.5 19.5v-5.5h7v5.5"/>',
};

const inner = computed(() => ICONS[props.name] ?? "");
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="props.stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    :width="props.size"
    :height="props.size"
    aria-hidden="true"
    v-html="inner"
  />
</template>
