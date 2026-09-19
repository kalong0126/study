<script setup lang="ts">
/**
 * 详情页统一工具栏
 *
 * 2026-09-19 用户给的规则：
 *   ① 全局顶栏 ≈64px（见 AppHeader / .hd），详情页工具栏 ≈52–56px；
 *   ② 标题、题量、章节、状态、操作**合并成同一行**；备注改成信息图标，不再单占一行；
 *   ③ 每页只保留一个主操作按钮，其余用轻量按钮或图标。
 *
 * 于是每一页的头部都写成这一条，插槽位置也固定（顺序＝从左到右）：
 *   `#head`  标题右边那一小块（浅色小胶囊，例如「自动注音 · 读过不重复」）
 *   `#mid`   中段控件（章节下拉、`.seg` 分段切换、状态 + 进度条）
 *   `#default` 右段操作（主按钮在前，轻量按钮/图标在后）
 *   `#note` / note 属性  备注 → 最右侧的 ⓘ 浮层
 *
 * ⚠️ 别再往页面里另写一排「标题 + 副标题 + 一行说明」——那正是这次要消掉的东西。
 * ⚠️ `note` 里的换行会原样显示（CSS `white-space: pre-line`），
 *   所以直接写多行字符串即可，不要手动拼 `<br>`。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "@/components/Icon.vue";

const props = withDefaults(
  defineProps<{
    /** 图标名（Icon.vue 的键名） */
    icon: string;
    /**
     * 标题。要分两段（「语文乐园 / 课文听写」那种）就改用 `#title` 插槽，这时不传也行；
     * 两者都空会渲染出一个没有标题的空工具栏，别这么用。
     */
    title?: string;
    /** 图标底色的浅色块 */
    tint?: string;
    /** 图标本身的颜色 */
    color?: string;
    /** 标题右边那行小字（题量 / 章节 / 规则…） */
    meta?: string;
    /** 备注：非空时最右侧出现 ⓘ，点开就是这段文字 */
    note?: string;
  }>(),
  { title: "", tint: "#EEF4FA", color: "#4FA3DC", meta: "", note: "" },
);

const open = ref(false);
const root = ref<HTMLElement | null>(null);

/** 点到别处就收起 —— 浮层不能一直挂在页面上挡着内容 */
function onDocDown(e: PointerEvent): void {
  if (!open.value) return;
  const el = root.value;
  if (el && e.target instanceof Node && el.contains(e.target)) return;
  open.value = false;
}

onMounted(() => document.addEventListener("pointerdown", onDocDown));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocDown));
</script>

<template>
  <div class="pt">
    <span class="pt-ico" :style="{ background: props.tint, color: props.color }" aria-hidden="true">
      <Icon :name="props.icon" :size="20" />
    </span>

    <div class="pt-head">
      <h2 class="pt-title"><slot name="title">{{ props.title }}</slot></h2>
      <template v-if="props.meta">
        <span class="pt-sep" aria-hidden="true"></span>
        <span class="pt-meta">{{ props.meta }}</span>
      </template>
      <slot name="head"></slot>
    </div>

    <div v-if="$slots.mid" class="pt-mid"><slot name="mid"></slot></div>

    <span class="pt-sp"></span>

    <div class="pt-act"><slot></slot></div>

    <span v-if="props.note || $slots.note" ref="root" class="pt-note">
      <button
        class="pt-info"
        type="button"
        aria-label="查看说明"
        :aria-expanded="open"
        @click="open = !open"
      >
        <Icon name="info" :size="18" :stroke="2.2" />
      </button>
      <div v-if="open" class="pt-pop" role="note">
        <slot name="note">{{ props.note }}</slot>
      </div>
    </span>
  </div>
</template>
