<script setup lang="ts">
/**
 * 错题小本本
 *
 * 做对一次就擦掉一题；重做满 `reviewTarget` 道（或错题本被清空）即完成今日「错题复习」。
 *
 * 两条硬规矩：
 *   1. **必须等口算和听写都做完才能开始重做**（`reviewOpen`）。这两项会往错题本里加题，
 *      边做边复习的话「要复习几道」一直在变。没开闸时输入框是禁用的，不会白做。
 *   2. 数学错题**绝不能把正确答案显示出来** —— 孩子照着抄一遍什么都学不到。
 *      所以数学卡片上只有题干 + 一个可以随时填写的输入框，答案躲在判分逻辑里。
 */
import { computed, onMounted, ref } from "vue";
import type { WrongItem } from "@/api/types";
import Icon from "@/components/Icon.vue";
import PageTool from "@/components/PageTool.vue";
import { playText } from "@/composables/useAudio";
import { playDing } from "@/composables/useSound";
import { useContentStore } from "@/stores/content";
import { useMasteryStore } from "@/stores/mastery";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();
const mastery = useMasteryStore();
const progress = useProgressStore();
const content = useContentStore();

/** 开闸了才能重做；没开闸只给看，不让动手（任务已完成时也放开，免得自相矛盾） */
const canReview = computed(() => progress.canReview);

const tab = ref<"math" | "chinese">("math");
/**
 * 数学错题的输入框**常驻**在题干旁边，不用先点按钮就能直接算；
 * 语文错字没法自动判分，才需要展开一个「在纸上写完了吗」的确认区。
 */
const cnChallengeId = ref(0);

onMounted(() => {
  void progress.syncReview();
});

const mathList = computed(() => mastery.wrong.math);
const cnList = computed(() => mastery.wrong.chinese);

/**
 * 备注（原「为什么现在不能改」那块黄色横条 + 玩法说明），收进工具栏最右侧的 ⓘ。
 * 没开闸时改由工具栏上的状态胶囊直说「等口算和听写做完」——**拦人的话必须在明面上**，
 * 只藏在 ⓘ 里等于没提醒；为什么、怎么办这种长解释才收进图标。
 */
const wrongNote = computed(() =>
  canReview.value
    ? [
        "做对一次就能擦掉一题。",
        "数学错题：直接在题目右边把答案填进去，算对了这道题立刻被擦掉（答案不显示，防照抄）。",
        "语文错字：点左边的字可以听读音，在纸上写一遍再点「重新挑战」。",
        `重做满 ${progress.reviewTotal} 道（或者错题本被清空）就完成今天的「错题复习」。`,
      ].join("\n")
    : [
        "今天的错题复习要先把「每日口算」和「语文听写」做完再来。",
        "这两项还会往错题本里加题 —— 做到一半题数就变了，所以先不让改。",
        "现在可以翻看下面的错题，输入框是灰的、填不进去。",
      ].join("\n"),
);

const textOf = (it: WrongItem): string => String(it.payload.text ?? "");
const ansOf = (it: WrongItem): string => String(it.payload.ans ?? "");
const charOf = (it: WrongItem): string => String(it.payload.char ?? "");
const lessonOf = (it: WrongItem): string => String(it.payload.lessonTitle ?? "") || "语文错字";

function pinyinOf(it: WrongItem): string {
  const ch = charOf(it);
  const lessonId = Number(it.payload.lessonId ?? 0);
  const lesson = lessonId ? content.findLesson(lessonId) : null;
  const c = lesson?.chars.find((x) => x.ch === ch);
  return content.pinyinOf(ch, c ?? null) || "点左边的字听读音";
}

/** 语文错字：展开「在纸上写了一遍」的确认区 */
function startCnChallenge(id: number): void {
  if (!canReview.value) return;
  cnChallengeId.value = id;
}

function cancelCn(): void {
  cnChallengeId.value = 0;
}

async function finishCorrect(it: WrongItem): Promise<void> {
  if (!canReview.value) return; // 没开闸就不该发生（输入是禁用的），兜一下
  // 语文错字重新挑战写对后：除了擦掉错题，还要把它标记为「已掌握」，
  // 让生字听写页该字从 ✗ 变 ✓（与「做对 = 掌握」一致）。
  if (it.type === "chinese") {
    const lessonId = Number(it.payload.lessonId ?? 0);
    const ch = charOf(it);
    if (lessonId > 0 && ch) {
      await mastery
        .setCharState(lessonId, ch, 1, { lessonTitle: lessonOf(it), skipWrongBook: true })
        .catch(() => undefined);
    }
  }
  await mastery.removeWrongItem(it.type, it.id);
  cnChallengeId.value = 0;
  playDing();
  await progress.bumpReview();
  ui.toast(it.type === "math" ? "算对啦！这道题从错题本擦掉了" : "写对啦！已标记为已掌握，从错字本擦掉了 ✓");
}

/** 数学：边输入边判，一旦和正确答案一致就立刻擦掉这道题 */
function onMathInput(it: WrongItem, e: Event): void {
  if (!canReview.value) return;
  const el = e.target as HTMLInputElement;
  el.classList.remove("bad");
  const v = el.value.trim();
  if (v && v === ansOf(it)) void finishCorrect(it);
}

/**
 * 算得不对时给个「再想想」的提示：输入框闪一下红框。
 * 只在离开输入框（或按回车）时才判——否则刚敲下十位数就会被误判。
 */
function onMathBlur(it: WrongItem, e: Event): void {
  if (!canReview.value) return;
  const el = e.target as HTMLInputElement;
  const v = el.value.trim();
  if (!v || v === ansOf(it)) return;
  el.classList.remove("bad");
  void el.offsetWidth; // 强制重排，保证连续两次都能重新播放红框
  el.classList.add("bad");
  window.setTimeout(() => el.classList.remove("bad"), 1000);
}

function speak(ch: string): void {
  if (ch) void playText(ch, "char");
}

function switchTab(next: "math" | "chinese"): void {
  tab.value = next;
  cancelCn();
}
</script>

<template>
  <!-- 详情页统一工具栏：标题 / 玩法说明 / 两个分区的分段切换 / 复习状态 / 备注图标 -->
  <PageTool icon="wrong" tint="#FFEFF3" color="#C4486B" title="错题小本本" meta="做对一次就能擦掉一题" :note="wrongNote">
    <template #mid>
      <div class="seg" style="--seg-c: #C4486B">
        <button class="seg-btn" :class="{ on: tab === 'math' }" type="button" @click="switchTab('math')">
          <Icon name="math" :size="16" />数学错题 <span class="n">{{ mathList.length }}</span>
        </button>
        <button class="seg-btn" :class="{ on: tab === 'chinese' }" type="button" @click="switchTab('chinese')">
          <Icon name="chinese" :size="16" />语文错字 <span class="n">{{ cnList.length }}</span>
        </button>
      </div>
    </template>

    <span v-if="canReview" class="stat-pill">
      重新挑战 <b>{{ progress.reviewCount }}</b> / {{ progress.reviewTotal }}
    </span>
    <!-- 没开闸时这句话必须在明面上：它说明「为什么填不进去」 -->
    <span v-else class="stat-pill"><Icon name="wrong" :size="15" />等口算和听写做完</span>
  </PageTool>

  <section class="card">
    <div class="wb-list">
      <!-- 数学 -->
      <template v-if="tab === 'math'">
        <div v-if="!mathList.length" class="wb-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="#B9CCDE" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9.5" />
            <path d="M8 12.5 10.8 15.3 16.2 9.2" />
          </svg>
          数学错题本是空的，太棒啦！
        </div>

        <div v-for="it in mathList" :key="it.id" class="wb-item">
          <span class="w-q">{{ textOf(it) }}</span>
          <!-- 只留一个可以随时填写的输入框，答案不显示（防止照抄） -->
          <div class="wb-ans">
            <span class="w-lab">再算一次</span>
            <input
              class="m-in"
              type="number"
              inputmode="numeric"
              placeholder="?"
              autocomplete="off"
              :disabled="!canReview"
              :data-wc="it.id"
              @input="onMathInput(it, $event)"
              @blur="onMathBlur(it, $event)"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
            />
          </div>
        </div>
      </template>

      <!-- 语文 -->
      <template v-else>
        <div v-if="!cnList.length" class="wb-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="#B9CCDE" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9.5" />
            <path d="M8 12.5 10.8 15.3 16.2 9.2" />
          </svg>
          语文错字本是空的，真厉害！
        </div>

        <div v-for="it in cnList" :key="it.id" class="wb-item">
          <button class="w-char" type="button" :aria-label="`朗读 ${charOf(it)}`" @click="speak(charOf(it))">
            {{ charOf(it) }}
          </button>
          <div class="w-meta">
            <div class="w-lab">{{ lessonOf(it) }}</div>
            <div class="w-py">{{ pinyinOf(it) }}</div>
          </div>

          <div v-if="cnChallengeId === it.id" class="wb-challenge">
            <span class="w-lab">在纸上写一遍，写对了吗？</span>
            <button class="btn green sm" type="button" @click="finishCorrect(it)">写对了，擦掉它</button>
            <button class="btn ghost sm" type="button" @click="cancelCn()">再练练</button>
          </div>
          <button v-else class="btn yellow sm" type="button" :disabled="!canReview" @click="startCnChallenge(it.id)">
            <Icon name="refresh" :size="16" :stroke="2.2" />重新挑战
          </button>
        </div>
      </template>
    </div>
  </section>
</template>
