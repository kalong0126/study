/**
 * 故事 store：童话阅读 + 已读主题 + 阅读计时
 *
 * 与旧版的区别：
 *   · 故事正文与「已读主题」都进数据库了（多设备共享，读过不再重复生成）
 *   · 计时状态也存后端，换设备打开还记得在计时
 *   · 朗读改为按句串行播放 + 逐句高亮（孩子能跟着高亮跟读）
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api";
import type { StateSnapshot, StoryRow } from "@/api/types";
import { useProgressStore } from "./progress";
import { useUiStore } from "./ui";

export const TIMER_SECONDS = 15 * 60;

/** 没有大模型配置时的试读内容（原文来自单文件版，保留作为兜底） */
export const SAMPLE_STORIES: { title: string; text: string }[] = [
  {
    title: "示例：小水珠的旅行",
    text: "有一颗小水珠，住在软软的云朵妈妈怀里。一天，它听见大地在喊渴，就说：“妈妈，我要去帮帮它们！”云朵妈妈点点头，小水珠便和伙伴们一起跳了下去。\n它落进一条小溪，溪水叮叮咚咚地唱着歌，把小水珠送进荷塘。荷塘里，一朵粉荷花正低着头。小水珠问：“你怎么不高兴呀？”粉荷花说：“太阳太晒了，我好渴。”小水珠就滚到花瓣上，让粉荷花喝了个饱。粉荷花抬起头，笑得又香又甜。\n后来，太阳公公把它接回天上。小水珠发现，自己走过的地方，草更绿了，花开得更艳了。它开心地说：“原来帮助别人，自己也会变得亮晶晶的！”",
  },
  {
    title: "示例：爱笑的铅笔",
    text: "文具盒里住着一支短短的铅笔。别的笔都笑它太矮，写出来的字也不够漂亮。铅笔不生气，只是笑眯眯地说：“我还写得动呀。”\n有一天，小主人的作业本上出现了一道难题，钢笔写错了，橡皮擦破了纸。铅笔轻轻地说：“让我来试试吧。”它慢慢地、一笔一画地写，字虽然小，却端端正正。老师看了，在本子上画了一颗亮闪闪的星。\n从那以后，文具盒里再也没有人笑它矮了。铅笔说：“只要我们愿意帮忙，多短的铅笔也能写出漂亮的字。”",
  },
];

export const useStoryStore = defineStore("story", () => {
  const stories = ref<StoryRow[]>([]);
  const readTitles = ref<string[]>([]);
  const current = ref<{ id: number; title: string; text: string } | null>(null);
  const generating = ref(false);
  const lastError = ref("");

  const timer = ref<{ running: boolean; endAt: number }>({ running: false, endAt: 0 });
  const now = ref(Date.now());
  let tick: number | null = null;

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

  async function generate(): Promise<StoryRow | null> {
    const ui = useUiStore();
    if (generating.value) return null;
    generating.value = true;
    lastError.value = "";
    try {
      const r = await api.generateStory(readTitles.value);
      const row: StoryRow = { id: r.id, title: r.title, text: r.text, createdAt: new Date().toISOString() };
      stories.value = [row, ...stories.value];
      if (!readTitles.value.includes(r.title)) readTitles.value = [...readTitles.value, r.title];
      current.value = { id: row.id, title: row.title, text: row.text };
      ui.toast(`新童话《${r.title}》来啦，一起读一读吧`);
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

  function loadSample(index = 0): void {
    const s = SAMPLE_STORIES[index % SAMPLE_STORIES.length];
    current.value = { id: -1 - index, title: s.title, text: s.text };
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
    lastError,
    timer,
    timerClock,
    timerRemain,
    applySnapshot,
    refresh,
    generate,
    load,
    loadSample,
    remove,
    startTimer,
    stopTimer,
    finishTimerEarly,
    resumeTimer,
  };
});
