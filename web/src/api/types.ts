/**
 * 后端接口的数据类型（与 server/src 的返回结构一一对应）
 */

export type TaskKey = "math" | "dictation" | "reading" | "language" | "video" | "review";
export type WrongType = "math" | "chinese";
export type MasteryState = 0 | 1;

/* -------------------------------------------------------------- 访问鉴权 */

/**
 * 访问鉴权状态（GET /api/auth/me）。
 *
 * 三个字段配合起来才说得清「现在能不能用」：
 *   · enabled=false              → 后端没开鉴权，怎么都放行
 *   · enabled=true, authed=true  → 要么人在内网（自动家长级），要么已登录
 *   · enabled=true, authed=false → 公网且没登录，前端要弹口令框
 */
export interface AuthStatus {
  enabled: boolean;
  authed: boolean;
  /** 已登录时的角色；内网未登录时会直接给 "parent"（内网 = 家长级权限） */
  role: "child" | "parent" | "";
  /** 本次请求是否来自家庭内网 */
  lan: boolean;
  /** 本次请求是否被当作公网处理（= 公网那套规则已生效） */
  exposed: boolean;
  /** 登录成功时才有 */
  expiresAt?: number;
}

/**
 * 登录 / 未启用鉴权时的返回（POST /api/auth/login）。
 *
 * 刻意不复用 AuthStatus：这一趟的语义就是「现在已通过」，后端不会回 lan/exposed。
 * 硬套 AuthStatus 会让调用方以为 r.lan 存在，是个会骗人的类型。
 */
export interface LoginResult {
  enabled: boolean;
  authed: boolean;
  role: "child" | "parent";
  expiresAt?: number;
}

export interface LessonChar {
  id?: number;
  ch: string;
  word: string;
  pinyin: string;
  sortNo?: number;
  hidden?: boolean;
}

export interface Lesson {
  id: number;
  title: string;
  unit: string;
  sortNo: number;
  note?: string;
  /** 课文原文全文（第 1 页展示 + 朗读 + 生字红标） */
  content: string;
  chars: LessonChar[];
}

export interface MathQuestion {
  a: number;
  b: number;
  op: string;
  /** 用于展示的题干，例如 "7 × 8 =" */
  text: string;
  ans: number;
}

export interface MathSetState {
  date: string;
  qs: MathQuestion[];
  results: Record<string, string>;
}

export interface DailyState {
  date: string;
  tasks: Record<string, boolean>;
  reviewCount: number;
  /** null = 还没开闸（口算/听写没做完）；0 = 开闸了但没错题；n = 要重做 n 道 */
  reviewTarget: number | null;
}

export interface WrongItem {
  id: number;
  type: WrongType;
  refKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface StoryRow {
  id: number;
  title: string;
  text: string;
  createdAt: string;
}

/** 收藏的故事（正文随收藏一起存，历史故事删了也还能重读） */
export interface StoryFav {
  id: number;
  title: string;
  text: string;
  favAt: string;
}

/** 语言强化训练里出现过的词语（跨天汇总，按最近出现日期倒序） */
export interface LearnedWord {
  word: string;
  meaning: string;
  example: string;
  theme: string;
  date: string;
  times: number;
}

/* ------------------------------------------------------------ 语言强化 */

/** 交互方式：choice/fill/order 由系统自动判卷；open 由孩子口述 + 家长判定 */
export type LanguageMode = "choice" | "fill" | "order" | "open";

export interface LanguageQuestion {
  id: number;
  type: string;
  /** 中文题型名（服务端补全） */
  typeName: string;
  icon: string;
  ability: string;
  subAbility: string;
  difficulty: number;
  mode: LanguageMode;
  /** 这题怎么玩（服务端生成的一句话说明） */
  howTo: string;
  question: string;
  /** 自动判卷的答案：choice/fill 为字符串，order 为正确顺序的句子数组 */
  answer: string | string[];
  options: string[];
  /** 排序题的**打乱后**句子（展示用） */
  sentences: string[];
  /** 开放题参考答案 */
  reference: string;
  referenceList: string[];
  guideQuestions: string[];
  word: string;
  meaning: string;
  collocation: string;
  example: string;
  baseSentence: string;
  wrongSentence: string;
  errorType: string;
  errorTypeName: string;
  orderType: string;
  fullParagraph: string;
  keywords: string[];
  requirements: Record<string, unknown> | null;
  imagePrompt: string;
  imageElements: Record<string, unknown> | null;
  observationQuestions: string[];
  hint: string;
  analysis: string;
  answerType: string;
  tags: string[];
}

export interface LanguageSet {
  date: string;
  theme: string;
  grade: number;
  difficulty: number;
  trainingGoal: string;
  questions: LanguageQuestion[];
  createdAt: string;
  model: string;
  ms: number;
}

export interface LanguageProgressEntry {
  questionId: number;
  status: "done" | "wrong";
  judgedBy: "auto" | "parent";
  answer: string;
  attempts: number;
  at: string;
}

export type LanguageProgress = Record<string, LanguageProgressEntry>;

/**
 * 看图题的配图（文生图模型画的真实图片）。
 *
 * 图片落在后端磁盘上（厂商给的地址只有 24 小时有效，不能直接给前端用），
 * 这里只拿到我们自己后端的地址；`version` 是文件的场景哈希，
 * 换过主题重画之后地址里的版本号会变，浏览器不会拿到上一张旧图。
 */
export interface LanguageImageInfo {
  /** 图片是否已经在磁盘上（false = 还没画好，或文件丢了） */
  ready: boolean;
  /** 可直接用于 <img src> 的地址 */
  url: string;
  version: string;
  model: string;
  createdAt: string;
}

/** 当天的题集 + 作答进度（没有题集时 set 为 null） */
export interface LanguageToday {
  date: string;
  set: LanguageSet | null;
  progress: LanguageProgress;
  /** 最近用过的主题（生成时会避开） */
  themes: string[];
  /** 当天看图题的配图；从没画过时为 null */
  image: LanguageImageInfo | null;
  /**
   * 打卡状态与余额。
   * 「9 道题全做完」这件事由**后端**判定并回写打卡标记（前端只做即时反馈），
   * 所以打开页面时要用这里返回的 daily 覆盖本地那份，免得两边对不上。
   */
  daily: DailyState;
  balance: number;
  /** 后端算出来的当天进度（total 恒为 9，没有题集时为 0） */
  counts: { total: number; done: number };
}

export interface TimerState {
  running: boolean;
  endAt: number;
}

/* -------------------------------------------------------------- 英文故事 */

/** 目录里的一集视频 */
export interface VideoItemInfo {
  /** 用作播放地址的标识（服务端 base64url，前端只当字符串透传） */
  id: string;
  /** 展示用标题（文件名收拾干净后的样子） */
  title: string;
  /** 原始文件名，家长排查时更有用 */
  name: string;
  ext: string;
  sizeMB: number;
}

/** 当天这一集的观看记录 */
export interface VideoWatchInfo {
  itemId: string;
  title: string;
  /** 实看秒数（只有真正在播放时累加，拖进度条不算） */
  watchedSec: number;
  durationSec: number;
  /** 今天是否已经完整看完过一集 */
  complete: boolean;
  completeTitle: string;
  hasItem: boolean;
}

/** 英文故事页面的初始状态 */
export interface VideoToday {
  date: string;
  /** 配置里关掉了整个功能 */
  enabled: boolean;
  /** 目录读不了的原因（共享没挂上 / 路径写错 / 没权限）；正常为空串 */
  problem?: string;
  /** 目录里可播的总集数 */
  total?: number;
  /** 还没看过的集数（抽片优先抽这些） */
  unwatched?: number;
  /** 现在该放哪一集；目录空了 / 读不到时为 null */
  item?: VideoItemInfo | null;
  watch?: VideoWatchInfo | null;
  daily: DailyState;
  balance: number;
}

/** 一条积分兑换记录（孩子用积分换的奖励，家长线下兑现） */
export interface Redemption {
  id: number;
  reward: string;
  cost: number;
  createdAt: string;
}

/** 兑换累计统计：总共换了多久平板、多少钱 */
export interface RedemptionStats {
  screenCount: number;
  screenMinutes: number;
  moneyCount: number;
  moneyYuan: number;
}

/** 兑换历史分页响应（积分页用） */
export interface RedemptionHistory {
  balance: number;
  items: Redemption[];
  total: number;
  page: number;
  pageSize: number;
  stats: RedemptionStats;
}

/** 一条积分流水（delta 正数加分、负数扣分） */
export interface PointsLedgerEntry {
  id: number;
  delta: number;
  reason: string;
  refKey: string;
  createdAt: string;
}

export interface StateSnapshot {
  date: string;
  daily: DailyState;
  mathSet: MathSetState | null;
  /** 当天口算累计用时（毫秒）。前端只负责暂停时回写总数，服务端不做累加。 */
  mathElapsedMs: number;
  mastery: Record<string, Record<string, MasteryState>>;
  wrong: { math: WrongItem[]; chinese: WrongItem[] };
  stories: StoryRow[];
  readTitles: string[];
  timer: TimerState;
  /** 当前积分余额（跨天累计钱包） */
  balance: number;
  /** 最近的兑换记录 */
  redemptions: Redemption[];
  /** 语言强化当天的进度（首页任务卡「已完成 N / 9 题」用） */
  language: { total: number; done: number };
}

export type MarkStatus = "pending" | "running" | "done" | "failed";

export interface MarkItem {
  index: number;
  target: string;
  correct: boolean | null;
  written: string;
  score: number | null;
  comment: string;
  reviewedBy: string;
}

export interface MarkTaskView {
  taskId: number;
  status: MarkStatus;
  degraded: boolean;
  error: string;
  errorKind: string;
  items: MarkItem[];
  createdAt: string;
  finishedAt: string | null;
}

export interface HealthInfo {
  version: string;
  uptimeMs: number;
  db: { driver: string; lessons: number; chars: number };
  llm: {
    baseUrl: string;
    apiKey: string;
    storyModel: string;
    markModel: string;
    suggestModel: string;
    chatUrl: string;
    /** 生效密钥的脱敏形态（如 "sk-…abcd"），前端用于「已配置，留空则不修改」占位提示 */
    storyApiKeyMasked: string;
    markApiKeyMasked: string;
  };
  /** 文生图（语言强化看图题的配图） */
  imagegen: {
    enabled: boolean;
    model: string;
    url: string;
    size: string;
    timeoutMs: number;
    /** 脱敏后的密钥来源说明 */
    apiKey: string;
    ok: boolean;
    /** 磁盘上现存几张图 */
    files: number;
  };
  tts: {
    provider: string;
    voice: string;
    rate: string;
    cacheDir: string;
    cacheCount: number;
    cacheBytes: number;
  };
  server: { port: number; host: string; authEnabled: boolean };
  warnings: string[];
}

export interface LogRow {
  ts: number;
  at: string;
  level: string;
  mod: string;
  msg: string;
  fields: Record<string, unknown>;
  text: string;
}

export interface DiagCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DiagReport {
  checks: DiagCheck[];
  llm: Record<string, unknown>;
  tts: Record<string, unknown>;
  db: { driver: string; ok: boolean; error: string };
  warnings: string[];
}

export interface TtsStats {
  count: number;
  bytes: number;
  mb: number;
  dir: string;
  maxMB: number;
}

export interface PrewarmJob {
  id: string;
  lessonId: number;
  total: number;
  done: number;
  ok: number;
  failed: number;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  error: string;
}

/** 业务错误：带上后端给的 kind，便于前端给出针对性提示 */
export class ApiError extends Error {
  status: number;
  kind: string;
  detail: unknown;

  constructor(message: string, status: number, kind = "", detail: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
    this.detail = detail;
  }
}
