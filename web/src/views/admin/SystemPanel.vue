<script setup lang="ts">
/**
 * 系统与数据：服务状态 / 备份 / 音色 / 诊断入口
 *
 * 配置本身在服务器的 config.yaml 里，这一页只用来「看状态、备数据、查问题」。
 */
import { onMounted, ref } from "vue";
import { adminApi, api, describeApiError } from "@/api";
import type { HealthInfo } from "@/api/types";
import Icon from "@/components/Icon.vue";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();

const health = ref<HealthInfo | null>(null);
const files = ref<{ file: string; kb: number; at: string }[]>([]);
const voices = ref<{ name: string; gender: string }[]>([]);
const busy = ref("");
const importInput = ref<HTMLInputElement | null>(null);

async function loadHealth(): Promise<void> {
  try {
    health.value = await api.health();
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

async function loadFiles(): Promise<void> {
  try {
    files.value = await api.backupList();
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

onMounted(() => {
  void loadHealth();
  void loadFiles();
});

async function runBackup(): Promise<void> {
  busy.value = "backup";
  try {
    const r = await api.runBackup();
    await loadFiles();
    ui.toast(`备份完成：${r.file}（${r.kb} KB）`);
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}

function download(): void {
  const a = document.createElement("a");
  a.href = api.backupUrl();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  ui.toast("正在下载全量备份 JSON");
}

function pickImport(): void {
  importInput.value?.click();
}

async function onImport(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const replace = window.confirm(
    "要把这份备份恢复进数据库。\n\n点「确定」= 合并（已存在的跳过，推荐）\n点「取消」= 覆盖（先清空再导入，谨慎）",
  );
  busy.value = "import";
  try {
    const text = await file.text();
    const pack = JSON.parse(text) as unknown;
    const summary = await api.restore(pack, replace ? "replace" : "merge", true);
    await loadHealth();
    await loadFiles();
    ui.toast(`恢复完成：${JSON.stringify(summary)}`);
  } catch (err) {
    ui.toast(`恢复失败：${err instanceof Error ? err.message : describeApiError(err)}`);
  } finally {
    busy.value = "";
  }
}

async function loadVoices(): Promise<void> {
  busy.value = "voices";
  try {
    voices.value = await adminApi.voices();
    ui.toast(`拿到 ${voices.value.length} 个中文音色`);
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}

/* ---------------------------------------------------------------- 重置 */

/**
 * 重置「今天」的学习数据。
 * 清：今天的 daily 任务打勾、今天的口算题组与计时、今天的 review 目标与已挑战数。
 * 不动：历史日期、错题本、故事、已读标题、课文/生字/掌握度。
 */
async function resetToday(): Promise<void> {
  if (
    !window.confirm(
      "确认要重置【今天】的学习进度吗？\n\n" +
        "会清掉：今天的任务打勾（口算/听写/阅读/复习）、今天的口算题组与计时、今天的复习目标。\n" +
        "不会动：错题本、历史日期、故事、课文与生字、掌握度。",
    )
  )
    return;
  busy.value = "reset-today";
  try {
    const r = await adminApi.reset("today");
    const msg =
      `今日已重置：任务 ${r.removed.daily} 行、口算 ${r.removed.math} 题组、KV ${r.removed.kv} 条（${r.date}）`;
    ui.toast(msg);
    void loadHealth();
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}

/**
 * 重置【全部】学习数据 —— 比 today 激进得多，会清掉错题本 / 故事 / 已读标题 / 判卷留痕 / 全部 KV。
 * 保留：课文 / 生字 / 掌握度 / 账号本身。
 * 双确认（confirm + prompt 输入"重置"），防误点。
 */
async function resetAll(): Promise<void> {
  if (
    !window.confirm(
      "⚠️ 高危操作：清空【全部】学习数据？\n\n" +
        "会清掉：错题本（数学 + 语文）、历史口算题组、童话故事、已读标题、判卷记录、全部 KV。\n" +
        "保留：课文与生字（用「重新导入内置课文」管）、掌握度（已掌握 / 未掌握标记）、账号。\n\n" +
        "继续吗？",
    )
  )
    return;
  const typed = window.prompt('确认要执行，请输入 "重置" 然后点确定：', "");
  if (typed !== "重置") {
    ui.toast(typed === null ? "已取消" : "输入不对，已取消");
    return;
  }
  busy.value = "reset-all";
  try {
    const r = await adminApi.reset("all");
    const rm = r.removed;
    ui.toast(
      `已清空：日常 ${rm.daily} / 口算 ${rm.math} / 错题 ${rm.wrong ?? 0} / 故事 ${rm.stories ?? 0} / 已读 ${rm.reads ?? 0} / 判卷 ${rm.marks ?? 0} / KV ${rm.kv}`,
    );
    void loadHealth();
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #EAF3FB; color: var(--blue-d)"><Icon name="server" :size="19" /></span>
      <div><h2>服务状态</h2><span class="sub">配置都在服务器的 config/config.yaml 里</span></div>
      <div class="spacer"></div>
      <button class="btn ghost sm" type="button" @click="loadHealth()"><Icon name="refresh" :size="16" />刷新</button>
      <button class="btn primary sm" type="button" @click="ui.openDiag()"><Icon name="search" :size="16" />打开运行诊断</button>
    </div>

    <div v-if="!health" class="loading-card">正在读取…</div>
    <template v-else>
      <div class="grid2">
        <div class="field">
          <label>数据库</label>
          <div class="badge-lite">驱动 {{ health.db.driver }}</div>
          <div style="margin-top: 6px; font-size: 13px; color: var(--ink2)">
            {{ health.db.lessons }} 篇课文 · {{ health.db.chars }} 个生字
          </div>
        </div>
        <div class="field">
          <label>语音合成</label>
          <div class="badge-lite">{{ health.tts.provider }} · {{ health.tts.voice }} · {{ health.tts.rate }}</div>
          <div style="margin-top: 6px; font-size: 13px; color: var(--ink2)">
            已缓存 {{ health.tts.cacheCount }} 个文件 · {{ Math.round((health.tts.cacheBytes / 1024 / 1024) * 10) / 10 }} MB
          </div>
        </div>
        <div class="field">
          <label>故事模型</label>
          <div class="badge-lite">{{ health.llm.storyModel || "未配置" }}</div>
        </div>
        <div class="field">
          <label>判卷模型（需支持看图）</label>
          <div class="badge-lite" :class="health.llm.markModel ? 'ok' : 'err'">{{ health.llm.markModel || "未配置 —— 手写判卷不可用" }}</div>
        </div>
      </div>

      <div class="field">
        <label>接口地址</label>
        <div class="badge-lite">{{ health.llm.chatUrl }}</div>
        <div style="margin-top: 6px; font-size: 12.5px; color: var(--ink3)">API Key：{{ health.llm.apiKey || "未配置" }}</div>
      </div>

      <div v-for="(w, i) in health.warnings" :key="i" class="tip" style="border-left-color: var(--yellow-d)">⚠️ {{ w }}</div>
    </template>
  </section>

  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #E9FBF3; color: var(--green-d)"><Icon name="db" :size="19" /></span>
      <div>
        <h2>数据安全</h2>
        <span class="sub">数据都在这台服务器的数据库里，服务器坏了就全没了 —— 建议每周导出一次到别的介质</span>
      </div>
      <div class="spacer"></div>
      <button class="btn ghost sm" type="button" @click="loadFiles()"><Icon name="refresh" :size="16" />刷新</button>
      <button class="btn primary sm" type="button" :disabled="busy === 'backup'" @click="runBackup()">
        <Icon name="save" :size="16" />立即备份
      </button>
      <button class="btn ghost sm" type="button" @click="download()"><Icon name="download" :size="16" />下载全量 JSON</button>
      <button class="btn ghost sm" type="button" :disabled="busy === 'import'" @click="pickImport()">
        <Icon name="upload" :size="16" />导入恢复
      </button>
      <input ref="importInput" type="file" accept=".json,application/json" style="display: none" @change="onImport" />
    </div>

    <div v-if="!files.length" class="wb-empty">还没有备份文件。服务每天凌晨会自动备份一次，也可以点「立即备份」。</div>
    <div v-for="f in files" :key="f.file" class="lesson-row">
      <div class="l-main">
        <div class="l-t" style="font-family: ui-monospace, monospace; font-size: 13.5px">{{ f.file }}</div>
        <div class="l-u">{{ String(f.at).replace("T", " ").slice(0, 19) }}</div>
      </div>
      <span class="badge-lite">{{ f.kb }} KB</span>
    </div>

    <div class="reset-row">
      <div class="rr-text">
        <b>重置学习数据</b>
        <span class="rr-sub">
          「重置今日」只清今天进度（推荐日常测试用）；「清空全部」会抹掉错题本 / 故事 / 历史（高危，确认弹窗要输入"重置"才能继续）。
        </span>
      </div>
      <div class="rr-btns">
        <button class="btn danger sm" type="button" :disabled="busy !== ''" @click="resetToday()">
          <Icon name="refresh" :size="16" />{{ busy === "reset-today" ? "重置中…" : "重置今日" }}
        </button>
        <button class="btn danger sm" type="button" :disabled="busy !== ''" @click="resetAll()">
          <Icon name="trash" :size="16" />{{ busy === "reset-all" ? "清空中…" : "清空全部" }}
        </button>
      </div>
    </div>

    <p class="tip">
      <b>导入恢复</b>支持两种文件：本服务导出的备份，以及<b>老版单文件网页</b>导出的 JSON（会跳过其中的示例数据）。<br />
      每天凌晨按 <code>backup.cron</code> 自动备份，保留 30 天；建议把备份目录挂到服务器之外的介质
      （NAS / 移动硬盘 / 云盘同步目录）。<br />
      这一整块（备份 / 导出 / 导入 / 诊断）<b>只在家长后台出现</b>，孩子端不会显示，避免误点。
    </p>
  </section>

  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #F3EFFF; color: var(--purple-d)"><Icon name="speakerLoud" :size="19" /></span>
      <div>
        <h2>可选音色</h2>
        <span class="sub">列出 Edge TTS 的中文音色，把中意的名字填到 config.yaml 的 tts.voice</span>
      </div>
      <div class="spacer"></div>
      <button class="btn ghost sm" type="button" :disabled="busy === 'voices'" @click="loadVoices()">
        <Icon name="cloud" :size="16" />拉取音色列表
      </button>
    </div>

    <div v-if="voices.length" class="chip-list">
      <span v-for="v in voices" :key="v.name" class="chip">
        {{ v.name }}
        <span class="c-w">{{ v.gender }}</span>
      </span>
    </div>
    <p class="tip">
      推荐 <code>zh-CN-XiaoyiNeural</code>（女声、亲切）或 <code>zh-CN-YunxiNeural</code>（男声）。
      改完 config.yaml 重启后端生效；<b>改了音色之后记得清一次语音缓存</b>，否则还是旧音色。
    </p>
  </section>
</template>
