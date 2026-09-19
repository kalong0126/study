/**
 * 故事 store：童话阅读 + 已读主题 + 阅读计时
 *
 * 与旧版的区别：
 *   · 故事正文与「已读主题」都进数据库了（多设备共享，读过不再重复生成）
 *   · 计时状态也存后端，换设备打开还记得在计时
 *   · 朗读改为按句串行播放 + 逐句高亮（孩子能跟着高亮跟读）
 *   · **「今日童话」由后端按天认定**：孩子端一进页面就 `ensureToday()`，
 *     今天已经生成过就取那一篇（`cached`），不会重复调模型
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api";
import type { StateSnapshot, StoryFav, StoryRow } from "@/api/types";
import { useProgressStore } from "./progress";
import { useUiStore } from "./ui";

export const TIMER_SECONDS = 15 * 60;

export const useStoryStore = defineStore("story", () => {
  const stories = ref<StoryRow[]>([]);
  const readTitles = ref<string[]>([]);
  const current = ref<{ id: number; title: string; text: string } | null>(null);
  const generating = ref(false);
  const lastError = ref("");
  /** 「今天有没有童话」这一问还在路上 —— 页面用它决定显示骨架还是空态 */
  const loadingToday = ref(false);

  const timer = ref<{ running: boolean; endAt: number }>({ running: false, endAt: 0 });
  const now = ref(Date.now());
  let tick: number | null = null;

  /* ------------------------------------------------------------ 故事收藏 */

  /** 收藏的故事（正文随收藏一起存，历史故事删了也能照常重读） */
  const favs = ref<StoryFav[]>([]);
  const favCount = computed(() => favs.value.length);

  function isFav(title: string): boolean {
    return favs.value.some((f) => f.title === title);
  }

  /** 拉一次收藏列表（首页 / 收藏页用） */
  async function loadFavs(): Promise<void> {
    try {
      favs.value = await api.storyFavs();
    } catch {
      /* 拉取失败不打扰孩子：收藏页会再拉一次 */
    }
  }

  /** 收藏 / 取消收藏当前这篇（按标题切换，幂等） */
  async function toggleFav(story: { id: number; title: string; text: string }): Promise<boolean> {
    const ui = useUiStore();
    const r = await api.toggleStoryFav(story);
    favs.value = r.favs;
    ui.toast(r.fav ? `已收藏《${story.title}》，可以反复读啦` : "已取消收藏");
    return r.fav;
  }

  const timerRemain = computed(() => {
    if (!timer.value.running || !timer.value.endAt) return TIMER_SECONDS;
    return Math.max(0, Math.ceil((timer.value.endAt - now.value) / 1000));
  });
  const timerClock = computed(() => {
    const s = timerRemain.value;
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${mm < 10 ? "0" : ""}${mm}:${ss < 10 ? "0" : ""}${ss}`;
  });

  function applySnapshot(s: StateSnapshot): void {
    stories.value = s.stories ?? [];
    readTitles.value = s.readTitles ?? [];
    timer.value = s.timer ?? { running: false, endAt: 0 };
    // 跨天 / 已超时 → 自动结束
    if (timer.value.running && timer.value.endAt <= Date.now()) {
      void stopTimer(true);
    } else {
      armTick();
    }
  }

  async function refresh(): Promise<void> {
    const r = await api.listStories(30);
    stories.value = r.stories;
    readTitles.value = r.readTitles;
  }

  /**
   * 进童话页时调用：**今天的童话**要么取现成的、要么现在生成一篇。
   *
   * 幂等由后端保证（不带 force 的 `/story/generate` 在当天已有童话时原样返回），
   * 这里再加一道「同一时刻只发一次」的闸：孩子端进来、路由切回来、
   * 平板和手机同时开着，都不该把同一篇童话生成两遍（那是真金白银的 token）。
   */
  async function ensureToday(): Promise<void> {
    if (loadingToday.value || generating.value) return;
    loadingToday.value = true;
    try {
      const r = await api.storyToday();
      if (r.story) {
        current.value = { id: r.story.id, title: r.story.title, text: r.story.text };
        // 历史列表 / 「读过 N 篇」也要跟着准：今天这篇可能还没在这台设备的列表里
        if (!stories.value.some((s) => s.id === r.story!.id)) stories.value = [r.story, ...stories.value];
        return;
      }
      await generate();
    } finally {
      loadingToday.value = false;
    }
  }

  async function generate(force = false): Promise<StoryRow | null> {
    const ui = useUiStore();
    if (generating.value) return null;
    generating.value = true;
    lastError.value = "";
    try {
      const r = await api.generateStory(readTitles.value, force);
      const row: StoryRow = { id: r.id, title: r.title, text: r.text, createdAt: new Date().toISOString() };
      stories.value = [row, ...stories.value.filter((s) => s.id !== row.id)];
      if (!readTitles.value.includes(r.title)) readTitles.value = [...readTitles.value, r.title];
      current.value = { id: row.id, title: row.title, text: row.text };
      ui.toast(r.cached ? `今天已经写过《${r.title}》啦，接着读吧` : `新童话《${r.title}》来啦，一起读一读吧`);
      return row;
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      generating.value = false;
    }
  }

  function load(story: StoryRow | { id: number; title: string; text: string }): void {
    current.value = { id: story.id, title: story.title, text: story.text };
  }

  async function remove(title: string): Promise<void> {
    const ui = useUiStore();
    const r = await api.deleteStory(title);
    stories.value = r.stories;
    readTitles.value = r.readTitles;
    if (current.value?.title === title) current.value = null;
    ui.toast("已移除，之后可以再生成这个主题");
  }

  /* ------------------------------------------------------------ 阅读计时 */

  function armTick(): void {
    if (tick !== null) return;
    tick = window.setInterval(() => {
      now.value = Date.now();
      if (!timer.value.running) return;
      if (now.value >= timer.value.endAt) void onFinish();
    }, 1000);
  }

  function disarmTick(): void {
    if (tick !== null) {
      window.clearInterval(tick);
      tick = null;
    }
  }

  async function onFinish(): Promise<void> {
    const progress = useProgressStore();
    const ui = useUiStore();
    await stopTimer(true);
    const filled = await progress.completeTask("reading");
    if (!filled) ui.celebrate({ title: "读满 15 分钟！", sub: "阅读任务完成，眼睛该休息啦" });
  }

  function startTimer(): void {
    const ui = useUiStore();
    timer.value = { running: true, endAt: Date.now() + TIMER_SECONDS * 1000 };
    now.value = Date.now();
    armTick();
    api.setTimer(timer.value).catch(() => undefined);
    ui.toast("计时开始，安心读书吧～");
  }

  async function stopTimer(silent = false): Promise<void> {
    timer.value = { running: false, endAt: 0 };
    disarmTick();
    if (!silent) api.setTimer(timer.value).catch(() => undefined);
    else await api.setTimer(timer.value).catch(() => undefined);
  }

  /** 「结束计时」按钮：读够 20 秒就认可（孩子可能提前读完） */
  async function finishTimerEarly(): Promise<void> {
    const ui = useUiStore();
    const progress = useProgressStore();
    const remain = timerRemain.value;
    const ranSeconds = TIMER_SECONDS - remain;
    await stopTimer(false);
    if (ranSeconds >= 20) {
      await progress.completeTask("reading");
      ui.toast("阅读完成！真棒");
    } else {
      ui.toast("计时已结束");
    }
  }

  function resumeTimer(): void {
    if (timer.value.running && timer.value.endAt > Date.now()) armTick();
  }

  return {
    stories,
    readTitles,
    current,
    generating,
    loadingToday,
    lastError,
    timer,
    timerClock,
    timerRemain,
    favs,
    favCount,
    isFav,
    loadFavs,
    toggleFav,
    applySnapshot,
    refresh,
    ensureToday,
    generate,
    load,
    remove,
    startTimer,
    stopTimer,
    finishTimerEarly,
    resumeTimer,
  };
});
