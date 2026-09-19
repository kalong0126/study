import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { ROUTE_TASK, useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";

const routes: RouteRecordRaw[] = [
  { path: "/", name: "home", component: () => import("@/views/HomeView.vue"), meta: { title: "今日" } },
  { path: "/math", name: "math", component: () => import("@/views/MathView.vue"), meta: { title: "口算" } },
  { path: "/chinese", name: "chinese", component: () => import("@/views/ChineseView.vue"), meta: { title: "语文" } },
  { path: "/story", name: "story", component: () => import("@/views/StoryView.vue"), meta: { title: "童话" } },
  {
    path: "/language",
    name: "language",
    component: () => import("@/views/LanguageView.vue"),
    meta: { title: "语言强化" },
  },
  { path: "/video", name: "video", component: () => import("@/views/VideoView.vue"), meta: { title: "英文故事" } },
  { path: "/wrong", name: "wrong", component: () => import("@/views/WrongView.vue"), meta: { title: "错题本" } },
  {
    path: "/mastered",
    name: "mastered",
    component: () => import("@/views/MasteredView.vue"),
    meta: { title: "已掌握生字" },
  },
  { path: "/words", name: "words", component: () => import("@/views/WordsView.vue"), meta: { title: "已掌握词语" } },
  { path: "/favs", name: "favs", component: () => import("@/views/StoryFavsView.vue"), meta: { title: "收藏的故事" } },
  { path: "/points", name: "points", component: () => import("@/views/PointsView.vue"), meta: { title: "我的积分" } },
  {
    path: "/admin",
    component: () => import("@/views/admin/AdminView.vue"),
    children: [
      { path: "", name: "admin-lessons", component: () => import("@/views/admin/LessonList.vue") },
      { path: "lessons/:id", name: "admin-lesson-edit", component: () => import("@/views/admin/LessonEdit.vue") },
      { path: "system", name: "admin-system", component: () => import("@/views/admin/SystemPanel.vue") },
    ],
  },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0, behavior: "smooth" }),
});

/**
 * 关卡顺序锁：首页那张小岛地图是「闯过一关才解锁下一关」的，
 * 底部导航和地址栏必须是同一条规矩 ——
 * 否则从导航直接跳进第 5 关做完，首页地图上它还原地锁着，孩子会看到两套互相矛盾的状态。
 *
 * 三条放行规则：
 *   1. 不是任务页（今日 / 积分 / 家长后台）→ 与本锁无关
 *   2. 当日状态还没从服务端拿到 → 放行。本地此时是一张全 false 的空白表，
 *      照它判定会把做完的口算也算成没做，把按时来学习的孩子挡在门外
 *   3. 这一关已经完成 → 放行。想重做一遍口算、想回看一集英文，都不该被自己的成绩拦住
 */
router.beforeEach((to) => {
  const key = ROUTE_TASK[to.path];
  if (!key) return true;

  const progress = useProgressStore();
  if (!progress.loaded) return true;
  if (progress.isDone(key) || progress.isUnlocked(key)) return true;

  useUiStore().toast(`先闯过「${progress.currentTaskName}」，就能解锁这里啦`);
  return { path: "/" };
});

const BASE_TITLE = "二年级快乐学习台";
router.afterEach((to) => {
  const t = to.meta.title as string | undefined;
  document.title = t ? `${t} · ${BASE_TITLE}` : BASE_TITLE;
});
