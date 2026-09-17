<script setup lang="ts">
/**
 * 今日：学习小岛地图 + 学习小档案
 *
 * 六项任务变成一条**看得见的闯关路线**：六座小岛从左到右排开，虚线航线连起来，
 * 完成一座才解锁下一座。奖励（每关的星星、终点的宝箱）都挂在进度上，
 * 而不是另开一块「积分区」—— 孩子盯着地图就知道还差几步、还差几分。
 *
 * 解锁规则只有一处：`progress.currentIndex`（第一个没做完的任务）。
 * 首页负责「画出来 + 点的时候拦一下」，底部导航和地址栏由路由守卫拦同一套判断，
 * 两处各写一遍一定会算出不一样的结果。
 *
 * 动画刻意压到最低：只有「当前这一关」的呼吸光圈、海面的极慢横移、通关后的宝箱浮动。
 * 三处的幅度都很小、周期都在 2.5 秒以上 —— 这是导航页，不是动画页。
 *
 * 这一页是**孩子端**，只保留孩子会用、爱点的东西。
 * 家长的东西（内容后台、数据备份、运行诊断）一律不在这里出现：
 * 孩子不会用，只有误点的份（手滑点了「导入恢复」是要出事的）。
 * 家长请直接访问 /admin —— 孩子端不提供任何指向它的链接。
 */
import { computed } from "vue";
import { useRouter } from "vue-router";
import Icon from "@/components/Icon.vue";
import { useContentStore } from "@/stores/content";
import { useMasteryStore } from "@/stores/mastery";
import { TASK_DEFS, useProgressStore, type TaskDef } from "@/stores/progress";
import { useStoryStore } from "@/stores/story";
import { useUiStore } from "@/stores/ui";
import type { TaskKey } from "@/api/types";

const router = useRouter();
const progress = useProgressStore();
const mastery = useMasteryStore();
const content = useContentStore();
const story = useStoryStore();
const ui = useUiStore();

/**
 * 六座岛的垂直错落（相对地图高度的百分比），走出一个「一高一低」的节奏。
 *
 * 幅度刻意压得不大（±4.5%）：岛座下面紧跟着岛名和进度标签，错落一大，
 * 那排标签就跟着上下跳，整张图看着像散落的浮岛而不是一条路线。
 *
 * 这个数组同时喂给两处：CSS 的 `--dy`（岛屿定位）和下面的路线 SVG（y = 50 + dy）。
 * 分成两处写的话，虚线迟早会从岛边上擦过去而不是穿过岛心。
 */
const ISLE_DY = [3, -4.5, 4, -4, 4.5, -4];

type IsleState = "done" | "current" | "open" | "locked";

interface Isle extends TaskDef {
  i: number;
  state: IsleState;
  /** 标签下面那一行小字：做完写「已完成」、没解锁写「还没解锁」、轮到它时写真实进度 */
  sub: string;
}

/** 轮到这一关时，标签下写的真实进度；没有可展示的进度就退回该关的短说明 */
function liveProgress(key: TaskKey, fallback: string): string {
  if (key === "math") {
    // 做完就报用时（口算页停表那一刻时间就定死了），没做完就报题数
    if (progress.mathDone && progress.mathElapsedSec > 0) return `用时 ${progress.mathElapsedText}`;
    return `${progress.mathAnswered} / ${progress.mathTotal}`;
  }
  if (key === "language") {
    // 后端算的 9 道题进度。没题集（total 为 0）时别写「0 / 0」，退回默认说明。
    return progress.languageTotal > 0 ? `${progress.languageDone} / ${progress.languageTotal}` : fallback;
  }
  return fallback;
}

/**
 * 错题修理站岛上的短提示。
 *
 * 不复用 `reviewText`：那句「先完成口算和听写，再来复习错题」有 16 个字，
 * 在 1/6 的岛宽里要折成三行，把整座岛撑得比邻居高一截，视觉上全乱。
 * 这里只留最要紧的几个字（完整说明在 WrongView 页里还有一份）。
 */
function reviewShort(): string {
  if (progress.reviewCount > 0) return `已完成 ${progress.reviewCount} / ${progress.reviewTotal} 道`;
  if (progress.isDone("review")) return "错题本是空的";
  if (!progress.canReview) return "先做口算和听写";
  return `0 / ${progress.reviewTotal} 道`;
}

/**
 * 岛标签下面那一行小字。
 *
 * 口算有点特殊：做完之后这一行要报**用时**（孩子看得见自己变快了），
 * 所以它不走「做完就写已完成」那条通用规则 —— 通用规则会让用时永远没机会露脸。
 */
function isleSub(d: TaskDef, state: IsleState): string {
  if (d.key === "review") return reviewShort();
  if (d.key === "math") return liveProgress("math", d.hint);
  if (state === "done") return "已完成";
  return liveProgress(d.key, d.hint);
}

const isles = computed<Isle[]>(() =>
  TASK_DEFS.map((d, i) => {
    const done = progress.isDone(d.key);
    // 错题修理站是「随时能去的工具站」，不占呼吸圈也不上锁（理由见 progress.ts 的 LOCK_CHAIN）
    const state: IsleState = done
      ? "done"
      : d.key === "review"
        ? "open"
        : i === progress.currentIndex
          ? "current"
          : "locked";
    return { ...d, i, state, sub: isleSub(d, state) };
  }),
);

/** 全完成时地图上就没有「当前这一关」了 */
const cleared = computed(() => progress.completedCount >= TASK_DEFS.length);

const mapSub = computed(() => {
  if (cleared.value) return "六座小岛全部走完，太厉害了！";
  if (progress.completedCount === 0) return `从「${TASK_DEFS[0].name}」出发，一关一关往前走`;
  return `还有 ${TASK_DEFS.length - progress.completedCount} 座小岛没走完，继续加油！`;
});

/**
 * 航线从岛座**下缘**穿过，而不是穿岛心：穿心的话整条线会被实心的岛座盖住，等于白画。
 * 加在 `y = 50 + dy` 上的这个偏移量就是「往下挪一点」。
 */
const ROAD_DROP = 7;

/**
 * 航线：把六座岛的中心点连成一条平滑曲线。
 *
 * 坐标用的是 viewBox `0 0 600 100` 的百分比刻度 —— x = (i + 0.5) × 100 正好对应
 * `left: calc((i + 0.5) × 100% / 6)`，y = 50 + 错落值 对应 `top: calc(50% + dy)`。
 * SVG 加 `preserveAspectRatio="none"` 后跟着容器一起拉伸，窄一点宽一点都还穿在岛心上。
 */
const roadPath = computed(() => {
  const pts = TASK_DEFS.map((_, i) => ({ x: (i + 0.5) * 100, y: 50 + ISLE_DY[i] + ROAD_DROP }));
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    // Catmull-Rom → 三次贝塞尔：过点、不抖，比手调控制点稳
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
});

function go(it: Isle): void {
  if (it.state === "locked") {
    ui.toast(`先闯过「${progress.currentTaskName}」，就能解锁这里啦`);
    return;
  }
  void router.push(it.route);
}

const stats = computed(() => [
  { n: mastery.masteredCount, l: "已掌握生字", c: "#3FBF8F", bg: "#E9FBF3" },
  { n: mastery.wrongTotal, l: "错题待复习", c: "#C4486B", bg: "#FFEFF3" },
  { n: story.stories.length, l: "读过的故事", c: "#8E7BEF", bg: "#F3EFFF" },
]);
</script>

<template>
  <section class="card isle-card">
    <div class="card-hd isle-hd">
      <span class="ico" style="background: #FFF6E0; color: #C97F00">
        <Icon name="sun" :size="19" />
      </span>
      <div>
        <h2>今天的学习小岛</h2>
        <span class="sub">{{ mapSub }}</span>
      </div>
      <span class="isle-cheer">加油！你一定可以的！</span>
    </div>

    <!-- 地图：宽屏是横排错落的一条航线，窄屏（见样式里的断点）自动转成竖向路线 -->
    <div class="isle-map">
      <!-- 云：静态装饰，给天空一点层次。刻意不做飘动 —— 全页只留三处动效，且都很轻 -->
      <svg class="isle-cloud c1" viewBox="0 0 120 48" aria-hidden="true">
        <ellipse cx="46" cy="32" rx="42" ry="15" /><ellipse cx="78" cy="34" rx="28" ry="12" /><ellipse cx="28" cy="36" rx="24" ry="10" />
      </svg>
      <svg class="isle-cloud c2" viewBox="0 0 120 48" aria-hidden="true">
        <ellipse cx="46" cy="32" rx="42" ry="15" /><ellipse cx="78" cy="34" rx="28" ry="12" /><ellipse cx="28" cy="36" rx="24" ry="10" />
      </svg>

      <svg class="isle-sea" viewBox="0 0 600 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 60 C 60 53, 120 66, 180 60 C 250 52, 300 67, 370 60 C 440 52, 500 66, 600 58 L600 100 L0 100 Z" />
      </svg>

      <svg class="isle-road" viewBox="0 0 600 100" preserveAspectRatio="none" aria-hidden="true">
        <path :d="roadPath" />
      </svg>

      <button
        v-for="it in isles"
        :key="it.key"
        class="isle"
        :class="it.state"
        type="button"
        :style="{ '--i': it.i, '--dy': `${ISLE_DY[it.i]}%`, '--c': it.color }"
        :aria-label="
          it.state === 'locked'
            ? `${it.name}：还没解锁，先闯过「${progress.currentTaskName}」`
            : `${it.name}：${it.sub}`
        "
        @click="go(it)"
      >
        <span class="isle-art">
          <!-- 岛座：草皮盖住更窄的土坡，露出一圈土色，做出「浮在海上的小岛」 -->
          <svg class="isle-land" viewBox="0 0 120 76" aria-hidden="true">
            <ellipse cx="60" cy="63" rx="46" ry="13" fill="#D9B98B" />
            <ellipse cx="60" cy="54" rx="52" ry="17" fill="#8FCF85" />
            <ellipse cx="60" cy="49" rx="44" ry="12" fill="#A8E29A" opacity=".9" />
            <ellipse cx="46" cy="46" rx="13" ry="4.4" fill="#FFFFFF" opacity=".42" />
          </svg>

          <span class="isle-ico"><Icon :name="it.icon" :size="24" :stroke="2" /></span>

          <span v-if="it.reward > 0" class="isle-star" :title="`完成可得 ${it.reward} 分`">
            +{{ it.reward }}
          </span>

          <span v-if="it.state === 'done'" class="isle-mark ok" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="11" fill="#3FBF8F" />
              <path
                d="M7 12.4 10.4 15.8 17 8.6"
                stroke="#fff"
                stroke-width="2.4"
                fill="none"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <span v-else-if="it.state === 'locked'" class="isle-mark lock" aria-hidden="true">
            <Icon name="lock" :size="14" :stroke="2.4" />
          </span>
        </span>

        <span class="isle-tag">
          <b>{{ it.name }}</b>
          <i>{{ it.sub }}</i>
        </span>

        <span v-if="it.state === 'current' || it.state === 'open'" class="isle-go" :class="{ soft: it.state === 'open' }">
          {{ it.state === "open" ? "去看看" : "出发" }}<Icon name="chevRight" :size="14" :stroke="3" />
        </span>
        <span v-else-if="it.state === 'done'" class="isle-flag"><Icon name="check" :size="13" :stroke="3.2" />已通关</span>
        <span v-else class="isle-wait">做完前一关才开门</span>
      </button>
    </div>
  </section>

  <!-- 路线进度：今天完成几关 + 每关一个编号节点 + 终点宝箱。
       窄屏下只留「完成数 + 宝箱」—— 竖向地图已经把每一关都写清楚了，再来一排节点是重复的。 -->
  <section class="card isle-track" :class="{ full: cleared }">
    <div class="tk-count">
      <span class="tk-lbl">今天完成</span>
      <b>{{ progress.completedCount }}</b>
      <span class="tk-tot">/ {{ TASK_DEFS.length }}</span>
    </div>

    <ol class="tk-dots">
      <li v-for="it in isles" :key="it.key" :class="it.state">
        <span class="tk-dot">
          <Icon v-if="it.state === 'done'" name="check" :size="13" :stroke="3" />
          <template v-else>{{ it.i + 1 }}</template>
        </span>
        <span class="tk-name">{{ it.name }}</span>
      </li>
    </ol>

    <div class="tk-chest" :class="{ on: cleared }" :title="cleared ? '宝箱打开了！' : '走完六座小岛就能打开宝箱'">
      <Icon name="chest" :size="30" :stroke="1.9" />
      <span class="tk-chest-tip">{{ cleared ? "宝箱开了！" : "全部走完开宝箱" }}</span>
    </div>
  </section>

  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #FBF0FF; color: var(--purple-d)">
        <Icon name="star" :size="19" />
      </span>
      <div><h2>学习小档案</h2><span class="sub">你的成长看得见</span></div>
    </div>
    <div class="grid3">
      <div v-for="s in stats" :key="s.l" :style="{ background: s.bg, borderRadius: '16px', padding: '14px', textAlign: 'center' }">
        <div :style="{ fontSize: '30px', fontWeight: 900, color: s.c, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }">{{ s.n }}</div>
        <div style="font-size: 13px; color: #6C8098; font-weight: 700; margin-top: 4px">{{ s.l }}</div>
      </div>
    </div>
    <p class="tip">
      当前课文库共 {{ content.lessons.length }} 篇课文。家长可以登录内容后台继续录制新的篇章，孩子这边立刻就能选到。<br />
      （内容后台与数据备份都在 <code>/admin</code>，只能靠网址打开，孩子端不放入口。）
    </p>
  </section>
</template>
