/**
 * 界面状态：轻提示（toast）、庆祝横幅（banner）、彩带特效、诊断抽屉开关。
 *
 * 这一层不碰业务数据，只负责「给孩子的即时反馈」，所以独立成 store。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { burst, burstBig } from "@/composables/useConfetti";
import { playTada } from "@/composables/useSound";

export const useUiStore = defineStore("ui", () => {
  /* ------------------------------------------------------------ 轻提示 */
  const toastText = ref("");
  const toastOn = ref(false);
  let toastTimer: number | null = null;

  function toast(msg: string): void {
    toastText.value = msg;
    toastOn.value = true;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastOn.value = false;
    }, 2200);
  }

  /* ------------------------------------------------------------ 庆祝横幅 */
  const bannerOn = ref(false);
  const bannerGold = ref(false);
  const bannerTitle = ref("你太棒了！🎉");
  const bannerSub = ref("今日 4 项任务全部完成");
  let bannerTimer: number | null = null;

  function showBanner(title: string, sub: string, gold = false, ms = 2600): void {
    bannerTitle.value = title;
    bannerSub.value = sub;
    bannerGold.value = gold;
    // 先关再开，让连续触发也能看到动画
    bannerOn.value = false;
    void document.body.offsetWidth;
    bannerOn.value = true;
    if (bannerTimer) window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => {
      bannerOn.value = false;
      bannerGold.value = false;
    }, ms);
  }

  /** 普通庆祝：彩带 + 四连音，可选横幅 */
  function celebrate(opts: { title?: string; sub?: string } = {}): void {
    burst();
    playTada();
    if (opts.title) showBanner(opts.title, opts.sub ?? "");
  }

  /** 满分庆祝：金色大横幅 + 双倍彩带 */
  function celebratePerfect(sub: string): void {
    burstBig();
    playTada();
    showBanner("全部答对，满分！🎉", sub, true, 3800);
  }

  /* ------------------------------------------------------------ 诊断抽屉 */
  const diagOpen = ref(false);
  function openDiag(): void {
    diagOpen.value = true;
  }
  function closeDiag(): void {
    diagOpen.value = false;
  }

  return {
    toastText,
    toastOn,
    toast,
    bannerOn,
    bannerGold,
    bannerTitle,
    bannerSub,
    showBanner,
    celebrate,
    celebratePerfect,
    diagOpen,
    openDiag,
    closeDiag,
  };
});
