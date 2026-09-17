<script setup lang="ts">
/**
 * 口令门
 *
 * 只在「后端开了鉴权 + 这次请求被当成公网 + 没登录」时出现。是个低频界面，
 * 但必须是**孩子能自己搞定**的界面：平板上按数字、按错了看得懂、被锁了知道等多久。
 *
 * 满 8 位自动提交 —— 省掉「再找一个确定按钮」这一步，口令长度和 config.yaml 的
 * childPin 一致（8 位数字）。
 */
import { computed, ref } from "vue";
import { api, describeApiError } from "@/api";
import type { LoginResult } from "@/api/types";

withDefaults(defineProps<{ hint?: string }>(), { hint: "" });
const emit = defineEmits<{ (e: "unlocked", status: LoginResult): void }>();

const PIN_LEN = 8;

const pin = ref("");
const busy = ref(false);
const error = ref("");

const dots = computed(() => Array.from({ length: PIN_LEN }, (_, i) => i < pin.value.length));

function press(d: string): void {
  if (busy.value || pin.value.length >= PIN_LEN) return;
  error.value = "";
  pin.value += d;
  if (pin.value.length === PIN_LEN) void submit();
}

function backspace(): void {
  if (busy.value) return;
  pin.value = pin.value.slice(0, -1);
}

async function submit(): Promise<void> {
  if (busy.value) return;
  if (!pin.value) {
    error.value = "请先输入口令";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const r = await api.authLogin(pin.value);
    emit("unlocked", r);
  } catch (e) {
    // 后端的文案已经说得很具体（还剩几次 / 等多久 / 只能在家里用），直接照搬
    error.value = describeApiError(e);
    pin.value = "";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="lk">
    <section class="card lk-card">
      <h1 class="lk-title">请输入口令</h1>
      <p class="lk-sub">{{ hint || "在外网使用，需要先输入口令" }}</p>

      <div class="lk-dots" :class="{ bad: !!error }">
        <span v-for="(on, i) in dots" :key="i" :class="{ on }"></span>
      </div>

      <p class="lk-msg" :class="{ err: !!error }">{{ error || " " }}</p>

      <div class="lk-pad">
        <button
          v-for="d in ['1', '2', '3', '4', '5', '6', '7', '8', '9']"
          :key="d"
          class="lk-key"
          type="button"
          :disabled="busy"
          @click="press(d)"
        >
          {{ d }}
        </button>
        <button class="lk-key alt" type="button" :disabled="busy || !pin" @click="backspace()">删除</button>
        <button class="lk-key" type="button" :disabled="busy" @click="press('0')">0</button>
        <button class="lk-key go" type="button" :disabled="busy || !pin" @click="submit()">
          {{ busy ? "…" : "进入" }}
        </button>
      </div>

      <p class="lk-foot">口令由家长设置。一直进不去，请让家长检查服务端的 childPin。</p>
    </section>
  </div>
</template>

<style scoped>
.lk {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
}
.lk-card {
  width: 100%;
  max-width: 360px;
  padding: 24px 18px 18px;
  text-align: center;
}
.lk-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--ink);
}
.lk-sub {
  margin: 6px 0 18px;
  font-size: 13px;
  color: var(--ink2);
}
.lk-dots {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-bottom: 10px;
}
.lk-dots span {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--line);
  transition: background 0.15s;
}
.lk-dots span.on {
  background: var(--purple-d);
}
.lk-dots.bad span.on {
  background: var(--red);
}
.lk-msg {
  height: 20px;
  margin: 0 0 12px;
  font-size: 13px;
  color: transparent;
}
.lk-msg.err {
  color: var(--red-d);
}
.lk-pad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.lk-key {
  height: 54px;
  border: none;
  border-radius: 14px;
  background: #fff;
  box-shadow: var(--shadow-s);
  font-size: 21px;
  font-weight: 700;
  color: var(--ink);
  cursor: pointer;
  transition: transform 0.08s;
}
.lk-key:active:not(:disabled) {
  transform: scale(0.96);
}
.lk-key:disabled {
  opacity: 0.45;
  cursor: default;
}
.lk-key.alt {
  font-size: 15px;
  font-weight: 500;
  color: var(--ink2);
}
.lk-key.go {
  background: var(--purple-d);
  color: #fff;
  font-size: 16px;
}
.lk-foot {
  margin: 16px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink3);
}
</style>
