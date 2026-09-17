/**
 * 启动引导：一次拉齐「内容 + 学习数据」，把三个 store 灌满再放行界面。
 *
 * 之所以集中在一个地方做，而不是各视图自己拉：
 *   - 顶栏的进度、导航上的红点、首页的任务列表都依赖全量状态，分散拉会闪
 *   - 口算题组要「没有就生成」，这件事必须只发生一次
 */
import { ref } from "vue";
import { api } from "@/api";
import { useContentStore } from "@/stores/content";
import { useMasteryStore } from "@/stores/mastery";
import { useProgressStore } from "@/stores/progress";
import { useStoryStore } from "@/stores/story";
import { useUiStore } from "@/stores/ui";
import { lsGet, lsSet, todayStr } from "@/utils/local";

export type BootState = "loading" | "ready" | "error" | "locked";

export const bootState = ref<BootState>("loading");
export const bootError = ref("");
/** 口令门上的说明文案（解释为什么突然要输口令） */
export const lockHint = ref("");

export async function bootstrap(): Promise<void> {
  const content = useContentStore();
  const progress = useProgressStore();
  const mastery = useMasteryStore();
  const story = useStoryStore();
  const ui = useUiStore();

  bootState.value = "loading";
  bootError.value = "";
  lockHint.value = "";

  try {
    // 先问一句「要不要口令」—— 必须排在拉数据之前，否则后面每个接口都白跑一趟 401
    const me = await api.authMe();
    if (me.enabled && !me.authed) {
      lockHint.value = "在外网使用需要先输入口令（问家长要）";
      bootState.value = "locked";
      return;
    }

    const [snap] = await Promise.all([api.listState(todayStr(), 30), content.load(true)]);

    mastery.snapshot(snap.mastery, snap.wrong);
    progress.applySnapshot(snap);
    story.applySnapshot(snap);

    if (!content.lessons.length) {
      bootError.value = "后端还没有课文数据。请家长到内容后台导入课文，或重启后端服务自动写入种子数据。";
      bootState.value = "error";
      return;
    }

    await progress.ensureMathSet();
    await progress.syncMathTaskFlag();
    story.resumeTimer();

    bootState.value = "ready";

    if (!lsGet("welcomed", false)) {
      lsSet("welcomed", true);
      window.setTimeout(() => ui.toast("欢迎来到二年级快乐学习台，先做一次口算热热身吧！"), 600);
    }
  } catch (e) {
    bootError.value = e instanceof Error ? e.message : String(e);
    bootState.value = "error";
  }
}

let rolloverBound = false;
/** 跨天（例如平板一直开着）自动刷新当天数据 */
export function bindDayRollover(): void {
  if (rolloverBound) return;
  rolloverBound = true;
  const check = (): void => {
    const progress = useProgressStore();
    if (progress.date !== todayStr()) void bootstrap();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
}
