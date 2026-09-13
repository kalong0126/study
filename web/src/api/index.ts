/**
 * 后端接口封装
 *
 * 约定：
 *   · 后端统一返回 { ok:true, ...数据 } / { ok:false, error, kind?, detail? }
 *   · 前端一律用相对路径 /api（开发时由 Vite 代理到 8788，生产由后端或 nginx 托管）
 *   · 密钥、模型、超时全部在后端，前端不持有任何配置
 */
import {
  ApiError,
  type DailyState,
  type DiagReport,
  type HealthInfo,
  type Lesson,
  type LogRow,
  type MarkTaskView,
  type MathQuestion,
  type MathSetState,
  type PrewarmJob,
  type StateSnapshot,
  type StoryRow,
  type TimerState,
  type TtsStats,
  type WrongItem,
  type WrongType,
} from "./types";

const BASE = "/api";

interface Envelope {
  ok?: boolean;
  error?: string;
  kind?: string;
  detail?: unknown;
  [k: string]: unknown;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    // fetch 本身失败 = 连不上后端（服务没起 / 不在同一个网络）
    throw new ApiError(
      `连不上学习台服务（${(e as Error).message}）。请确认后端已启动，且这台设备与服务器在同一网络。`,
      0,
      "offline",
      e,
    );
  }

  if (res.status === 204) return undefined as T;

  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new ApiError(`服务返回了非 JSON 响应（HTTP ${res.status}）${text.slice(0, 120)}`, res.status, "protocol");
    }
    return text as unknown as T;
  }

  const data = (await res.json()) as Envelope;
  if (!res.ok || data.ok === false) {
    throw new ApiError(data.error || `请求失败（HTTP ${res.status}）`, res.status, data.kind ?? "", data.detail ?? null);
  }
  return data as unknown as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
};

/* ------------------------------------------------------------------ 健康与内容 */

export const api = {
  health: () => request<HealthInfo>("/health"),

  listLessons: () => request<{ lessons: Lesson[] }>("/lessons").then((r) => r.lessons),

  listState: (date?: string, storyLimit = 30) =>
    request<StateSnapshot>(`/state${qs({ date, storyLimit })}`),

  /* ---------------------------------------------------------------- 打卡 */

  patchDaily: (body: { date?: string; tasks?: Record<string, boolean>; reviewCount?: number; reviewTarget?: number | null }) =>
    request<{ daily: DailyState }>("/state/daily", { method: "PATCH", body: JSON.stringify(body) }),

  /** 错题复习开闸：把这一轮的目标题数定死（幂等，已定过就原样返回） */
  openReview: (body: { date?: string } = {}) =>
    request<{ daily: DailyState }>("/state/review/open", { method: "POST", body: JSON.stringify(body) }),

  /* ---------------------------------------------------------------- 口算 */

  createMathSet: (body: { date?: string; qs: MathQuestion[]; results?: Record<string, string> }) =>
    request<{ mathSet: MathSetState | null; mathElapsedMs: number }>("/state/math", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  setMathResult: (body: { date?: string; idx: number; value: string }) =>
    request<{ results: Record<string, string>; correct: number; answered: number }>("/state/math", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /** 口算计时：回写**当天累计毫秒总数**（幂等覆盖，不是增量） */
  setMathElapsed: (body: { date?: string; ms: number }) =>
    request<{ mathElapsedMs: number }>("/state/math/elapsed", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /* -------------------------------------------------------------- 掌握度 */

  setMastery: (body: { lessonId: number; ch: string; state: 0 | 1 | null }) =>
    request<{ mastery: Record<string, Record<string, 0 | 1>> }>("/state/mastery", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /* -------------------------------------------------------------- 错题本 */

  addWrong: (body: { type: WrongType; refKey: string; payload?: Record<string, unknown> }) =>
    request<{ id: number | null; duplicated: boolean }>("/state/wrong", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  clearWrong: (body: { all?: boolean; id?: number; type?: WrongType; refKey?: string }) =>
    request<{ removed: number; wrong: { math: WrongItem[]; chinese: WrongItem[] } }>("/state/wrong/clear", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /* ------------------------------------------------------------ 故事与计时 */

  generateStory: (avoidTitles: string[] = []) =>
    request<{ id: number; title: string; text: string; charCount: number; avoidCount: number; ms: number; model: string }>(
      "/story/generate",
      { method: "POST", body: JSON.stringify({ avoidTitles }) },
    ),

  listStories: (limit = 30) =>
    request<{ stories: StoryRow[]; readTitles: string[] }>(`/stories${qs({ limit })}`),

  deleteStory: (title: string) =>
    request<{ removed: number; stories: StoryRow[]; readTitles: string[] }>("/state/story/delete", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  setTimer: (timer: TimerState) =>
    request<{ timer: TimerState }>("/state/timer", { method: "PATCH", body: JSON.stringify(timer) }),

  /* ---------------------------------------------------------------- 判卷 */

  createMarkTask: (body: {
    lessonId?: number | null;
    mode: "composite" | "each";
    targets: string[];
    image?: string;
    images?: string[];
  }) =>
    request<{ taskId: number; status: string; count: number; mode: string }>("/mark", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getMarkTask: (taskId: number) => request<{ task: MarkTaskView }>(`/mark/${taskId}`).then((r) => r.task),

  reviewMarkTask: (taskId: number, items: { index: number; correct: boolean }[]) =>
    request<{ task: MarkTaskView }>(`/mark/${taskId}/review`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }).then((r) => r.task),

  /* ------------------------------------------------------------------ 语音 */

  /** 直接当音频 URL 用（<audio src> 或 fetch 成 Blob） */
  ttsUrl: (text: string, kind: "word" | "char" | "sentence" = "word") =>
    `${BASE}/tts${qs({ text, kind })}`,

  /** 指定音色的试听 URL（家长后台选音色时用，不落缓存） */
  ttsPreviewUrl: (voice: string, text = "你好，我是朗读小助手，很高兴为你朗读课文。") =>
    `${BASE}/tts/preview${qs({ voice, text })}`,

  prewarm: (lessonId: number) =>
    request<{ jobId: string; total: number; status: string }>("/tts/prewarm", {
      method: "POST",
      body: JSON.stringify({ lessonId }),
    }),

  prewarmStatus: (jobId: string) => request<{ job: PrewarmJob }>(`/tts/prewarm/${jobId}`).then((r) => r.job),

  ttsStats: () => request<TtsStats>("/tts/stats"),

  /* ------------------------------------------------------------------ 备份 */

  backupUrl: () => `${BASE}/backup`,

  backupList: () => request<{ files: { file: string; kb: number; at: string }[] }>("/backup/list").then((r) => r.files),

  runBackup: () => request<{ file: string; kb: number }>("/backup/run", { method: "POST" }),

  restore: (pack: unknown, mode: "merge" | "replace" = "merge", skipDemo = true) =>
    request<{ summary: Record<string, unknown> }>("/restore", {
      method: "POST",
      body: JSON.stringify({ pack, mode, skipDemo }),
    }).then((r) => r.summary),

  /* ------------------------------------------------------------------ 诊断 */

  logs: (limit = 120, level?: string) =>
    request<{ logs: LogRow[]; stats: Record<string, unknown>; now: string }>(`/diag/logs${qs({ limit, level })}`),

  clearLogs: () => request<{ cleared: boolean }>("/diag/logs", { method: "DELETE" }),

  diagLlm: () => request<DiagReport>("/diag/llm"),

  diagLlmTest: (which: "story" | "mark" = "story") =>
    request<{ which: string; model: string; reply: string; ms: number }>("/diag/llm-test", {
      method: "POST",
      body: JSON.stringify({ which }),
    }),

  diagTtsTest: (text = "你好，我是朗读小助手") =>
    request<{ text: string; bytes: number; cached: boolean; ms: number; rate: string }>(
      `/diag/tts-test${qs({ text })}`,
    ),
};

/* -------------------------------------------------------- 家长内容后台 */

export const adminApi = {
  listLessons: () => request<{ lessons: Lesson[]; seedStats: Record<string, unknown> }>("/admin/lessons"),

  getLesson: (id: number) => request<{ lesson: Lesson }>(`/admin/lessons/${id}`).then((r) => r.lesson),

  createLesson: (body: { title: string; unit?: string; note?: string; content?: string; sortNo?: number }) =>
    request<{ id: number; lesson: Lesson }>("/admin/lessons", { method: "POST", body: JSON.stringify(body) }),

  updateLesson: (id: number, body: { title?: string; unit?: string; note?: string; content?: string; sortNo?: number }) =>
    request<{ lesson: Lesson }>(`/admin/lessons/${id}`, { method: "PUT", body: JSON.stringify(body) }).then((r) => r.lesson),

  deleteLesson: (id: number) => request<{ deleted: number }>(`/admin/lessons/${id}`, { method: "DELETE" }),

  bulkChars: (id: number, text: string) =>
    request<{ added: number; skipped: number; rows: { ch: string }[]; lesson: Lesson }>(
      `/admin/lessons/${id}/chars/bulk`,
      { method: "POST", body: JSON.stringify({ text }) },
    ),

  replaceChars: (id: number, chars: { ch: string; word: string }[]) =>
    request<{ lesson: Lesson }>(`/admin/lessons/${id}/chars`, {
      method: "PUT",
      body: JSON.stringify({ chars }),
    }).then((r) => r.lesson),

  updateChar: (id: number, ch: string, body: { word?: string; hidden?: boolean }) =>
    request<{ lesson: Lesson }>(`/admin/lessons/${id}/chars/${encodeURIComponent(ch)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }).then((r) => r.lesson),

  deleteChar: (id: number, ch: string) =>
    request<{ lesson: Lesson }>(`/admin/lessons/${id}/chars/${encodeURIComponent(ch)}`, {
      method: "DELETE",
    }).then((r) => r.lesson),

  suggestWords: (id: number, onlyEmpty = true) =>
    request<{ cands: Record<string, string[]>; targets?: string[]; reason?: string; ms?: number }>(
      `/admin/lessons/${id}/words/suggest`,
      { method: "POST", body: JSON.stringify({ onlyEmpty }) },
    ),

  clearTtsCache: () =>
    request<{ removed: number; mb: number }>("/admin/tts/clear", { method: "POST" }),

  /** 语音缓存统计（后台里跟课文编辑一起用） */
  ttsStats: () => api.ttsStats(),

  /** 保存课文后异步预热该课全部音频（组词 + 单字） */
  prewarm: (lessonId: number) => api.prewarm(lessonId),

  prewarmStatus: (jobId: string) => api.prewarmStatus(jobId),

  voices: () =>
    request<{ voices: { name: string; gender: string }[]; current: string }>("/admin/voices"),

  /** 切换 TTS 音色（选中即生效，持久化，下次重启自动恢复） */
  setVoice: (voice: string) =>
    request<{ voice: string }>("/admin/tts/voice", { method: "POST", body: JSON.stringify({ voice }) }),

  seed: (reset = false) => request<{ result: Record<string, unknown> }>("/admin/seed", {
    method: "POST",
    body: JSON.stringify({ reset }),
  }),

  /** 重置学习数据：scope=today 仅清今天；scope=all 清全部（保留课文/生字/掌握度） */
  reset: (scope: "today" | "all" = "today", date?: string) =>
    request<{
      scope: "today" | "all";
      removed: { daily: number; math: number; kv: number; wrong?: number; stories?: number; reads?: number; marks?: number };
      date: string;
    }>("/admin/reset", { method: "POST", body: JSON.stringify({ scope, date }) }),
};

/* ------------------------------------------------------------ 错误文案 */

/**
 * 把后端错误翻译成「孩子能懂 / 家长能动手」的一句话。
 * 后端的 kind 已经分好了类，这里只负责说人话。
 */
export function describeApiError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  switch (e.kind) {
    case "offline":
      return e.message;
    case "config":
      return `后端配置有问题：${e.message}（家长请检查 config.yaml）`;
    case "timeout":
      return `大模型响应超时：${e.message}。稍后再试，或在 config.yaml 里放宽 llm.timeoutMs`;
    case "network":
      return `访问大模型失败：${e.message}。请确认服务器能上外网，且 llm.baseUrl 正确`;
    case "http":
      return `大模型接口报错：${e.message}。多为密钥无效、余额不足或模型名写错`;
    case "parse":
      return `模型返回的内容看不懂：${e.message}`;
    case "empty":
      return `模型没有返回内容：${e.message}`;
    case "tts.timeout":
    case "tts.provider":
    case "tts.empty":
      return `语音合成失败：${e.message}`;
    case "tts.noinput":
      // 请求里没有可朗读的字（纯标点/空文本）。这不是故障，别让家长以为语音坏了。
      return `这段内容没有可朗读的字（${e.message}），已跳过`;
    default:
      return e.message;
  }
}
