/**
 * 后端接口的数据类型（与 server/src 的返回结构一一对应）
 */

export type TaskKey = "math" | "dictation" | "reading" | "review";
export type WrongType = "math" | "chinese";
export type MasteryState = 0 | 1;

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

/** 当天的题集 + 作答进度（没有题集时 set 为 null） */
export interface LanguageToday {
  date: string;
  set: LanguageSet | null;
  progress: LanguageProgress;
  /** 最近用过的主题（生成时会避开） */
  themes: string[];
}

export interface TimerState {
  running: boolean;
  endAt: number;
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
