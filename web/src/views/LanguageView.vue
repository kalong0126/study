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
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api, describeApiError } from "@/api";
import type { LanguageProgress, LanguageQuestion, LanguageSet } from "@/api/types";
import Icon from "@/components/Icon.vue";
import { playText, stopAudio, useAudioState } from "@/composables/useAudio";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();
const { playing } = useAudioState();

const loading = ref(true);
const generating = ref(false);
const saving = ref(false);
const loadError = ref("");

const set = ref<LanguageSet | null>(null);
const progress = ref<LanguageProgress>({});
const themes = ref<string[]>([]);

/** grid = 九宫格目录；q = 单题作答 */
const view = ref<"grid" | "q">("grid");
const idx = ref(0);

const questions = computed<LanguageQuestion[]>(() => set.value?.questions ?? []);
const q = computed<LanguageQuestion | null>(() => questions.value[idx.value] ?? null);
/** 第 7 题的画面（第 8 题「看图说话」要复用同一场景） */
const sceneQ = computed<LanguageQuestion | null>(() => questions.value[6] ?? null);

const doneCount = computed(() => Object.values(progress.value).filter((p) => p.status === "done").length);
const wrongCount = computed(() => Object.values(progress.value).filter((p) => p.status === "wrong").length);
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
    themes.value = r.themes ?? [];
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
    // 清掉所有单题草稿（题换了，旧草稿没意义）
    drafts.value = {};
    view.value = "grid";
    idx.value = 0;
    ui.toast(r.cached ? `今天已经有题目了（主题：${r.set.theme}）` : `出好了！今日主题：${r.set.theme}`);
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    generating.value = false;
  }
}

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
  if (cur.type === "image_observation") return cur.imagePrompt;
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

watch(allDone, (v, old) => {
  if (v && !old) ui.celebrate({ title: "9 道题全部完成！🎉", sub: "语言小达人就是你" });
});

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
  <section v-else-if="!set" class="card">
    <div class="card-hd">
      <span class="ico" style="background: #EAF9F1; color: var(--green-d)"><Icon name="wand" :size="19" /></span>
      <div>
        <h2>语言强化训练</h2>
        <span class="sub">AI 出题 · 每天 9 道 · 说给大人听</span>
      </div>
    </div>
    <div class="lg-empty">
      还没有今天的题目哦。<br />
      点下面的按钮，AI 会围绕一个随机主题出 9 道题：<br />
      词语 → 搭配 → 扩句 → 改病句 → 写具体 → 排句子 → 看图观察 → 看图说话 → 写一小段。
    </div>
    <div class="row" style="justify-content: center">
      <button class="btn green" type="button" :disabled="generating" @click="generate(false)">
        <Icon name="sparkle" :size="18" />{{ generating ? "AI 正在出题…（约 20 秒）" : "生成今日训练" }}
      </button>
    </div>
    <p class="tip">
      出题用的是「故事模型」那套配置（接口地址固定为 DeepSeek）。<br />
      如果一直失败，家长可以到 <code>/admin</code> 的「系统与数据」里确认模型名与 API Key。
    </p>
  </section>

  <!-- 九宫格目录 -->
  <section v-else-if="view === 'grid'" class="card">
    <div class="card-hd">
      <span class="ico" style="background: #EAF9F1; color: var(--green-d)"><Icon name="wand" :size="19" /></span>
      <div>
        <h2>语言强化训练</h2>
        <span class="sub">今天 9 道题，点开哪一道就做哪一道</span>
      </div>
    </div>

    <div class="lg-theme">
      <span class="lg-theme-t">今日主题：{{ set.theme }}</span>
      <span class="badge-lite">难度 {{ set.difficulty }}</span>
      <span class="badge-lite" :class="allDone ? 'ok' : ''">完成 {{ doneCount }}/9</span>
      <span v-if="wrongCount" class="badge-lite err">要再练 {{ wrongCount }}</span>
    </div>

    <p v-if="set.trainingGoal" class="tip" style="margin-top: 0">训练目标：{{ set.trainingGoal }}</p>

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

    <div class="row" style="margin-top: 16px">
      <button class="btn ghost sm" type="button" :disabled="generating" @click="generate(true)">
        <Icon name="refresh" :size="16" />{{ generating ? "正在换一套…" : "换一套题" }}
      </button>
      <span style="font-size: 12.5px; color: var(--ink3)">
        换主题时会避开最近用过的{{ themes.length ? `（最近用过：${themes.slice(0, 4).join("、")}${themes.length > 4 ? "…" : ""}）` : "" }}
      </span>
    </div>
  </section>

  <!-- 单题作答 -->
  <section v-else-if="q" class="card">
    <div class="lg-qhd">
      <button class="btn ghost sm" type="button" @click="backToGrid()"><Icon name="back" :size="16" />九宫格</button>
      <span class="lg-qidx">第 {{ idx + 1 }} / 9 题</span>
      <span class="badge-lite">{{ q.typeName }}</span>
      <span class="badge-lite" :class="statusOf(q.id) === 'done' ? 'ok' : statusOf(q.id) === 'wrong' ? 'err' : ''">
        {{ statusText(q) }}
      </span>
      <span class="spacer"></span>
      <button class="btn ghost sm" type="button" @click="toggleRead()">
        <Icon :name="playing ? 'stop' : 'speakerLoud'" :size="16" />{{ playing ? "停止" : "读题目" }}
      </button>
    </div>

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
      <div class="lg-pic">
        <span class="lg-pic-tag"><Icon name="eye" :size="15" />画面描述</span>
        {{ q.imagePrompt }}
      </div>
      <ol class="lg-qs">
        <li v-for="(oq, i) in q.observationQuestions" :key="i">
          <span class="qn">{{ i + 1 }}</span><span>{{ oq }}</span>
        </li>
      </ol>
    </template>

    <!-- 8. 看图说话 -->
    <template v-else-if="q.type === 'image_speaking'">
      <div v-if="sceneQ?.imagePrompt" class="lg-pic">
        <span class="lg-pic-tag"><Icon name="eye" :size="15" />还是这幅画面</span>
        {{ sceneQ.imagePrompt }}
      </div>
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
