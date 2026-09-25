<script setup lang="ts">
/**
 * 只读诊断抽屉
 *
 * 家长排查「怎么连不上大模型 / 语音怎么不出声」的入口。
 * 配置和密钥都在后端，所以这里只读日志、跑连接自检，不给任何写配置的能力。
 */
import { computed, onUnmounted, ref, watch } from "vue";
import { api, describeApiError } from "@/api";
import type { DiagCheck, LogRow } from "@/api/types";
import Icon from "@/components/Icon.vue";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();

const logs = ref<LogRow[]>([]);
const checks = ref<DiagCheck[]>([]);
const warnings = ref<string[]>([]);
const summarized = ref("");
const busy = ref("");
const expanded = ref(false);
const openRow = ref<number | null>(null);
const levelFilter = ref("");

const levelClass = (lv: string): string => {
  const l = (lv || "").toLowerCase();
  if (l === "error" || l === "fatal") return "err";
  if (l === "warn") return "warn";
  if (l === "info") return "info";
  return "ok";
};

const shown = computed(() => (levelFilter.value ? logs.value.filter((l) => (l.level || "").toLowerCase() === levelFilter.value) : logs.value));

const timeOf = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

async function load(): Promise<void> {
  try {
    const r = await api.logs(200);
    logs.value = r.logs.slice().reverse();
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

async function runDiag(): Promise<void> {
  busy.value = "diag";
  try {
    const r = await api.diagLlm();
    checks.value = r.checks;
    warnings.value = r.warnings ?? [];
    ui.toast(r.checks.every((c) => c.ok) ? "自检通过，链路正常" : "自检发现问题，请看下面的检查项");
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
    void load();
  }
}

async function testLlm(): Promise<void> {
  busy.value = "story";
  try {
    const r = await api.diagLlmTest("story");
    summarized.value = `大模型 故事模型（${r.model}）调用成功，${r.ms}ms，回复「${r.reply}」`;
    ui.toast("大模型调用成功");
  } catch (e) {
    summarized.value = describeApiError(e);
    ui.toast("大模型调用失败");
  } finally {
    busy.value = "";
    void load();
  }
}

async function testTts(): Promise<void> {
  busy.value = "tts";
  try {
    const r = await api.diagTtsTest();
    summarized.value = `语音合成成功：${r.bytes} 字节，${r.ms}ms${r.cached ? "（命中缓存）" : ""}`;
    ui.toast("语音合成可用");
  } catch (e) {
    summarized.value = describeApiError(e);
    ui.toast("语音合成失败");
  } finally {
    busy.value = "";
    void load();
  }
}

async function clearAll(): Promise<void> {
  try {
    await api.clearLogs();
    logs.value = [];
    checks.value = [];
    summarized.value = "";
    ui.toast("日志已清空");
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

function copyLogs(): void {
  const text = logs.value.map((l) => l.text).join("\n");
  void navigator.clipboard
    .writeText(text)
    .then(() => ui.toast("日志已复制到剪贴板"))
    .catch(() => ui.toast("复制失败，请手动选择文本"));
}

/* 抽屉打开时每 4 秒自动刷新一次日志，关上就停 */
let pollTimer: number | null = null;

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

watch(
  () => ui.diagOpen,
  (open) => {
    stopPoll();
    if (open) {
      void load();
      pollTimer = window.setInterval(() => void load(), 4000);
    }
  },
  { immediate: true },
);

onUnmounted(stopPoll);
</script>

<template>
  <div v-if="ui.diagOpen" class="drawer-mask" @click="ui.closeDiag()"></div>
  <aside v-if="ui.diagOpen" class="drawer" role="dialog" aria-label="运行诊断">
    <div class="drawer-hd">
      <span class="ico" style="background: #EAF3FB; color: var(--blue-d); width: 32px; height: 32px; border-radius: 11px; display: flex; align-items: center; justify-content: center">
        <Icon name="search" :size="18" />
      </span>
      <h3>运行诊断</h3>
      <div class="spacer"></div>
      <button class="log-btn" type="button" @click="ui.closeDiag()"><Icon name="cross" :size="14" /> 关闭</button>
    </div>

    <div class="drawer-body">
      <div class="row" style="gap: 8px">
        <button class="btn sm ghost" type="button" :disabled="busy !== ''" @click="runDiag()">网络自检</button>
        <button class="btn sm ghost" type="button" :disabled="busy !== ''" @click="testLlm()">测试故事模型</button>
        <button class="btn sm ghost" type="button" :disabled="busy !== ''" @click="testTts()">测试语音</button>
      </div>

      <div v-if="summarized" class="tip" style="border-left-color: var(--green-d)">{{ summarized }}</div>

      <div v-for="(w, i) in warnings" :key="`w${i}`" class="tip" style="border-left-color: var(--yellow-d)">⚠️ {{ w }}</div>

      <div v-if="checks.length" class="diag-checks">
        <div v-for="c in checks" :key="c.name" class="diag-check" :class="{ bad: !c.ok }">
          <span class="st">{{ c.ok ? "✓" : "!" }}</span>
          <div>
            <div class="nm">{{ c.name }}</div>
            <div class="dt2">{{ c.detail }}</div>
          </div>
        </div>
      </div>

      <div class="log-wrap">
        <div class="log-hd">
          <span class="lt">运行日志 <span class="badge-lite">{{ logs.length }} 条</span></span>
          <button class="log-btn" type="button" @click="expanded = !expanded">{{ expanded ? "收起" : "展开" }}</button>
          <button class="log-btn" type="button" @click="copyLogs()">复制</button>
          <button class="log-btn" type="button" @click="clearAll()">清空</button>
        </div>
        <div class="log-hd" style="border-bottom: none; padding-top: 8px">
          <button
            v-for="lv in ['', 'info', 'warn', 'error']"
            :key="lv || 'all'"
            class="log-btn"
            :style="levelFilter === lv ? 'border-color:#7CC4EF;color:var(--blue-d)' : ''"
            type="button"
            @click="levelFilter = lv"
          >
            {{ lv === "" ? "全部" : lv === "error" ? "错误" : lv === "warn" ? "警告" : "普通" }}
          </button>
        </div>
        <div class="log-list" :class="{ expanded }">
          <div v-if="!shown.length" class="log-empty">暂无日志。点上面的「测试故事模型」或「测试语音」，这里就会出现请求记录。</div>
          <div
            v-for="(l, i) in shown"
            :key="`${l.ts}-${i}`"
            class="log-row"
            :class="[levelClass(l.level), { open: openRow === i }]"
            @click="openRow = openRow === i ? null : i"
          >
            <span class="dt"></span>
            <span class="tm">{{ timeOf(l.ts) }}</span>
            <span class="mod">{{ l.mod }}</span>
            <span class="tx">
              {{ l.msg }}
              <span v-if="Object.keys(l.fields || {}).length" class="dts">{{ JSON.stringify(l.fields, null, 2) }}</span>
            </span>
          </div>
        </div>
      </div>

      <p class="tip">
        <b>连不上怎么办：</b>先点「网络自检」，它会告诉你是<b>网络不通</b>、<b>密钥不对</b>还是<b>地址/模型名写错</b>。
        这些配置都在服务器的 <code>config/config.yaml</code> 里，改完重启后端即可。
      </p>
    </div>

    <div class="drawer-foot">
      <button class="btn sm ghost" type="button" @click="load()"><Icon name="refresh" :size="15" /> 刷新日志</button>
      <span style="font-size: 12.5px; color: var(--ink3); align-self: center">日志每 4 秒自动刷新</span>
    </div>
  </aside>
</template>
