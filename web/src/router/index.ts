import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";

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
  { path: "/wrong", name: "wrong", component: () => import("@/views/WrongView.vue"), meta: { title: "错题本" } },
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

const BASE_TITLE = "二年级快乐学习台";
router.afterEach((to) => {
  const t = to.meta.title as string | undefined;
  document.title = t ? `${t} · ${BASE_TITLE}` : BASE_TITLE;
});
