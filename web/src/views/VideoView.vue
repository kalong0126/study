<script setup lang="ts">
/**
 * 英文故事：随机抽一集共享目录里的 mp4 来播
 *
 * 为什么视频要绕后端一圈：浏览器既读不了 `file://`，也打不开 `\\NAS\共享\...` 这种
 * SMB 路径。后端把文件当普通文件读出来、按 HTTP Range 分段发（见 `server/src/routes/video.ts`），
 * 这里就是一个普通的 `<video src="/api/video/stream/xxx">`。
 *
 * 积分规则（**后端说了算，这里只负责上报**）：
 *   · 只有**真正在播放**时累加秒数 —— 暂停、切后台、拖进度条都不算
 *     （timeupdate 前后两次的增量 > 2 秒就当成跳转丢弃）
 *   · 实看 ≥ 90% 时长才算「完整看完」→ 打卡 + 10 分（每天一次，后端按 ref_key 幂等）
 *   所以「拖到最后」骗不到这 10 分，而孩子中途去喝水回来接着看也不吃亏。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "@/components/Icon.vue";
import { api, describeApiError } from "@/api";
import type { VideoItemInfo } from "@/api/types";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";
import { lsGet, lsSet } from "@/utils/local";

const progress = useProgressStore();
const ui = useUiStore();

const videoEl = ref<HTMLVideoElement | null>(null);

const loading = ref(true);
const errorText = ref("");
const enabled = ref(true);
const problem = ref("");
const item = ref<VideoItemInfo | null>(null);
const total = ref(0);
const unwatched = ref(0);

const playing = ref(false);
const current = ref(0);
const duration = ref(0);
const complete = ref(false);
const completeTitle = ref("");

/** 真正播放过的秒数（后端据此判是否看完） */
const watchedSec = ref(0);
/** 上一次 timeupdate 时的时间点；-1 表示刚跳转过，下一次只对齐不累加 */
let lastT = -1;
let tick: number | null = null;
let flushing = false;

const src = computed(() => (item.value ? api.videoStreamUrl(item.value.id) : ""));
const watchedPct = computed(() =>
  duration.value > 0 ? Math.min(100, Math.round((watchedSec.value / duration.value) * 100)) : 0,
);
/** 还差多少才算看完（给孩子一个看得懂的目标） */
const needPct = computed(() => Math.max(0, 90 - watchedPct.value));

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------ 播放位置记忆 */

/**
 * 中途退出再回来能接着看。位置只存在**本机**（localStorage），按天 + 集号记，
 * 换一集就作废。不放到后端是因为「播放位置」和「实看秒数」不是一回事：
 * 孩子往回拖过进度条，两者就会差很远，混用会让计分变得莫名其妙。
 */
const POS_KEY = "videoPos";

function savedPos(id: string): number {
  const saved = lsGet<{ date: string; id: string; pos: number } | null>(POS_KEY, null);
  if (!saved || saved.id !== id) return 0;
  return Number(saved.pos) || 0;
}

function rememberPos(): void {
  if (!item.value) return;
  const v = videoEl.value;
  lsSet(POS_KEY, { date: progress.date, id: item.value.id, pos: v?.currentTime ?? 0 });
}

/* ------------------------------------------------------------------ 上报 */

/** 把当前进度报给后端（后端据此判打卡 + 发 10 分）；失败不打扰孩子，下一次 tick 会再报 */
async function flush(ended = false): Promise<void> {
  if (!item.value || flushing || !enabled.value) return;
  flushing = true;
  const before = complete.value;
  try {
    const r = await api.videoProgress({
      date: progress.date,
      id: item.value.id,
      watchedSec: Math.round(watchedSec.value),
      durationSec: Math.round(duration.value),
      ended,
    });
    if (r.watch) {
      complete.value = !!r.watch.complete;
      completeTitle.value = r.watch.completeTitle || item.value.title;
    }
    // 先让 store 打勾（它会顺手处理「今天全部完成」的横幅），再用后端返回的状态覆盖本地
    await progress.syncVideo(complete.value);
    progress.applyDaily(r.daily, r.balance);
    if (complete.value && !before) {
      ui.celebratePerfect(`看完啦！这一次得到 10 分`);
    }
  } catch {
    /* 上报失败无所谓，下次 tick / 暂停时再报 */
  } finally {
    flushing = false;
  }
}

/* -------------------------------------------------------------- 播放控制 */

function toggle(): void {
  const v = videoEl.value;
  if (!v) return;
  if (v.paused) void v.play().catch(() => ui.toast("按一下播放按钮就能开始看了"));
  else v.pause();
}

function onTimeUpdate(): void {
  const v = videoEl.value;
  if (!v) return;
  current.value = v.currentTime;
  if (lastT < 0) {
    lastT = v.currentTime;
    return;
  }
  if (v.paused || v.seeking) return;
  const d = v.currentTime - lastT;
  // 正常播放每次推进 0.2~1 秒；一旦跨度很大说明是拖动进度条或跳转，不能算「看过」
  if (d > 0 && d < 2) watchedSec.value += d;
  lastT = v.currentTime;
}

function onSeeking(): void {
  lastT = -1;
}

function onPlay(): void {
  playing.value = true;
  lastT = -1;
}

function onPause(): void {
  playing.value = false;
  rememberPos();
  void flush();
}

function onEnded(): void {
  playing.value = false;
  rememberPos();
  void flush(true);
}

function onLoaded(): void {
  const v = videoEl.value;
  if (!v || !item.value) return;
  duration.value = Number.isFinite(v.duration) ? v.duration : 0;
  const pos = savedPos(item.value.id);
  if (pos > 5 && (!duration.value || pos < duration.value - 3)) {
    v.currentTime = pos;
    current.value = pos;
  }
  lastT = -1;
}

function onSeekInput(e: Event): void {
  const v = videoEl.value;
  if (!v) return;
  const t = Number((e.target as HTMLInputElement).value);
  v.currentTime = t;
  current.value = t;
  lastT = -1;
}

function onSeekEnd(): void {
  rememberPos();
  void flush();
}

/* ------------------------------------------------------------------ 载入 */

async function load(force = false): Promise<void> {
  loading.value = true;
  errorText.value = "";
  try {
    if (force) await api.videoRescan().catch(() => undefined);
    const r = await api.videoToday(progress.date);
    enabled.value = r.enabled;
    problem.value = r.problem ?? "";
    total.value = r.total ?? 0;
    unwatched.value = r.unwatched ?? 0;
    item.value = r.item ?? null;
    complete.value = !!r.watch?.complete;
    completeTitle.value = r.watch?.completeTitle ?? "";
    progress.applyDaily(r.daily, r.balance);
    // 没有视频源就别把 watchedSec 清掉（同一集内重载不该丢进度）
    watchedSec.value = 0;
    current.value = 0;
    duration.value = 0;
    lastT = -1;
  } catch (e) {
    errorText.value = describeApiError(e);
  } finally {
    loading.value = false;
  }
}

/** 换一个：抽一集别的（后端优先给没看过的） */
async function next(): Promise<void> {
  if (!enabled.value) return;
  try {
    const r = await api.videoNext(progress.date);
    item.value = r.item;
    complete.value = !!r.watch?.complete;
    completeTitle.value = r.watch?.completeTitle ?? "";
    progress.applyDaily(r.daily, r.balance);
    watchedSec.value = 0;
    current.value = 0;
    duration.value = 0;
    lastT = -1;
    playing.value = false;
    ui.toast("换了一集，慢慢看～");
  } catch (e) {
    ui.toast(describeApiError(e));
  }
}

onMounted(async () => {
  await load();
  // 每 15 秒报一次进度：孩子直接关页面 / 平板没电，最多只丢 15 秒的实看时间
  tick = window.setInterval(() => {
    if (playing.value) {
      rememberPos();
      void flush();
    }
  }, 15_000);
});

onBeforeUnmount(() => {
  if (tick !== null) window.clearInterval(tick);
  tick = null;
  rememberPos();
  void flush();
});
</script>

<template>
  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #E4F7F5; color: #2FA8A0">
        <Icon name="video" :size="19" />
      </span>
      <div>
        <h2>英文故事</h2>
        <span class="sub">
          <template v-if="complete">今天已经看完一集啦，还想看就点「换一个」</template>
          <template v-else>看完一集可以得 10 分</template>
        </span>
      </div>
    </div>

    <p v-if="loading" class="tip">正在找视频…</p>

    <p v-else-if="errorText" class="tip">{{ errorText }}</p>

    <template v-else-if="!enabled">
      <p class="tip">英文故事暂时关掉了。家长可以在 config.yaml 里把 video.enabled 改成 true 打开。</p>
    </template>

    <template v-else-if="problem">
      <p class="tip">暂时看不到视频：{{ problem }}</p>
      <p class="tip">（家长可以检查一下共享有没有挂上 / 那台机器有没有开机）</p>
      <button class="btn" type="button" @click="load(true)">再试一次</button>
    </template>

    <template v-else-if="!item">
      <p class="tip">这个目录里还没有能播放的视频（只支持 mp4 / webm / mov）。</p>
      <p class="tip">家长往目录里放几个 mp4 就能看了。</p>
      <button class="btn" type="button" @click="load(true)">重新扫描</button>
    </template>

    <template v-else>
      <div class="vt">
        <video
          ref="videoEl"
          :src="src"
          preload="metadata"
          playsinline
          webkit-playsinline
          class="vplayer"
          @loadedmetadata="onLoaded"
          @timeupdate="onTimeUpdate"
          @seeking="onSeeking"
          @play="onPlay"
          @pause="onPause"
          @ended="onEnded"
          @click="toggle"
        ></video>

        <button v-if="!playing" class="vbig" type="button" @click="toggle">
          <Icon name="play" :size="30" />
          <span>{{ current > 3 ? "继续看" : "播放" }}</span>
        </button>

        <div v-if="complete" class="vdone">看完啦 +10 分</div>
      </div>

      <div class="vtitle">{{ item.title }}</div>

      <input
        class="vrange"
        type="range"
        min="0"
        :max="duration || 0"
        step="1"
        :value="current"
        aria-label="播放进度"
        @input="onSeekInput"
        @change="onSeekEnd"
      />

      <div class="vmeta">
        <span>{{ clock(current) }} / {{ duration ? clock(duration) : "--:--" }}</span>
        <span v-if="!complete">实看 {{ watchedPct }}%<template v-if="needPct > 0">，再看 {{ needPct }}% 就得分</template></span>
        <span v-else>这一集已经算完成 ✓</span>
      </div>

      <div class="vrow">
        <button class="btn primary vbtn" type="button" @click="toggle">
          <Icon :name="playing ? 'pause' : 'play'" :size="20" />
          <span>{{ playing ? "暂停" : current > 3 ? "继续看" : "播放" }}</span>
        </button>
        <button class="btn vbtn" type="button" @click="next">
          <Icon name="refresh" :size="20" />
          <span>换一个</span>
        </button>
      </div>

      <p class="tip" v-if="total > 0">
        目录里一共有 {{ total }} 集<template v-if="unwatched > 0">，还有 {{ unwatched }} 集没看过</template>。
        <template v-if="completeTitle && completeTitle !== item.title">今天看完的是《{{ completeTitle }}》。</template>
      </p>
    </template>
  </section>
</template>

<style scoped>
.vt {
  position: relative;
  margin: 4px 0 10px;
  background: #0d1b26;
  border-radius: 16px;
  overflow: hidden;
  aspect-ratio: 16 / 9;
}
.vplayer {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  background: #0d1b26;
}
/* 暂停时盖一个大按钮：孩子一眼就知道点哪儿 */
.vbig {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 132px;
  height: 132px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.94);
  color: var(--blue-d);
  font-size: 17px;
  font-weight: 800;
  font-family: inherit;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  cursor: pointer;
}
.vdone {
  position: absolute;
  top: 10px;
  right: 10px;
  background: #7FDCB8;
  color: #166b4c;
  font-size: 13px;
  font-weight: 800;
  padding: 5px 12px;
  border-radius: 999px;
}
.vtitle {
  font-size: 16px;
  font-weight: 800;
  color: var(--ink);
  line-height: 1.3;
  margin-bottom: 8px;
  overflow-wrap: break-word;
}
.vrange {
  width: 100%;
  height: 30px;
  margin: 0;
  accent-color: #2FA8A0;
  cursor: pointer;
}
.vmeta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12.5px;
  color: var(--ink3);
  font-variant-numeric: tabular-nums;
  margin: 2px 0 12px;
}
/* 两个大按钮：平板上手指点得准 */
.vrow {
  display: flex;
  gap: 10px;
}
.vbtn {
  flex: 1;
  min-height: 54px;
  font-size: 16px;
  justify-content: center;
  gap: 6px;
}
</style>
