<script setup lang="ts">
/**
 * 语言强化训练（AI 出题 · 9 种题型）
 *
 * 页面结构：
 *   · 九宫格（副目录）—— 9 种题型各一张卡片，显示题号 / 题型 / 交互方式 / 完成状态
 *   · 单题视图 —— 点开某一题后进入；顶部可随时回九宫格，底部可上一题 / 下一题
 *
 * 判卷分两类：
 *   · 系统自动判 —— 词语搭配（选择 / 填空）、句子排序：本地比对答案，结果写回后端
 *   · 大人来判定 —— 每日词语 / 扩句 / 病句修改 / 把话写具体 / 看图观察 / 看图说话 / 简短写作：
 *     孩子口述完成，页面上给「通过 / 再练一练」两个按钮
 *
 * 状态存在后端（按天），所以换设备、刷新页面都不丢进度。
 *
 * 与首页联动：9 道题**全做完**才算完成首页那项打卡任务（+20 分，少一道都不给），
 * 判定归后端（`routes/language.ts` 的 syncLanguageTask）——每次拿到新进度都用
 * `progress.syncLanguage()` 把它同步进 store，首页立刻就能看到变化。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api, describeApiError } from "@/api";
import type { LanguageImageInfo, LanguageProgress, LanguageQuestion, LanguageSet } from "@/api/types";
import Icon from "@/components/Icon.vue";
import LanguagePicture from "@/components/LanguagePicture.vue";
import PageTool from "@/components/PageTool.vue";
import { playText, stopAudio, useAudioState } from "@/composables/useAudio";
import { TASK_DEFS, useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();
const progressStore = useProgressStore();
const { playing } = useAudioState();

const loading = ref(true);
const generating = ref(false);
const saving = ref(false);
const loadError = ref("");

const set = ref<LanguageSet | null>(null);
const progress = ref<LanguageProgress>({});
const themes = ref<string[]>([]);

/** 看图题的配图（文生图模型画的真图，落在后端磁盘上） */
const image = ref<LanguageImageInfo | null>(null);
/** 正在画图中 */
const imgBusy = ref(false);
/** 画图失败的提示（失败时退回文字描述，题目照样能做） */
const imgError = ref("");

/**
 * 「载入时就已经 9/9」→ 不庆祝。
 *
 * 打开页面时 progress 从空变成 9 道全 done，allDone 会走一次 false→true，
 * 如果不管它，孩子每次进这一页都会被彩带和音效糊一脸（还会白建一个 AudioContext）。
 * 载入 / 换题时同步取一次快照，只吃掉「第一次」那次跳变。
 */
let quietFirstAllDone = false;

/** grid = 九宫格目录；q = 单题作答 */
const view = ref<"grid" | "q">("grid");
const idx = ref(0);

const questions = computed<LanguageQuestion[]>(() => set.value?.questions ?? []);
const q = computed<LanguageQuestion | null>(() => questions.value[idx.value] ?? null);

/**
 * 已完成几道。只数**题目数组里真实存在的题** —— 换题后残留的旧进度条目不算，
 * 否则九宫格会写出「完成 10/9」这种怪数字。
 */
const doneCount = computed(
  () => questions.value.filter((item) => progress.value[String(item.id)]?.status === "done").length,
);
const wrongCount = computed(
  () => questions.value.filter((item) => progress.value[String(item.id)]?.status === "wrong").length,
);
const allDone = computed(() => questions.value.length === 9 && doneCount.value === 9);

/* ------------------------------------------------------------ 单题草稿 */

interface Draft {
  /** 选择题所选 */
  pick: string;
  /** 填空题所填 */
  fill: string;
  /** 排序题已放入的句子下标（按点击顺序） */
  order: number[];
  /** "" 还没判；ok 判对；bad 判错 */
  result: "" | "ok" | "bad";
  /** 是否展开参考答案 */
  showRef: boolean;
}

const drafts = ref<Record<number, Draft>>({});

function d(id: number): Draft {
  const all = drafts.value;
  if (!all[id]) all[id] = { pick: "", fill: "", order: [], result: "", showRef: false };
  return all[id];
}

function statusOf(id: number): "" | "done" | "wrong" {
  return progress.value[String(id)]?.status ?? "";
}

/** 自动判卷的题做对之后锁定，避免改来改去 */
function locked(id: number): boolean {
  return statusOf(id) === "done";
}

function modeLabel(item: LanguageQuestion): string {
  if (item.mode === "choice") return "选择 · 自动判";
  if (item.mode === "fill") return "填空 · 自动判";
  if (item.mode === "order") return "排序 · 自动判";
  return "口述 · 大人判";
}

function statusText(item: LanguageQuestion): string {
  const s = statusOf(item.id);
  if (s === "done") return "已完成";
  if (s === "wrong") return "再练一练";
  return "待完成";
}

/* ------------------------------------------------------------ 载入 / 出题 */

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const r = await api.languageToday();
    set.value = r.set;
    progress.value = r.progress ?? {};
    // 必须**同步**跟在上面两行后面取快照：allDone 的 watcher 是 pre-flush 的，
    // 一旦 await 让出线程它就跑了，那时再置标记已经晚了一步（照样会庆祝）。
    quietFirstAllDone = allDone.value;
    themes.value = r.themes ?? [];
    image.value = r.image ?? null;
    imgError.value = "";
    // 打卡状态由后端算并回写，这里把它覆盖进 store —— 首页那项任务才不会和这页对不上
    progressStore.applyDaily(r.daily, r.balance);
    await progressStore.syncLanguage(r.counts?.done ?? 0, r.counts?.total ?? 0);
  } catch (e) {
    loadError.value = describeApiError(e);
  } finally {
    loading.value = false;
  }
}

async function generate(force: boolean): Promise<void> {
  if (generating.value) return;
  if (force && !window.confirm("换一套会重新出一份 9 道题，今天的作答记录会清掉。继续吗？")) return;
  generating.value = true;
  try {
    const r = await api.generateLanguage({ force });
    set.value = r.set;
    progress.value = {};
    quietFirstAllDone = false; // 换了一套新题：从头来过，全部做完时该庆祝就庆祝
    // 清掉所有单题草稿（题换了，旧草稿没意义）
    drafts.value = {};
    view.value = "grid";
    idx.value = 0;
    // 换题后场景变了，旧配图作废 —— 等孩子打开看图题时再按新场景画一张
    image.value = null;
    imgError.value = "";
    // 换一套 = 之前的作答作废 → 首页那项任务也跟着退回「待完成」（已发的分不追回）
    progressStore.applyDaily(r.daily, r.balance);
    await progressStore.syncLanguage(0, r.set.questions.length);
    ui.toast(r.cached ? `今天已经有题目了（主题：${r.set.theme}）` : `出好了！今日主题：${r.set.theme}`);
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    generating.value = false;
  }
}

/* ------------------------------------------------------------ 看图题的配图 */

/** 当前这题要不要配图（看图观察 + 复用同一场景的看图说话） */
const needImage = computed(
  () => q.value?.type === "image_observation" || q.value?.type === "image_speaking",
);

/**
 * 确保今天的图已经画好。
 *
 * 只在孩子真的打开看图题时才画（省 token / 省钱），画好之后按天缓存，
 * 刷新页面、换设备都不用重画。失败的画退回文字画面描述，题目照样能做。
 */
async function ensureImage(force = false): Promise<void> {
  if (!set.value || !needImage.value) return;
  if (!force && image.value?.ready) return;
  if (imgBusy.value) return;
  imgBusy.value = true;
  imgError.value = "";
  try {
    const r = await api.generateLanguageImage({ force });
    image.value = r.image;
    if (!r.image?.ready) imgError.value = "图片没能画出来，先用文字描述给你看～";
  } catch (e) {
    imgError.value = describeApiError(e);
  } finally {
    imgBusy.value = false;
  }
}

/** 图片加载失败（文件被删 / 网络抖动）时也不要留一个裂图 */
function onImgError(): void {
  image.value = null;
  imgError.value = "图片没加载出来，点下面按钮重新画一张。";
}

// 打开某一题时（含上一题/下一题切换）顺手把图准备好
watch([view, idx], () => {
  if (view.value === "q") void ensureImage();
});

/* ------------------------------------------------------------ 作答与判卷 */

/** 比对答案时忽略空白与标点，避免「少个逗号」被判错 */
function norm(s: string): string {
  return s
    .replace(/[\s\u3000]/g, "")
    .replace(/[，。！？、；：“”‘’（）《》〈〉【】…—,.!?;:"'()[\]{}<>-]/g, "")
    .toLowerCase();
}

async function persist(qid: number, status: "done" | "wrong", judgedBy: "auto" | "parent", answer: string): Promise<void> {
  saving.value = true;
  try {
    const r = await api.saveLanguageProgress({ questionId: qid, status, judgedBy, answer });
    progress.value = r.progress;
    // 后端刚按最新进度重算了打卡标记（9/9 → 打勾 + 20 分），同步进 store 让首页跟着变
    progressStore.applyDaily(r.daily, r.balance);
    await progressStore.syncLanguage(r.counts?.done ?? 0, r.counts?.total ?? 0);
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    saving.value = false;
  }
}

/** 自动判卷：选择 / 填空 / 排序 */
async function checkAuto(): Promise<void> {
  const cur = q.value;
  if (!cur) return;
  const dr = d(cur.id);
  let pass = false;
  let answer = "";

  if (cur.mode === "choice") {
    answer = dr.pick;
    pass = !!dr.pick && norm(dr.pick) === norm(String(cur.answer));
  } else if (cur.mode === "fill") {
    answer = dr.fill;
    pass = !!dr.fill.trim() && norm(dr.fill) === norm(String(cur.answer));
  } else if (cur.mode === "order") {
    const want = cur.answer as string[];
    const picked = dr.order.map((i) => cur.sentences[i]);
    answer = picked.join(" / ");
    pass = picked.length === want.length && picked.every((s, i) => norm(s) === norm(want[i]));
  } else {
    return;
  }

  dr.result = pass ? "ok" : "bad";
  await persist(cur.id, pass ? "done" : "wrong", "auto", answer);
}

async function pickOption(opt: string): Promise<void> {
  const cur = q.value;
  if (!cur || locked(cur.id)) return;
  const dr = d(cur.id);
  dr.pick = opt;
  // 选一下就有结果，不用再点「检查」
  await checkAuto();
}

function onFillInput(e: Event): void {
  const cur = q.value;
  if (!cur) return;
  d(cur.id).fill = (e.target as HTMLInputElement).value;
}

function tapSentence(i: number): void {
  const cur = q.value;
  if (!cur || locked(cur.id)) return;
  const dr = d(cur.id);
  if (dr.order.includes(i)) return;
  dr.order.push(i);
  dr.result = "";
  if (dr.order.length === cur.sentences.length) void checkAuto();
}

function untapSentence(i: number): void {
  const cur = q.value;
  if (!cur || locked(cur.id)) return;
  const dr = d(cur.id);
  dr.order = dr.order.filter((x) => x !== i);
  dr.result = "";
}

function resetOrder(): void {
  const cur = q.value;
  if (!cur || locked(cur.id)) return;
  const dr = d(cur.id);
  dr.order = [];
  dr.result = "";
}

/** 大人判定（口述类题目） */
async function judgeByParent(pass: boolean): Promise<void> {
  const cur = q.value;
  if (!cur) return;
  await persist(cur.id, pass ? "done" : "wrong", "parent", "");
  ui.toast(pass ? "太棒了，这题通过！" : "没关系，再练一练～");
}

function toggleRef(): void {
  const cur = q.value;
  if (!cur) return;
  const dr = d(cur.id);
  dr.showRef = !dr.showRef;
}

/* ------------------------------------------------------------ 朗读 */

const readText = computed(() => {
  const cur = q.value;
  if (!cur) return "";
  if (cur.type === "word") return [cur.word, cur.collocation, cur.example].filter(Boolean).join("，");
  if (cur.type === "sentence_order") return `请把下面的句子排好顺序。${cur.sentences.join(" ")}`;
  if (cur.type === "sentence_correction") return cur.wrongSentence || cur.question;
  // 看图题**不念画面描述** —— 那等于把答案读出来，念问题就够了
  if (cur.type === "image_observation")
    return ["仔细看图，回答问题。", ...cur.observationQuestions].filter(Boolean).join("。");
  if (cur.type === "image_speaking")
    return [cur.question, ...cur.guideQuestions].filter(Boolean).join("。");
  if (cur.type === "word_collocation") {
    return [cur.question, cur.options.length ? `选项：${cur.options.join("，")}` : ""].filter(Boolean).join("。");
  }
  return [cur.question, cur.baseSentence, cur.wrongSentence].filter(Boolean).join("。");
});

async function toggleRead(): Promise<void> {
  if (playing.value) {
    stopAudio();
    return;
  }
  const text = readText.value;
  if (!text) return;
  try {
    await playText(text, "sentence");
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

/* ------------------------------------------------------------ 导航 */

function openQ(i: number): void {
  stopAudio();
  idx.value = i;
  view.value = "q";
}

function backToGrid(): void {
  stopAudio();
  view.value = "grid";
}

function stepQ(delta: number): void {
  const next = idx.value + delta;
  if (next < 0 || next >= questions.value.length) return;
  stopAudio();
  idx.value = next;
}

watch(idx, () => stopAudio());

// 9 道全做完 → 通知孩子「这一项打卡完成、拿到 20 分」。
// 如果这刚好是今天最后一项任务，横幅留给 store 弹（「今日 5 项任务全部完成」），别抢。
watch(allDone, (v, old) => {
  if (!v || old) return;
  const quiet = quietFirstAllDone;
  quietFirstAllDone = false;
  if (quiet) return;
  if (progressStore.completedCount >= TASK_DEFS.length) return;
  ui.celebrate({ title: "9 道题全部完成！🎉", sub: "语言小达人就是你 · 这一项 +20 分" });
});

/* ------------------------------------------------------------ 工具栏备注 */

/**
 * 备注（原来散在页面上的「训练目标 / 换主题说明 / 模型配置提示」），
 * 收进工具栏最右侧的 ⓘ —— 还没出题时连训练目标都还没有，逐条判空再拼。
 */
const lgNote = computed(() =>
  [
    set.value?.trainingGoal ? `训练目标：${set.value.trainingGoal}` : "",
    "「换一套题」会重新出 9 道题，今天的作答记录会清掉；换主题时会避开最近用过的主题。",
    themes.value.length ? `最近用过的主题：${themes.value.slice(0, 4).join("、")}${themes.value.length > 4 ? "…" : ""}` : "",
    "出题用的是「故事模型」那套配置（接口地址固定为 DeepSeek）。一直失败请家长到 /admin 的「系统与数据」里确认模型名与 API Key。",
  ]
    .filter(Boolean)
    .join("\n"),
);

/** 单题页的 ⓘ：只放这道题的小提示（「怎么做」留在正文里，那是题面不是备注） */
const qNote = computed(() => q.value?.hint ?? "");

onMounted(load);
onUnmounted(() => stopAudio());
</script>

<template>
  <section v-if="loading" class="card">
    <div class="loading-card">
      正在打开语言强化…
      <div class="skeleton" style="height: 14px; margin: 14px auto 0; max-width: 320px"></div>
    </div>
  </section>

  <section v-else-if="loadError" class="card">
    <div class="fatal-box" style="margin: 0">
      <b>打不开语言强化</b>
      <p style="margin: 10px 0 0">{{ loadError }}</p>
      <div class="row" style="margin-top: 14px">
        <button class="btn primary" type="button" @click="load()">重试</button>
      </div>
    </div>
  </section>

  <!-- 还没有今天的题目 -->
  <template v-else-if="!set">
    <PageTool
      icon="wand"
      tint="#EAF9F1"
      color="var(--green-d)"
      title="语言强化训练"
      meta="AI 出题 · 每天 9 道 · 说给大人听"
      :note="lgNote"
    >
      <button class="btn green sm" type="button" :disabled="generating" @click="generate(false)">
        <Icon name="sparkle" :size="16" />{{ generating ? "AI 正在出题…" : "生成今日训练" }}
      </button>
    </PageTool>

    <section class="card">
      <div class="lg-empty">
        还没有今天的题目哦。<br />
        点右上角的按钮，AI 会围绕一个随机主题出 9 道题：<br />
        词语 → 搭配 → 扩句 → 改病句 → 写具体 → 排句子 → 看图观察 → 看图说话 → 写一小段。
      </div>
    </section>
  </template>

  <!-- 九宫格目录 -->
  <template v-else-if="view === 'grid'">
    <PageTool
      icon="wand"
      tint="#EAF9F1"
      color="var(--green-d)"
      title="语言强化训练"
      meta="点开哪一道就做哪一道"
      :note="lgNote"
    >
      <template #mid>
        <div class="lg-theme">
          <span class="lg-theme-t">今日主题：{{ set.theme }}</span>
          <span class="badge-lite">难度 {{ set.difficulty }}</span>
          <span class="badge-lite" :class="allDone ? 'ok' : ''">完成 {{ doneCount }}/9</span>
          <span v-if="wrongCount" class="badge-lite err">要再练 {{ wrongCount }}</span>
        </div>
      </template>

      <button class="btn ghost sm" type="button" :disabled="generating" @click="generate(true)">
        <Icon name="refresh" :size="16" />{{ generating ? "正在换一套…" : "换一套题" }}
      </button>
    </PageTool>

    <section class="card">
      <div class="lg-grid">
        <button
          v-for="(item, i) in questions"
          :key="item.id"
          class="lg-cell"
          :class="statusOf(item.id)"
          type="button"
          @click="openQ(i)"
        >
          <span class="lg-no">{{ i + 1 }}</span>
          <span class="lg-ico"><Icon :name="item.icon" :size="20" /></span>
          <span class="lg-name">{{ item.typeName }}</span>
          <span class="lg-tag">{{ modeLabel(item) }}</span>
          <span class="lg-st">{{ statusText(item) }}</span>
        </button>
      </div>
    </section>
  </template>

  <!-- 单题作答 -->
  <template v-else-if="q">
    <PageTool
      icon="wand"
      tint="#EAF9F1"
      color="var(--green-d)"
      title="语言强化训练"
      :meta="`第 ${idx + 1} / 9 题 · ${q.typeName}`"
      :note="qNote"
    >
      <template #head>
        <span class="badge-lite" :class="statusOf(q.id) === 'done' ? 'ok' : statusOf(q.id) === 'wrong' ? 'err' : ''">
          {{ statusText(q) }}
        </span>
      </template>

      <button class="btn ghost sm" type="button" @click="backToGrid()"><Icon name="back" :size="16" />九宫格</button>
      <button class="btn ghost sm" type="button" @click="toggleRead()">
        <Icon :name="playing ? 'stop' : 'speakerLoud'" :size="16" />{{ playing ? "停止" : "读题目" }}
      </button>
    </PageTool>

    <section class="card">

    <p class="lg-how"><b>怎么做：</b>{{ q.howTo }}</p>

    <!-- 1. 每日词语 -->
    <template v-if="q.type === 'word'">
      <div class="lg-word-big">{{ q.word }}</div>
      <div v-if="q.meaning" class="lg-line"><b>意思</b>{{ q.meaning }}</div>
      <div v-if="q.collocation" class="lg-line"><b>搭配</b>{{ q.collocation }}</div>
      <div v-if="q.example" class="lg-line"><b>例句</b>{{ q.example }}</div>
      <p v-if="q.question" class="tip">{{ q.question }}</p>
    </template>

    <!-- 2. 词语搭配 -->
    <template v-else-if="q.type === 'word_collocation'">
      <div class="lg-big">{{ q.question }}</div>

      <div v-if="q.mode === 'choice'" class="lg-opts">
        <button
          v-for="opt in q.options"
          :key="opt"
          class="lg-opt"
          :class="{
            pick: d(q.id).pick === opt,
            ok: d(q.id).pick === opt && d(q.id).result === 'ok',
            bad: d(q.id).pick === opt && d(q.id).result === 'bad',
          }"
          type="button"
          :disabled="locked(q.id)"
          @click="pickOption(opt)"
        >
          {{ opt }}
        </button>
      </div>

      <div v-else class="row" style="margin-top: 12px">
        <input
          class="inp"
          style="flex: 1; min-width: 180px"
          type="text"
          autocomplete="off"
          :disabled="locked(q.id)"
          :value="d(q.id).fill"
          placeholder="把词语填在这里"
          @input="onFillInput"
          @keydown.enter="checkAuto()"
        />
        <button class="btn primary" type="button" :disabled="locked(q.id)" @click="checkAuto()">
          <Icon name="check" :size="18" />检查
        </button>
      </div>
    </template>

    <!-- 6. 句子排序 -->
    <template v-else-if="q.type === 'sentence_order'">
      <div class="lg-big">{{ q.question || "把下面的句子排成通顺的一段话。" }}</div>

      <div class="lg-slot-wrap">
        <div class="lg-slot-hd">我排的顺序（点下面的句子放进来）</div>
        <div v-if="!d(q.id).order.length" class="lg-slot-empty">还没有选句子</div>
        <div v-else class="lg-order-slot">
          <button
            v-for="(si, pos) in d(q.id).order"
            :key="`${si}-${pos}`"
            class="lg-slot"
            type="button"
            :disabled="locked(q.id)"
            @click="untapSentence(si)"
          >
            <span class="n">{{ pos + 1 }}</span>
            <span class="t">{{ q.sentences[si] }}</span>
            <Icon name="cross" :size="14" />
          </button>
        </div>
      </div>

      <div class="lg-slot-wrap">
        <div class="lg-slot-hd">可以选的句子</div>
        <div class="lg-order-pool">
          <button
            v-for="(s, si) in q.sentences"
            v-show="!d(q.id).order.includes(si)"
            :key="si"
            class="lg-order-chip"
            type="button"
            :disabled="locked(q.id)"
            @click="tapSentence(si)"
          >
            {{ s }}
          </button>
        </div>
      </div>

      <div class="row" style="margin-top: 12px">
        <button class="btn ghost sm" type="button" :disabled="locked(q.id)" @click="resetOrder()">
          <Icon name="refresh" :size="16" />重新排
        </button>
        <button class="btn primary sm" type="button" :disabled="locked(q.id) || d(q.id).order.length < 2" @click="checkAuto()">
          <Icon name="check" :size="16" />检查
        </button>
      </div>
    </template>

    <!-- 7. 看图观察 -->
    <template v-else-if="q.type === 'image_observation'">
      <LanguagePicture
        :image="image"
        :busy="imgBusy"
        :error="imgError"
        @redraw="ensureImage(true)"
        @broken="onImgError"
      />
      <details v-if="q.imagePrompt" class="lg-pic-fold">
        <summary>看不清图？点这里看画面文字提示</summary>
        <p>{{ q.imagePrompt }}</p>
      </details>
      <ol class="lg-qs">
        <li v-for="(oq, i) in q.observationQuestions" :key="i">
          <span class="qn">{{ i + 1 }}</span><span>{{ oq }}</span>
        </li>
      </ol>
    </template>

    <!-- 8. 看图说话 -->
    <template v-else-if="q.type === 'image_speaking'">
      <LanguagePicture
        :image="image"
        :busy="imgBusy"
        :error="imgError"
        caption="还是这幅图"
        @redraw="ensureImage(true)"
        @broken="onImgError"
      />
      <div class="lg-big" style="margin-top: 12px">{{ q.question }}</div>
      <ol class="lg-qs">
        <li v-for="(g, i) in q.guideQuestions" :key="i"><span class="qn">{{ i + 1 }}</span><span>{{ g }}</span></li>
      </ol>
    </template>

    <!-- 9. 简短写作 -->
    <template v-else-if="q.type === 'short_writing'">
      <div class="lg-big">{{ q.question }}</div>
      <div v-if="q.keywords.length" class="lg-kw">
        <span v-for="k in q.keywords" :key="k" class="chip">{{ k }}</span>
      </div>
      <ol v-if="q.guideQuestions.length" class="lg-qs">
        <li v-for="(g, i) in q.guideQuestions" :key="i"><span class="qn">{{ i + 1 }}</span><span>{{ g }}</span></li>
      </ol>
      <p v-if="q.requirements" class="tip">
        要求：写 {{ q.requirements.minSentences ?? 4 }}～{{ q.requirements.maxSentences ?? 6 }} 句话，
        大约 {{ q.requirements.suggestedLength ?? "50-100字" }}。可以在本子上写，也可以说给大人听。
      </p>
    </template>

    <!-- 3/4/5. 扩句 · 病句修改 · 把话写具体 -->
    <template v-else>
      <div v-if="q.wrongSentence" class="lg-sent lg-sent-bad">
        <span class="lg-mark">✗</span>{{ q.wrongSentence }}
      </div>
      <div v-else-if="q.baseSentence" class="lg-sent"><span class="lg-mark">◇</span>{{ q.baseSentence }}</div>
      <div v-if="q.question" class="lg-big" style="margin-top: 10px">{{ q.question }}</div>
      <ol v-if="q.guideQuestions.length" class="lg-qs">
        <li v-for="(g, i) in q.guideQuestions" :key="i"><span class="qn">{{ i + 1 }}</span><span>{{ g }}</span></li>
      </ol>
    </template>

    <!-- 判卷结果（自动判卷） -->
    <div v-if="d(q.id).result" class="lg-fb" :class="d(q.id).result === 'ok' ? 'ok' : 'no'">
      <template v-if="d(q.id).result === 'ok'">✅ 答对啦，真棒！</template>
      <template v-else>再想一想，换一个试试～</template>
    </div>

    <p v-if="q.hint" class="tip"><b>小提示：</b>{{ q.hint }}</p>

    <!-- 大人判定（口述类题目） -->
    <div v-if="q.mode === 'open'" class="lg-judge">
      <span class="jl">大人听完了，判一下：</span>
      <button class="btn green sm" type="button" :disabled="saving" @click="judgeByParent(true)">
        <Icon name="check" :size="16" />说得好，通过
      </button>
      <button class="btn ghost sm" type="button" :disabled="saving" @click="judgeByParent(false)">
        <Icon name="refresh" :size="16" />再练一练
      </button>
    </div>

    <!-- 参考答案（做完再看） -->
    <div class="lg-reveal">
      <button class="btn ghost sm" type="button" @click="toggleRef()">
        <Icon :name="d(q.id).showRef ? 'chevDown' : 'chevRight'" :size="16" />
        {{ d(q.id).showRef ? "收起参考答案" : "看参考答案" }}
      </button>
      <div v-if="d(q.id).showRef" class="lg-ref">
        <div v-if="q.errorTypeName"><b>错误类型：</b>{{ q.errorTypeName }}</div>
        <div v-if="q.referenceList.length" class="lg-ref-list">
          <div v-for="(r, i) in q.referenceList" :key="i">{{ i + 1 }}. {{ r }}</div>
        </div>
        <div v-else-if="q.reference">{{ q.reference }}</div>
        <div v-else>这道题没有固定答案，说出来就很棒啦。</div>
        <div v-if="q.analysis" class="lg-ref-an"><b>讲解：</b>{{ q.analysis }}</div>
      </div>
    </div>

    <div class="lg-nav">
      <button class="btn ghost" type="button" :disabled="idx === 0" @click="stepQ(-1)">
        <Icon name="arrowLeft" :size="18" />上一题
      </button>
      <button class="btn primary" type="button" :disabled="idx >= questions.length - 1" @click="stepQ(1)">
        下一题<Icon name="arrowRight" :size="18" />
      </button>
    </div>
    </section>
  </template>
</template>
