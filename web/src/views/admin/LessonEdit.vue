<script setup lang="ts">
/**
 * 课文编辑 · 生字与组词
 *
 * 内容录入的完整动线（改造计划 §5）：
 *   ① 批量粘贴一行字 → 后端自动拆字、去重、注音
 *   ② 「AI 生成候选」一次把整篇缺组词的字补齐候选，家长点选即可（组词是唯一必须人工的部分）
 *   ③ 保存 → 自动异步预热该课的语音（组词 + 单字），孩子听写时零延迟
 * 组词非常重要：听写时先读词再读字，用来区分「睛/晴」「铜/同」这类音近字。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { adminApi, describeApiError } from "@/api";
import type { Lesson } from "@/api/types";
import Icon from "@/components/Icon.vue";
import { useContentStore } from "@/stores/content";
import { useUiStore } from "@/stores/ui";

interface Row {
  ch: string;
  word: string;
  pinyin: string;
  hidden: boolean;
}

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const content = useContentStore();

const lessonId = computed(() => Number(route.params.id));
const lesson = ref<Lesson | null>(null);
const rows = ref<Row[]>([]);
const title = ref("");
const unit = ref("");
const sortNo = ref<number>(0);
const note = ref("");

const loading = ref(true);
const busy = ref("");
const dirty = ref(false);

const pasteText = ref("");
const suggestMsg = ref("");
const cands = ref<Record<string, string[]>>({});
const onlyEmpty = ref(true);

const ttsCache = ref<{ count: number; mb: number } | null>(null);
const prewarm = ref<{ jobId: string; total: number; done: number; ok: number; failed: number; status: string } | null>(null);
let prewarmTimer: number | null = null;

const visibleRows = computed(() => rows.value.filter((r) => !r.hidden));
const missingCount = computed(() => visibleRows.value.filter((r) => !r.word.trim()).length);
const dupChars = computed(() => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const r of rows.value) {
    if (seen.has(r.ch)) dup.add(r.ch);
    seen.add(r.ch);
  }
  return [...dup];
});

function applyLesson(l: Lesson): void {
  lesson.value = l;
  title.value = l.title;
  unit.value = l.unit;
  sortNo.value = l.sortNo;
  note.value = l.note ?? "";
  rows.value = l.chars.map((c) => ({ ch: c.ch, word: c.word, pinyin: c.pinyin, hidden: !!c.hidden }));
  dirty.value = false;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const l = await adminApi.getLesson(lessonId.value);
    applyLesson(l);
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (!Number.isFinite(lessonId.value) || lessonId.value <= 0) {
    ui.toast("课文 ID 不对");
    void router.push("/admin");
    return;
  }
  void load();
  void refreshTtsStats();
});

onBeforeUnmount(() => {
  if (prewarmTimer !== null) window.clearInterval(prewarmTimer);
});

/* ------------------------------------------------------------------ 基本信息 */

async function saveMeta(): Promise<void> {
  if (!title.value.trim()) {
    ui.toast("标题不能为空");
    return;
  }
  busy.value = "meta";
  try {
    const l = await adminApi.updateLesson(lessonId.value, {
      title: title.value.trim(),
      unit: unit.value,
      note: note.value,
      sortNo: sortNo.value,
    });
    applyLesson(l);
    await content.load(true);
    ui.toast("课文信息已保存");
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}

/* -------------------------------------------------------------- 批量粘贴生字 */

async function bulkImport(): Promise<void> {
  const text = pasteText.value.trim();
  if (!text) {
    ui.toast("请先粘贴要录入的生字");
    return;
  }
  busy.value = "bulk";
  try {
    const r = await adminApi.bulkChars(lessonId.value, text);
    applyLesson(r.lesson);
    pasteText.value = "";
    await content.load(true);
    ui.toast(`导入完成：新增 ${r.added} 个，跳过 ${r.skipped} 个重复`);
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}

/* ---------------------------------------------------------------- AI 组词候选 */

async function suggest(): Promise<void> {
  busy.value = "suggest";
  suggestMsg.value = "";
  try {
    const r = await adminApi.suggestWords(lessonId.value, onlyEmpty.value);
    if (r.reason) {
      suggestMsg.value = r.reason;
    } else {
      cands.value = r.cands ?? {};
      const n = Object.keys(cands.value).length;
      suggestMsg.value = n ? `已为 ${n} 个字生成候选（点一下填入）` : "没有拿到候选";
    }
    ui.toast(suggestMsg.value);
  } catch (e) {
    suggestMsg.value = describeApiError(e);
    ui.toast("生成候选失败");
  } finally {
    busy.value = "";
  }
}

function pick(ch: string, word: string): void {
  const i = rows.value.findIndex((r) => r.ch === ch);
  if (i < 0) return;
  const next = rows.value.slice();
  next[i] = { ...next[i], word };
  rows.value = next;
  dirty.value = true;
  // 组词变了，拼音要重算 —— 依赖后端的 replaceChars 保存时重算
  const rest = cands.value[ch]?.filter((w) => w !== word) ?? [];
  cands.value = { ...cands.value, [ch]: rest };
}

/* ------------------------------------------------------------------ 保存字表 */

function onWordInput(i: number, value: string): void {
  const next = rows.value.slice();
  next[i] = { ...next[i], word: value };
  rows.value = next;
  dirty.value = true;
}

function toggleHidden(i: number): void {
  const next = rows.value.slice();
  next[i] = { ...next[i], hidden: !next[i].hidden };
  rows.value = next;
  dirty.value = true;
}

function removeRow(i: number): void {
  const r = rows.value[i];
  if (!window.confirm(`确定要删除生字「${r.ch}」吗？`)) return;
  rows.value = rows.value.filter((_, k) => k !== i);
  dirty.value = true;
}

function moveRow(i: number, delta: number): void {
  const j = i + delta;
  if (j < 0 || j >= rows.value.length) return;
  const next = rows.value.slice();
  [next[i], next[j]] = [next[j], next[i]];
  rows.value = next;
  dirty.value = true;
}

async function saveChars(opts: { prewarm?: boolean } = {}): Promise<void> {
  if (dupChars.value.length) {
    ui.toast(`有重复的生字（${dupChars.value.join("、")}），请先处理`);
    return;
  }
  busy.value = "chars";
  try {
    const l = await adminApi.replaceChars(
      lessonId.value,
      rows.value.map((r) => ({ ch: r.ch, word: r.word.trim(), hidden: r.hidden })),
    );
    applyLesson(l);
    await content.load(true);
    ui.toast("字表已保存");
    if (opts.prewarm) await startPrewarm();
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}

/* ------------------------------------------------------------------ 语音预热 */

async function startPrewarm(): Promise<void> {
  if (prewarmTimer !== null) window.clearInterval(prewarmTimer);
  try {
    const r = await adminApi.prewarm(lessonId.value);
    prewarm.value = { jobId: r.jobId, total: r.total, done: 0, ok: 0, failed: 0, status: "running" };
    ui.toast(`开始预热 ${r.total} 段语音…`);
    prewarmTimer = window.setInterval(async () => {
      if (!prewarm.value) return;
      try {
        const job = await adminApi.prewarmStatus(prewarm.value.jobId);
        prewarm.value = {
          jobId: job.id,
          total: job.total,
          done: job.done,
          ok: job.ok,
          failed: job.failed,
          status: job.status,
        };
        if (job.status !== "running") {
          if (prewarmTimer !== null) window.clearInterval(prewarmTimer);
          prewarmTimer = null;
          ui.toast(`预热完成：成功 ${job.ok} 段${job.failed ? `，失败 ${job.failed} 段` : ""}`);
          void refreshTtsStats();
        }
      } catch {
        if (prewarmTimer !== null) window.clearInterval(prewarmTimer);
        prewarmTimer = null;
      }
    }, 1200);
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

const prewarmPct = computed(() => {
  const p = prewarm.value;
  if (!p || !p.total) return 0;
  return Math.round((p.done / p.total) * 100);
});

async function refreshTtsStats(): Promise<void> {
  try {
    const s = await adminApi.ttsStats();
    ttsCache.value = { count: s.count, mb: s.mb };
  } catch {
    /* 忽略 */
  }
}

async function clearTtsCache(): Promise<void> {
  if (!window.confirm("确定要清空全部语音缓存吗？\n下次播放会重新合成（需要联网）。")) return;
  busy.value = "ttsclear";
  try {
    const r = await adminApi.clearTtsCache();
    await refreshTtsStats();
    ui.toast(`已清空 ${r.removed} 个音频文件（${r.mb} MB）`);
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <div v-if="loading" class="card"><div class="loading-card">正在加载课文…</div></div>

  <template v-else-if="lesson">
    <!-- 基本信息 -->
    <section class="card">
      <div class="card-hd">
        <span class="ico" style="background: #F0F5FF; color: var(--blue-d)"><Icon name="pen" :size="19" /></span>
        <div><h2>{{ lesson.title }}</h2><span class="sub">共有 {{ rows.length }} 个生字（{{ visibleRows.length }} 个参与听写）</span></div>
        <div class="spacer"></div>
        <RouterLink class="btn ghost sm" to="/admin"><Icon name="back" :size="16" />返回列表</RouterLink>
      </div>

      <div class="row" style="align-items: flex-end">
        <div class="field" style="flex: 2; min-width: 220px; margin-bottom: 0">
          <label for="t">标题</label>
          <input id="t" v-model="title" class="inp" />
        </div>
        <div class="field" style="flex: 1; min-width: 130px; margin-bottom: 0">
          <label for="u">单元</label>
          <input id="u" v-model="unit" class="inp" />
        </div>
        <div class="field" style="flex: 1; min-width: 100px; margin-bottom: 0">
          <label for="s">排序</label>
          <input id="s" v-model.number="sortNo" class="inp" type="number" inputmode="numeric" />
        </div>
        <button class="btn primary" type="button" :disabled="busy === 'meta'" @click="saveMeta()">
          <Icon name="save" :size="18" />保存信息
        </button>
      </div>
    </section>

    <!-- 批量粘贴 -->
    <section class="card">
      <div class="card-hd">
        <span class="ico" style="background: #E9FBF3; color: var(--green-d)"><Icon name="upload" :size="19" /></span>
        <div><h2>批量粘贴生字</h2><span class="sub">直接粘一行字，自动拆字、去重、注音 —— 组词稍后补</span></div>
      </div>
      <textarea
        v-model="pasteText"
        class="inp"
        rows="3"
        placeholder="例如：两 哪 宽 顶 眼 睛 肚 皮 孩 跳&#10;（空格、逗号、换行都可以，只要里面有汉字）"
      ></textarea>
      <div class="row" style="margin-top: 10px">
        <button class="btn green" type="button" :disabled="busy === 'bulk'" @click="bulkImport()">
          <Icon name="plus" :size="18" />拆字并导入
        </button>
        <span style="font-size: 12.5px; color: var(--ink3)">重复的字会自动跳过，组词留空</span>
      </div>
    </section>

    <!-- 生字表编辑 -->
    <section class="card">
      <div class="card-hd">
        <span class="ico" style="background: #FBEFEA; color: #D9714E"><Icon name="list" :size="19" /></span>
        <div>
          <h2>生字与组词</h2>
          <span class="sub">
            共 {{ rows.length }} 个字
            <template v-if="missingCount">· <b style="color: #C44848">{{ missingCount }} 个还没组词</b></template>
            <template v-else>· 组词齐全 ✅</template>
          </span>
        </div>
        <div class="spacer"></div>
        <label style="font-size: 12.5px; font-weight: 700; color: var(--ink2); display: flex; align-items: center; gap: 6px">
          <input v-model="onlyEmpty" type="checkbox" />只补空白的
        </label>
        <button class="btn purple sm" type="button" :disabled="busy === 'suggest'" @click="suggest()">
          <Icon name="sparkle" :size="16" />{{ busy === "suggest" ? "生成中…" : "AI 生成组词候选" }}
        </button>
      </div>

      <div v-if="suggestMsg" class="tip" style="border-left-color: var(--purple-d)">{{ suggestMsg }}</div>
      <div v-if="dupChars.length" class="tip" style="border-left-color: #E95252">
        有重复的生字：{{ dupChars.join("、") }}。保存前请删掉多余的。
      </div>

      <div v-if="!rows.length" class="wb-empty">还没有生字，用上面的「批量粘贴」导入一批吧。</div>

      <div v-for="(r, i) in rows" :key="`${r.ch}-${i}`" style="margin-bottom: 12px">
        <div class="row-edit">
          <div class="re-ch">{{ r.ch }}</div>
          <input
            class="re-in"
            :value="r.word"
            placeholder="组词（听写消歧用，强烈建议填写）"
            @input="onWordInput(i, ($event.target as HTMLInputElement).value)"
          />
          <input class="re-in py" :value="r.pinyin || '保存后自动注音'" readonly title="拼音由后端按组词语境自动生成" />
          <button
            class="btn sm"
            :class="r.hidden ? 'danger' : 'ghost'"
            type="button"
            :title="r.hidden ? '当前已隐藏，不参与听写；点一下恢复' : '点一下隐藏，不参与听写'"
            @click="toggleHidden(i)"
          >
            {{ r.hidden ? "显示" : "隐藏" }}
          </button>
        </div>
        <div class="row" style="gap: 6px; margin: -4px 0 0 64px; align-items: center">
          <span v-if="r.hidden" class="badge-lite warn">已隐藏</span>
          <button class="log-btn" type="button" title="上移" @click="moveRow(i, -1)"><Icon name="chevDown" :size="13" :stroke="2.4" style="transform: rotate(180deg)" /></button>
          <button class="log-btn" type="button" title="下移" @click="moveRow(i, 1)"><Icon name="chevDown" :size="13" :stroke="2.4" /></button>
          <button class="log-btn" type="button" title="删除这个字" @click="removeRow(i)"><Icon name="trash" :size="13" /></button>
          <template v-if="cands[r.ch]?.length">
            <span style="font-size: 12px; color: var(--ink3); font-weight: 700">候选：</span>
            <button v-for="w in cands[r.ch]" :key="w" class="cand" type="button" @click="pick(r.ch, w)">{{ w }}</button>
          </template>
        </div>
      </div>

      <div class="row" style="margin-top: 16px">
        <button class="btn primary" type="button" :disabled="busy === 'chars'" @click="saveChars()">
          <Icon name="save" :size="18" />保存字表
        </button>
        <button class="btn green" type="button" :disabled="busy === 'chars'" @click="saveChars({ prewarm: true })">
          <Icon name="speakerLoud" :size="18" />保存并预热语音
        </button>
        <span v-if="dirty" class="badge-lite warn">有未保存的修改</span>
      </div>
      <p class="tip">
        组词是<b>唯一必须人工</b>的部分 —— 听写时先读词再读字，靠语境区分「睛/晴」「铜/同」这类音近字。
        拼音会在保存时按组词语境重算，不用手填。
      </p>
    </section>

    <!-- 语音缓存 -->
    <section class="card">
      <div class="card-hd">
        <span class="ico" style="background: #F3EFFF; color: var(--purple-d)"><Icon name="speakerLoud" :size="19" /></span>
        <div>
          <h2>语音缓存</h2>
          <span class="sub">
            <template v-if="ttsCache">已缓存 {{ ttsCache.count }} 个音频文件，约 {{ ttsCache.mb }} MB</template>
            <template v-else>正在读取…</template>
          </span>
        </div>
        <div class="spacer"></div>
        <button class="btn ghost sm" type="button" @click="refreshTtsStats()"><Icon name="refresh" :size="16" />刷新</button>
        <button class="btn danger sm" type="button" :disabled="busy === 'ttsclear'" @click="clearTtsCache()">
          <Icon name="trash" :size="16" />清空缓存
        </button>
      </div>

      <div v-if="prewarm" class="tip" style="border-left-color: var(--green-d)">
        预热进度：{{ prewarm.done }} / {{ prewarm.total }}（成功 {{ prewarm.ok }}，失败 {{ prewarm.failed }}）
        <div class="prewarm-bar"><div class="fill" :style="{ width: `${prewarmPct}%` }"></div></div>
      </div>

      <div class="row" style="margin-top: 10px">
        <button class="btn ghost" type="button" :disabled="!rows.length" @click="startPrewarm()">
          <Icon name="speakerLoud" :size="18" />预热本课全部语音
        </button>
        <span style="font-size: 12.5px; color: var(--ink3)">预热后孩子听写时命中缓存，零延迟、零网络请求</span>
      </div>
    </section>
  </template>
</template>
