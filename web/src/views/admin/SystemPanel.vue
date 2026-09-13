<script setup lang="ts">
/**
 * 系统与数据：服务状态 / 备份 / 音色 / 诊断入口
 *
 * 配置本身在服务器的 config.yaml 里，这一页只用来「看状态、备数据、查问题」。
 */
import { onMounted, ref } from "vue";
import { adminApi, api, describeApiError } from "@/api";
import type { HealthInfo, Redemption } from "@/api/types";
import Icon from "@/components/Icon.vue";
import { clearAudioCache } from "@/composables/useAudio";
import { rewardLabel } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();

const health = ref<HealthInfo | null>(null);
const files = ref<{ file: string; kb: number; at: string }[]>([]);
const voices = ref<{ name: string; gender: string }[]>([]);
/** 当前生效音色（health.tts.voice 初始，拉取列表 / 切换后更新） */
const currentVoice = ref("");
/** 正在试听的音色名（用于喇叭按钮切「停止」图标） */
const previewPlaying = ref("");
const busy = ref("");
const importInput = ref<HTMLInputElement | null>(null);

/** 积分余额与兑换记录（家长查看孩子攒了多少分、换了什么） */
const pointsBalance = ref(0);
const redemptions = ref<Redemption[]>([]);

let previewAudio: HTMLAudioElement | null = null;

/** Edge 返回的 Gender 是英文（Female/Male），转成中文；未知值原样显示 */
function genderLabel(g: string): string {
  const m = (g || "").toLowerCase();
  if (m === "female") return "女声";
  if (m === "male") return "男声";
  return g || "—";
}

async function loadHealth(): Promise<void> {
  try {
    health.value = await api.health();
    if (health.value?.tts?.voice) currentVoice.value = health.value.tts.voice;
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

async function loadPoints(): Promise<void> {
  try {
    const r = await api.listPoints();
    pointsBalance.value = r.balance;
    redemptions.value = r.redemptions;
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

onMounted(() => {
  void loadHealth();
  void loadFiles();
  void loadPoints();
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
    const r = await adminApi.voices();
    voices.value = r.voices;
    currentVoice.value = r.current ?? "";
    ui.toast(`拿到 ${voices.value.length} 个中文音色`);
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}

/** 试听某个音色：用该音色现合成一句示例朗读；再点一次停止 */
function previewVoice(name: string): void {
  if (previewPlaying.value === name) {
    previewAudio?.pause();
    previewAudio = null;
    previewPlaying.value = "";
    return;
  }
  previewAudio?.pause();
  const a = new Audio(api.ttsPreviewUrl(name));
  previewAudio = a;
  previewPlaying.value = name;
  const stop = (): void => {
    if (previewPlaying.value === name) previewPlaying.value = "";
  };
  a.onended = stop;
  a.onerror = (): void => {
    stop();
    ui.toast(`试听失败：${name} 可能不可用`);
  };
  void a.play().catch(() => {
    stop();
    ui.toast(`试听失败：${name}`);
  });
}

/** 使用某个音色：选中即生效，并作废前端缓存的旧音色音频 */
async function applyVoice(name: string): Promise<void> {
  busy.value = "voice-apply";
  try {
    await adminApi.setVoice(name);
    currentVoice.value = name;
    clearAudioCache();
    ui.toast(`已切换到 ${name}，孩子端刷新即生效`);
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}

/* ---------------------------------------------------------------- 重置 */

/**
 * 重置「今天」的学习数据。
 * 清：今天的 daily 任务打勾、今天的口算题组与计时、今天的 review 目标与已挑战数、
 *     今天新写的掌握度（生字 ✓/✗ 标记）、今天新进错题本的错题。
 * 不动：历史日期、历史错题、故事、已读标题、课文与生字、历史掌握度、全部兑换记录。
 */
async function resetToday(): Promise<void> {
  if (
    !window.confirm(
      "确认要重置【今天】的学习进度吗？\n\n" +
        "会清掉：今天的任务打勾（口算/听写/阅读/复习）、今天的口算题组与计时、今天的复习目标、" +
        "今天新打的生字掌握度（按 ✓/✗）、今天新进错题本的错题。\n" +
        "不会动：历史错题、历史日期、故事、课文与生字、历史掌握度、兑换记录。",
    )
  )
    return;
  busy.value = "reset-today";
  try {
    const r = await adminApi.reset("today");
    const rm = r.removed as {
      daily?: number;
      math?: number;
      mastery?: number;
      wrong?: number;
      kv?: number;
      points?: number;
    };
    const msg =
      `今日已重置：任务 ${rm.daily ?? 0} 行、口算 ${rm.math ?? 0} 题组、掌握度 ${rm.mastery ?? 0} 字、` +
      `错题 ${rm.wrong ?? 0} 条、KV ${rm.kv ?? 0} 条（${r.date}）`;
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
        <span class="sub">点「试听」听一句样例，点「使用」立即切换朗读音色</span>
      </div>
      <div class="spacer"></div>
      <button class="btn ghost sm" type="button" :disabled="busy === 'voices'" @click="loadVoices()">
        <Icon name="cloud" :size="16" />拉取音色列表
      </button>
    </div>

    <div v-if="currentVoice" class="badge-lite" style="margin-bottom: 10px">
      当前音色：<b style="font-family: ui-monospace, monospace">{{ currentVoice }}</b>
    </div>

    <div v-if="voices.length" class="voice-list">
      <div v-for="v in voices" :key="v.name" class="voice-row" :class="{ cur: v.name === currentVoice }">
        <button class="btn ghost sm" type="button" @click="previewVoice(v.name)">
          <Icon :name="previewPlaying === v.name ? 'stop' : 'speaker'" :size="16" />
          {{ previewPlaying === v.name ? "停止" : "试听" }}
        </button>
        <div class="v-main">
          <div class="v-name">{{ v.name }}</div>
          <div class="v-sub">{{ genderLabel(v.gender) }}</div>
        </div>
        <button
          v-if="v.name === currentVoice"
          class="btn ghost sm"
          type="button"
          disabled
          title="当前正在使用的音色"
        >
          <Icon name="check" :size="16" />当前
        </button>
        <button v-else class="btn green sm" type="button" :disabled="busy !== ''" @click="applyVoice(v.name)">
          <Icon name="check" :size="16" />使用
        </button>
      </div>
    </div>
    <div v-else class="wb-empty">还没拉取音色列表，点右上角「拉取音色列表」。</div>
    <p class="tip">
      点「试听」听一句样例（用该音色现合成），满意就点「使用」——<b>立即生效，不用改配置、不用重启</b>。
      切换后旧音色的缓存音频会自动作废，孩子端刷新页面即用新音色。推荐 <code>zh-CN-XiaoyiNeural</code>（女声、亲切）或
      <code>zh-CN-YunxiNeural</code>（男声）。
    </p>
  </section>

  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #FFF6E0; color: #C97F00"><Icon name="gift" :size="19" /></span>
      <div>
        <h2>积分与兑换</h2>
        <span class="sub">孩子当前积分余额与兑换记录（家长线下兑现）</span>
      </div>
      <div class="spacer"></div>
      <span class="pts-balance">{{ pointsBalance }}</span>
      <button class="btn ghost sm" type="button" @click="loadPoints()"><Icon name="refresh" :size="16" />刷新</button>
    </div>

    <div v-if="!redemptions.length" class="wb-empty">
      还没有兑换记录。孩子完成任务攒够 50 分，就能在首页兑换奖励。
    </div>
    <div v-else class="redeem-hist">
      <div v-for="rd in redemptions" :key="rd.id" class="rh-row">
        <span class="rh-name">{{ rewardLabel(rd.reward) }}</span>
        <span class="rh-time">{{ String(rd.createdAt).replace("T", " ").slice(0, 16) }}</span>
        <span class="badge-lite">-{{ rd.cost }} 分</span>
      </div>
    </div>
    <p class="tip">
      规则：口算 / 听写完成各 +10，全对再各 +10，阅读 +20，四项全完成再 +10。
      50 分可换「半小时平板娱乐时间」或「1 块钱」。孩子端在首页操作兑换，这里只查看记录、线下兑现。
    </p>
  </section>
</template>
