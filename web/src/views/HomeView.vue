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
 * 动画刻意压到最低：只有「当前这一关」的呼吸光圈、通关后的宝箱浮动。
 * 幅度都很小、周期都在 2.5 秒以上 —— 这是导航页，不是动画页。
 * 整块 hero（标题 + 六座岛）压的是同一张静态海洋图，不放动态装饰，
 * 避免和闯关路线抢注意力。
 *
 * 这一页是**孩子端**，只保留孩子会用、爱点的东西。
 * 家长的东西（内容后台、数据备份、运行诊断）一律不在这里出现：
 * 孩子不会用，只有误点的份（手滑点了「导入恢复」是要出事的）。
 * 家长请直接访问 /admin —— 孩子端不提供任何指向它的链接。
 */
import { computed } from "vue";
import { useRouter } from "vue-router";
import Icon from "@/components/Icon.vue";
import isleMath from "@/assets/islands/math.png";
import isleDictation from "@/assets/islands/dictation.png";
import isleReview from "@/assets/islands/review.png";
import isleReading from "@/assets/islands/reading.png";
import isleLanguage from "@/assets/islands/language.png";
import isleVideo from "@/assets/islands/video.png";
// 3D 小图标（宝箱 / 树 / 箭靶 / 书）：原来这几处是线描 SVG 图标，
// 和 3D 岛座摆在一起像两个画风。换成 3D 素材后整页是同一套渲染语言。
// 素材由 scripts/prepare-icons.py 从 AI 出的 2048px 大图抠底生成（源图不进 git）。
import artChest from "@/assets/icons/chest.png";
import artTree from "@/assets/icons/tree.png";
import artTarget from "@/assets/icons/target.png";
import artBook from "@/assets/icons/book.png";
import { useMasteryStore } from "@/stores/mastery";
import { TASK_DEFS, useProgressStore, type TaskDef } from "@/stores/progress";
import { useStoryStore } from "@/stores/story";
import { useUiStore } from "@/stores/ui";
import type { TaskKey } from "@/api/types";

const router = useRouter();
const progress = useProgressStore();
const mastery = useMasteryStore();
const story = useStoryStore();
const ui = useUiStore();

/**
 * 六座功能岛的 3D 单体素材（软萌黏土风、透明底 PNG，水线已在出图时对齐）：
 * 口算=书本+计算器、听写=字牌小屋、错题=扳手工具屋、故事=大树托书、语言=信纸铅笔、英文=ABC 小屋。
 * 走 Vite 打包成 hash 资源，PWA 按 hash 更新缓存。
 */
const ISLE_ART: Record<TaskKey, string> = {
  math: isleMath,
  dictation: isleDictation,
  review: isleReview,
  reading: isleReading,
  language: isleLanguage,
  video: isleVideo,
};

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

/**
 * 单座岛的「岛名 + 状态胶囊」再往下让多少 px（没写的岛 = 0）。
 *
 * 标牌本身已经整块压到岛底座上（见 macaron.css 的 .isle-cap，`bottom: -6%`），
 * 但那是**一刀切**：六座岛的功能物体高矮不一样，最高的三座
 * （错题修理站 = 工具屋 + 卷轴、故事树 = 树冠、英文小屋 = ABC 小屋）
 * 标牌顶边仍会擦到物体，于是逐座微调：
 *   错题修理站 / 英文小屋 / 听写屋 各 10px，故事树 20px（树冠最高）。
 *
 * ⚠️ 单位是「**下移**为正」：CSS 里那条 calc 会把它翻成 `bottom` 的减项
 * （`bottom` 值越大越靠上，直接加会把下移变上移）。别在这里写负数。
 *
 * 只动标牌：岛的定位（`--dy`）、航线、奖励星标都不受影响 ——
 * 标牌是贴在岛上的「标牌」，不是岛的一部分。
 */
const CAP_DROP: Partial<Record<TaskKey, number>> = {
  review: 10,
  video: 10,
  dictation: 10,
  reading: 20,
};

type IsleState = "done" | "current" | "open" | "locked";

interface Isle extends TaskDef {
  i: number;
  state: IsleState;
}

/**
 * 读屏时的这一关状态。
 *
 * 地图上岛名下面不再挂第二行小字（进度、用时、「先做口算和听写」……），
 * 状态只剩「出发 / 待解锁 / 已通关」三种可见表达，其余靠这里补出来 ——
 * 盲用读屏的孩子也得知道这一关是能进还是锁着。
 */
const STATE_LABEL: Record<IsleState, string> = {
  done: "已通关",
  current: "现在这一关",
  open: "随时可去",
  locked: "待解锁",
};

/**
 * 岛上只挂岛名，不再挂第二行。
 *
 * 以前每座岛名下面还跟一行小字（`0 / 20`、`用时 1:32`、`先做口算和听写`……）：
 * 六座岛挤在 1/6 的宽度里，这行字要么被折成两行把岛撑高，要么在窄屏上把标签推成三行，
 * 整条航线看着高低不齐。而这些数字点进去就写在页面上，地图的职责只有一件 ——
 * 「下一步去哪」。进度由下方的进度带负责（今天完成 X / 6 + 号码节点 + 宝箱）。
 */
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
    return { ...d, i, state };
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

/**
 * 学习小档案的三张卡。
 *
 * 每张都有自己的 `bg`（浅色底）和 `c`（主色），数字、文字、边框都跟着 `c` 走 ——
 * 三块能一眼分开，靠的就是「颜色 + 图」这两件事，而不是三行长得一样的数字。
 *
 * `art` 是 3D 素材图，不是线描图标：这三块和上面的岛座是同一屏，画风必须统一。
 * 素材自带体积感，所以卡片里不再给它垫底色块（垫了就是「白框里再套一张图」）。
 */
const stats = computed(() => [
  {
    n: mastery.masteredCount,
    l: "已掌握生字",
    c: "#2FA37A",
    bg: "#E9FBF3",
    art: artTree,
    tip: "继续加油，认识更多有趣的字吧！",
  },
  {
    n: mastery.wrongTotal,
    l: "错题待复习",
    c: "#D9557C",
    bg: "#FFEFF3",
    art: artTarget,
    tip: "把错题变成会做的题！",
  },
  {
    n: story.stories.length,
    l: "读过的故事",
    c: "#7C68E0",
    bg: "#F3EFFF",
    art: artBook,
    tip: "阅读让世界更大！",
  },
]);
</script>

<template>
  <!-- 三块收进同一个外框：地图 / 进度带 / 学习小档案 本来就是同一件事的三段
       （下一步去哪 → 走到哪了 → 攒下了什么），散着摆像三张互不相干的卡，
       框起来才读得出「这是今天的整块面板」。
       外框只负责框住它们：浅底 + 细描边、不投影、不加标题也不加操作 ——
       视觉权重仍然全在内层卡片上，框只是把这一组和页面上别的东西分开。
       圆角按**同心圆角**算：内层 20px + 外框内边距 14px = 34px；
       随手写 24px 的话，两层边线在四角会露出宽窄不一的缝。 -->
  <div class="home-frame">
    <section class="card isle-card">
      <!-- 标题不是「卡片头」，而是这片海的一部分：绝对定位压在天空带上，
           海铺在整块 .isle-card 上（见 macaron.css 的 .isle-card）。
           太阳用 DOM 图标画 —— 背景图里原本也有一轮太阳，补天空时抹掉了：
           那个位置正好是标题文字和第一座岛，两个太阳也会打架。 -->
      <div class="card-hd isle-hd">
        <span class="ico isle-sun"><Icon name="sun" :size="30" /></span>
        <div>
          <h2>今天的学习小岛</h2>
          <span class="sub">{{ mapSub }}</span>
        </div>
        <span class="isle-cheer">加油！你一定可以的！</span>
      </div>

      <!-- 六座岛：宽屏是横排错落的一条航线，窄屏（见样式里的断点）自动转成竖向路线。
           这块自己没有背景 —— 海是 .isle-card 上那张图，它从标题一直铺到卡片底。 -->
      <div class="isle-map">
        <svg class="isle-road" viewBox="0 0 600 100" preserveAspectRatio="none" aria-hidden="true">
          <path :d="roadPath" />
        </svg>

        <button
          v-for="it in isles"
          :key="it.key"
          class="isle"
          :class="it.state"
          type="button"
          :style="{
            '--i': it.i,
            '--dy': `${ISLE_DY[it.i]}%`,
            '--c': it.color,
            '--cap-drop': `${CAP_DROP[it.key] ?? 0}px`,
          }"
          :aria-label="
            it.state === 'locked'
              ? `${it.name}：待解锁，先闯过「${progress.currentTaskName}」`
              : `${it.name}：${STATE_LABEL[it.state]}`
          "
          @click="go(it)"
        >
          <span class="isle-art">
            <!-- 整座功能岛是一张透明底 3D 素材（岛座+功能物体一体，水面投影已烤进 PNG），
                 当前关注吸圈、奖励星标、通关绿勾都叠在这一层上。
                 未解锁的岛**不做灰度**：整座岛还是全彩的，只在岛名下面换成「🔒 待解锁」胶囊。 -->
            <img class="isle-obj" :src="ISLE_ART[it.key]" alt="" draggable="false" />

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
          </span>

          <!-- 岛名 + 状态胶囊整块**叠在岛座底座上**，不再挂在岛下面。
               挂下面时每座岛实际占的高度是「岛 + 两行字」，六座并排就把地图下沿顶满，
               岛只好缩着画；叠上去以后岛是画面主体，那两行字是贴在岛底座上的标牌 ——
               像参考图那样：名字写在岛的底座上，不是漂在岛外面，也不去压岛上的房子/树。
               （窄屏是横排卡片，这一块会回到文档流、与岛名并排，见 macaron.css 的断点。） -->
          <span class="isle-cap">
            <span class="isle-tag"><b>{{ it.name }}</b></span>

            <span v-if="it.state === 'current' || it.state === 'open'" class="isle-go" :class="{ soft: it.state === 'open' }">
              {{ it.state === "open" ? "去看看" : "出发" }}<Icon name="chevRight" :size="14" :stroke="3" />
            </span>
            <span v-else-if="it.state === 'done'" class="isle-flag"><Icon name="check" :size="13" :stroke="3.2" />已通关</span>
            <span v-else class="isle-wait"><Icon name="lock" :size="12" :stroke="2.4" />待解锁</span>
          </span>
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
        <img class="tk-chest-art" :src="artChest" alt="" draggable="false" />
        <span class="tk-chest-tip">{{ cleared ? "宝箱开了！" : "全部走完开宝箱" }}</span>
      </div>
    </section>

    <!-- 学习小档案：三张各自成卡的成绩徽章（图标 + 数字 + 标签 + 一句鼓励）。
         不再套一层白卡：套上之后这三块就只是「一张卡里的三个格子」，
         三行长得一样的数字；拆成独立卡、各自一色，才像三枚并列的徽章。 -->
    <section class="isle-stats">
      <div v-for="s in stats" :key="s.l" class="stat-card" :style="{ background: s.bg, '--c': s.c }">
        <span class="stat-ico"><img class="stat-art" :src="s.art" alt="" draggable="false" /></span>
        <div class="stat-body">
          <b class="stat-n">{{ s.n }}</b>
          <span class="stat-l">{{ s.l }}</span>
          <span class="stat-t">{{ s.tip }}</span>
        </div>
      </div>
    </section>
  </div>
</template>
