<script setup lang="ts">
/**
 * 课文管理：列表 + 新增 + 删除 + 种子数据维护
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { adminApi, describeApiError } from "@/api";
import type { Lesson } from "@/api/types";
import Icon from "@/components/Icon.vue";
import { useContentStore } from "@/stores/content";
import { useUiStore } from "@/stores/ui";

const router = useRouter();
const ui = useUiStore();
const content = useContentStore();

const lessons = ref<Lesson[]>([]);
const loading = ref(false);
const busy = ref("");
const seedStats = ref<Record<string, unknown>>({});

const newTitle = ref("");
const newUnit = ref("");
const newSort = ref<number | null>(null);

const visibleCount = (l: Lesson): number => l.chars.filter((c) => !c.hidden).length;
const hiddenCount = (l: Lesson): number => l.chars.filter((c) => c.hidden).length;
const missingWord = (l: Lesson): number => l.chars.filter((c) => !c.hidden && !c.word.trim()).length;

const totalMissingWords = computed(() => lessons.value.reduce((n, l) => n + missingWord(l), 0));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await adminApi.listLessons();
    lessons.value = r.lessons;
    seedStats.value = r.seedStats ?? {};
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function create(): Promise<void> {
  const title = newTitle.value.trim();
  if (!title) {
    ui.toast("请先填课文标题");
    return;
  }
  busy.value = "create";
  try {
    const r = await adminApi.createLesson({
      title,
      unit: newUnit.value.trim(),
      sortNo: newSort.value ?? undefined,
    });
    newTitle.value = "";
    newUnit.value = "";
    newSort.value = null;
    await load();
    await content.load(true);
    ui.toast("课文已创建，接着录入生字吧");
    void router.push(`/admin/lessons/${r.id}`);
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}

async function remove(l: Lesson): Promise<void> {
  if (!window.confirm(`确定要删除《${l.title}》吗？\n\n这会连同该课 ${l.chars.length} 个生字一起删掉，且无法撤销。\n（孩子的掌握度记录会保留，重新创建同名课文不会自动关联。）`)) return;
  busy.value = `del-${l.id}`;
  try {
    await adminApi.deleteLesson(l.id);
    await load();
    await content.load(true);
    ui.toast("已删除");
  } catch (e) {
    ui.toast(describeApiError(e));
  } finally {
    busy.value = "";
  }
}

async function runSeed(reset: boolean): Promise<void> {
  const msg = reset
    ? "确定要清空所有课文并重新导入内置的 14 篇吗？\n\n这会删掉你后来录入的课文与生字。"
    : "重新导入内置课文（已存在的会跳过，不会覆盖你改过的内容）。继续吗？";
  if (!window.confirm(msg)) return;
  busy.value = reset ? "seed-reset" : "seed";
  try {
    const r = await adminApi.seed(reset);
    await load();
    await content.load(true);
    ui.toast(`种子导入完成：${JSON.stringify(r.result)}`);
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
      <span class="ico" style="background: #EAF3FB; color: var(--blue-d)"><Icon name="plus" :size="19" /></span>
      <div><h2>新增课文</h2><span class="sub">先建课文，再批量粘贴生字</span></div>
    </div>
    <div class="row" style="align-items: flex-end">
      <div class="field" style="flex: 2; min-width: 220px; margin-bottom: 0">
        <label for="nt">课文标题</label>
        <input id="nt" v-model="newTitle" class="inp" placeholder="例如：《小蝌蚪找妈妈》" @keydown.enter="create()" />
      </div>
      <div class="field" style="flex: 1; min-width: 140px; margin-bottom: 0">
        <label for="nu">单元（可留空）</label>
        <input id="nu" v-model="newUnit" class="inp" placeholder="第一单元" />
      </div>
      <div class="field" style="flex: 1; min-width: 110px; margin-bottom: 0">
        <label for="ns">排序（可留空）</label>
        <input id="ns" v-model.number="newSort" class="inp" type="number" inputmode="numeric" placeholder="10" />
      </div>
      <button class="btn primary" type="button" :disabled="busy === 'create'" @click="create()">
        <Icon name="plus" :size="18" />创建
      </button>
    </div>
  </section>

  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #E9FBF3; color: var(--green-d)"><Icon name="list" :size="19" /></span>
      <div>
        <h2>课文列表（{{ lessons.length }} 篇）</h2>
        <span class="sub">
          <template v-if="totalMissingWords > 0">还有 {{ totalMissingWords }} 个生字缺组词 —— 会让听写读音分不清音近字，建议补上</template>
          <template v-else>所有生字都已有组词，朗读消歧可用</template>
        </span>
      </div>
      <div class="spacer"></div>
      <button class="btn ghost sm" type="button" :disabled="busy !== ''" @click="runSeed(false)">重新导入内置课文</button>
      <button class="btn danger sm" type="button" :disabled="busy !== ''" @click="runSeed(true)">清空并重建</button>
    </div>

    <div v-if="loading" class="loading-card">正在加载…</div>
    <div v-else-if="!lessons.length" class="wb-empty">还没有任何课文，先在上面创建一篇，或者导入内置课文。</div>

    <div v-for="l in lessons" :key="l.id" class="lesson-row">
      <div class="l-main">
        <div class="l-t">{{ l.title }}</div>
        <div class="l-u">{{ l.unit || "未分单元" }} · 排序 {{ l.sortNo }}</div>
      </div>
      <span class="badge-lite">{{ visibleCount(l) }} 个生字</span>
      <span v-if="hiddenCount(l)" class="badge-lite warn">{{ hiddenCount(l) }} 个已隐藏</span>
      <span v-if="missingWord(l)" class="badge-lite err">{{ missingWord(l) }} 个缺组词</span>
      <span v-else class="badge-lite ok">组词齐全</span>
      <RouterLink class="btn ghost sm" :to="`/admin/lessons/${l.id}`"><Icon name="pen" :size="16" />编辑</RouterLink>
      <button class="btn danger sm" type="button" :disabled="busy === `del-${l.id}`" @click="remove(l)">
        <Icon name="trash" :size="16" />删除
      </button>
    </div>

    <p class="tip">
      课文保存后会自动预热语音（组词 + 单字各合成一次存进缓存），孩子听写时**零延迟**。<br />
      隐藏（隐藏）功能用来把已经掌握、或不适合本阶段的字从听写轮次里排除掉。
    </p>
  </section>
</template>
