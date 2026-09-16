/**
 * 配置加载：config/config.yaml → 校验 → 强类型对象
 *
 * 设计要点：
 *  - yaml 里的 ${ENV_VAR} 会从环境变量注入，密钥因此不进 git
 *  - 用 zod 做完整校验，配错了在启动时就报清楚，而不是运行到一半才炸
 *  - 所有相对路径统一解析成绝对路径，避免 cwd 漂移导致找不到缓存目录
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { loadDotEnv, dotEnvCandidates, dotEnvSummary } from "./env.js";
import { SERVER_ROOT } from "./paths.js";

export { SERVER_ROOT, REPO_ROOT } from "./paths.js";

const ConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535).default(8788),
    host: z.string().default("0.0.0.0"),
    corsOrigins: z.array(z.string()).default([]),
    // HTTPS：安卓 Chrome 要「装成应用」（独立窗口、没有地址栏）必须走安全上下文。
    // 内网没有域名、也不想暴露公网，所以用 mkcert 自签证书——见 scripts/https-setup.ps1。
    https: z.object({
      enabled: z.boolean().default(false),
      // 相对路径按 server/ 解析
      certFile: z.string().default("./certs/cert.pem"),
      keyFile: z.string().default("./certs/key.pem"),
    }),
    auth: z.object({
      enabled: z.boolean().default(false),
      childPin: z.string().default(""),
      parentPin: z.string().default(""),
      sessionDays: z.number().int().min(1).default(30),
    }),
  }),

  db: z.object({
    driver: z.enum(["sqlite", "mysql"]).default("sqlite"),
    sqlite: z.object({
      file: z.string().default("./data/grade2.db"),
    }),
    mysql: z.object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(3306),
      database: z.string().default("grade2"),
      user: z.string().default("grade2"),
      password: z.string().default(""),
      connectionLimit: z.number().int().min(1).max(100).default(10),
    }),
  }),

  llm: z.object({
    // —— 默认 provider：下面三个用途没单独配时就都用它 ——
    baseUrl: z.string().default("https://api.deepseek.com/v1"),
    apiKey: z.string().default(""),

    // —— 各用途的模型名 ——
    storyModel: z.string().default("deepseek-chat"),
    markModel: z.string().default(""),
    suggestModel: z.string().default("deepseek-chat"),

    // —— 各用途可选的独立 provider（留空 = 回落到上面的默认值）——
    // 典型场景：故事用便宜的纯文本模型，判卷用另一家的视觉模型，
    // 两家的 baseUrl 和 key 都不一样，所以必须能各配一套。
    storyBaseUrl: z.string().default(""),
    storyApiKey: z.string().default(""),
    markBaseUrl: z.string().default(""),
    markApiKey: z.string().default(""),
    suggestBaseUrl: z.string().default(""),
    suggestApiKey: z.string().default(""),

    timeoutMs: z.object({
      story: z.number().int().default(60000),
      mark: z.number().int().default(90000),
      suggest: z.number().int().default(45000),
    }),
    retries: z.number().int().min(0).max(5).default(1),
    temperature: z.object({
      story: z.number().default(0.9),
      mark: z.number().default(0),
      suggest: z.number().default(0.5),
    }),
  }),

  imagegen: z.object({
    enabled: z.boolean().default(true),
    model: z.string().default("qwen-image-plus"),
    baseUrl: z.string().default(""),
    /** 留空 = 回落 mark（判卷）用途的 Key —— 都是阿里云百炼，一把 Key 通用 */
    apiKey: z.string().default(""),
    size: z.string().default("1328*1328"),
    dir: z.string().default("./data/images"),
    timeoutMs: z.number().int().min(1000).default(120000),
  }),

  tts: z.object({
    provider: z.enum(["edge"]).default("edge"),
    voice: z.string().default("zh-CN-XiaoyiNeural"),
    rate: z.string().default("-12%"),
    volume: z.string().default("+0%"),
    pitch: z.string().default("+0Hz"),
    cacheDir: z.string().default("./data/tts"),
    cacheMaxMB: z.number().int().min(0).default(512),
    maxTextLen: z.number().int().min(1).default(300),
  }),

  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    dir: z.string().default("./logs"),
    keepDays: z.number().int().min(1).default(14),
    redact: z.array(z.string()).default(["apiKey", "password", "authorization", "key"]),
  }),

  backup: z.object({
    enabled: z.boolean().default(true),
    cron: z.string().default("0 3 * * *"),
    dir: z.string().default("./data/backup"),
    keepDays: z.number().int().min(1).default(30),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * 把 ${VAR} / ${VAR:-默认值} 替换成环境变量值。
 * 支持两段式写法后，同一份 config.yaml 就能同时服务本地与容器：
 *   driver: ${DB_DRIVER:-sqlite}   → 本地不设变量走 sqlite，容器里设了就走 mysql
 * 未定义且没写默认值 → 空串（随后由校验/启动警告处理，比如 apiKey）。
 */
function interpolate(raw: string): string {
  return raw.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_m, name: string, fallback?: string) => {
      const v = process.env[name];
      if (v !== undefined && v !== "") return v;
      return fallback ?? "";
    },
  );
}

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(SERVER_ROOT, p);
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * YAML 里「键后面什么都没写」会解析成 null，而不是空字符串。
 * 我们最典型的场景就是 `password: ${DB_PASSWORD}` 在环境变量未设置时插值成空，
 * 于是校验报 "expected string, received null" —— 这不是用户配错了，是 YAML 语义。
 * 所以这里统一把叶子节点的 null 还原成空字符串。
 */
function nullToEmpty(v: unknown): unknown {
  if (v === null) return "";
  if (Array.isArray(v)) return v.map(nullToEmpty);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = nullToEmpty(val);
    return out;
  }
  return v;
}

/**
 * 把缺失的分组补成 {}，让组内字段的 default 能生效。
 * 不这样做的话，yaml 里少写一个 `tts:` 整段就会校验失败——
 * 而「少写一段就用默认值」才是符合直觉的行为。
 */
function normalize(parsed: unknown): Record<string, unknown> {
  const root = obj(parsed);
  const server = obj(root.server);
  const db = obj(root.db);
  const llm = obj(root.llm);
  return {
    server: { ...server, https: obj(server.https), auth: obj(server.auth) },
    db: { ...db, sqlite: obj(db.sqlite), mysql: obj(db.mysql) },
    llm: { ...llm, timeoutMs: obj(llm.timeoutMs), temperature: obj(llm.temperature) },
    imagegen: obj(root.imagegen),
    tts: obj(root.tts),
    logging: obj(root.logging),
    backup: obj(root.backup),
  };
}

let cached: AppConfig | null = null;

export function loadConfig(force = false): AppConfig {
  if (cached && !force) return cached;

  // 必须先读 .env，再插值——否则 ${LLM_API_KEY} 拿到的是空
  loadDotEnv(force);

  const configPath = process.env.CONFIG_PATH
    ? path.resolve(process.env.CONFIG_PATH)
    : path.join(SERVER_ROOT, "config", "config.yaml");

  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到配置文件：${configPath}`);
  }

  const raw = interpolate(fs.readFileSync(configPath, "utf8"));
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    throw new Error(`config.yaml 不是合法 YAML：${(e as Error).message}`);
  }

  const result = ConfigSchema.safeParse(normalize(nullToEmpty(parsed)));
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  · ${i.path.join(".") || "(根)"}：${i.message}`);
    throw new Error(`配置校验失败：\n${lines.join("\n")}`);
  }

  const cfg = result.data;

  // 目录统一解析为绝对路径
  cfg.db.sqlite.file = resolveFromRoot(cfg.db.sqlite.file);
  cfg.server.https.certFile = resolveFromRoot(cfg.server.https.certFile);
  cfg.server.https.keyFile = resolveFromRoot(cfg.server.https.keyFile);
  cfg.tts.cacheDir = resolveFromRoot(cfg.tts.cacheDir);
  cfg.imagegen.dir = resolveFromRoot(cfg.imagegen.dir);
  cfg.logging.dir = resolveFromRoot(cfg.logging.dir);
  cfg.backup.dir = resolveFromRoot(cfg.backup.dir);

  cached = cfg;
  return cfg;
}

/** 需要启动时就建好的目录 */
export function ensureDirs(cfg: AppConfig): void {
  const dirs = [
    path.dirname(cfg.db.sqlite.file),
    cfg.tts.cacheDir,
    cfg.imagegen.dir,
    cfg.logging.dir,
    cfg.backup.dir,
    // 证书目录也建好：没跑过 https-setup.ps1 时，家长至少知道证书该放哪儿
    path.dirname(cfg.server.https.certFile),
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/* ------------------------------------------------------------------ HTTPS */

export interface HttpsResolved {
  /** 是否真的能以 HTTPS 启动（enabled 且证书读得出来） */
  enabled: boolean;
  certFile: string;
  keyFile: string;
  cert: Buffer | null;
  key: Buffer | null;
  /** 配了 HTTPS 却起不来的原因；enabled 为 true 时必为空 */
  problem: string;
}

/**
 * 解析 HTTPS 配置，并把证书**在启动时一次性读进内存**。
 *
 * 刻意不用「配置错了就退出」：证书过期、路径写错、忘了跑 https-setup.ps1 都会让
 * 整个学习台打不开，而孩子是按点用平板的 —— 停服比降级糟得多。
 * 所以读不出来就带着 problem 回退 HTTP，由启动日志大声喊出来，服务照常可用。
 */
export function resolveHttps(cfg: AppConfig): HttpsResolved {
  const h = cfg.server.https;
  const base: HttpsResolved = {
    enabled: false,
    certFile: h.certFile,
    keyFile: h.keyFile,
    cert: null,
    key: null,
    problem: "",
  };
  if (!h.enabled) return base;

  const missing = [h.certFile, h.keyFile].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    return { ...base, problem: `找不到证书文件 ${missing.join("、")}（先在仓库根目录跑 scripts/https-setup.ps1）` };
  }
  try {
    const cert = fs.readFileSync(h.certFile);
    const key = fs.readFileSync(h.keyFile);
    return { ...base, enabled: true, cert, key };
  } catch (e) {
    return { ...base, problem: `证书读取失败：${(e as Error).message}` };
  }
}

/** 密钥脱敏显示，用于日志与 /api/health */
export function maskKey(key: string): string {
  if (!key) return "(未配置)";
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)} (len=${key.length})`;
}

/** 启动前的一致性检查，返回警告列表（不阻塞启动） */
export function startupWarnings(cfg: AppConfig): string[] {
  const w: string[] = [];
  if (!cfg.llm.apiKey) {
    // 这个提示必须自带「怎么修」，否则用户只能猜
    const fromEnv = process.env.LLM_API_KEY
      ? "环境变量 LLM_API_KEY 已读取但内容为空"
      : "既没有环境变量 LLM_API_KEY，也没有在 .env 里填";
    const where = dotEnvSummary();
    w.push(
      `llm.apiKey 未配置（${fromEnv}）→ 生成童话、手写判卷、组词建议都会失败。\n` +
        (where.length ? `    已读取的 .env：${where.join("、")}\n` : "    没有找到任何 .env 文件\n") +
        `    修法：在下面任一文件里写一行 LLM_API_KEY=sk-xxxx，然后重启服务\n` +
        dotEnvCandidates()
          .map((p) => `      · ${p}`)
          .join("\n"),
    );
  }
  if (!cfg.llm.markModel) {
    w.push("llm.markModel 未配置：手写判卷没有可用模型");
  }
  if (cfg.db.driver === "mysql" && !cfg.db.mysql.password) {
    w.push("db.driver=mysql 但 db.mysql.password 为空（环境变量 DB_PASSWORD 未设置）");
  }
  // 模型名和接口地址对不上，是「明明填了 key 却一直报错」的最常见原因
  for (const m of providerModelMismatches(cfg)) w.push(m);

  // HTTPS 配了却起不来 —— 不拦启动，但必须说清楚症状，否则家长只会看到「还是没全屏」
  if (cfg.server.https.enabled) {
    const h = resolveHttps(cfg);
    if (h.problem) {
      w.push(
        `server.https.enabled=true 但 ${h.problem} → 已回退 HTTP。\n` +
          `    后果：平板上的浏览器地址栏/底栏去不掉，Service Worker 也注册不了（非安全上下文）。`,
      );
    }
  }
  return w;
}

/** 拼出 chat/completions 的完整地址（容忍 baseUrl 带不带 /v1、末尾带不带 /） */
export function buildChatUrl(baseUrl: string): string {
  let base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) base = "https://api.deepseek.com/v1";
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/** 三个用途：生成童话 / 手写判卷 / 组词建议 */
export type LlmPurpose = "story" | "mark" | "suggest";

export interface ResolvedLlm {
  purpose: LlmPurpose;
  /** 实际生效的 provider 地址（已解析回落） */
  baseUrl: string;
  chatUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  /** 该用途是否用了独立的 baseUrl / apiKey（诊断展示用） */
  usingOwnProvider: boolean;
  /** 是否成功拿到了密钥 */
  configured: boolean;
}

/**
 * 家长后台可填写的运行时覆盖（模型名 / 密钥，优先级最高）。
 * 与 tts 的 runtimeVoice 同一套路：进程内变量即时生效，重启后由 index.ts
 * 从 app_kv（child_id=0，系统级）读回再 setLlmRuntimeOverride 恢复。
 * 字段留空（undefined）表示「不覆盖，回落 config.yaml / 环境变量」。
 */
export interface LlmRuntimeOverride {
  storyModel?: string;
  storyApiKey?: string;
  markModel?: string;
  markApiKey?: string;
}

let runtimeOverride: LlmRuntimeOverride = {};

export function setLlmRuntimeOverride(o: LlmRuntimeOverride): void {
  runtimeOverride = {
    storyModel: o.storyModel?.trim() || undefined,
    storyApiKey: o.storyApiKey?.trim() || undefined,
    markModel: o.markModel?.trim() || undefined,
    markApiKey: o.markApiKey?.trim() || undefined,
  };
}

export function getLlmRuntimeOverride(): LlmRuntimeOverride {
  return { ...runtimeOverride };
}

/**
 * 各用途的默认固定接口地址（家长在后台看不到、也不用配）：
 *   · story → DeepSeek（纯文本，便宜）
 *   · mark  → 阿里云百炼（OpenAI 兼容模式，视觉模型 qwen-vl-* 在这里）
 *   · suggest 未固定，继续回落全局 baseUrl
 * 若 config.yaml 里显式配了某用途独立的 *BaseUrl（storyBaseUrl/markBaseUrl），
 * 则优先用显式值 —— 供测试 mock、自建网关等特殊场景覆盖。
 */
const FIXED_BASE_URL: Partial<Record<LlmPurpose, string>> = {
  story: "https://api.deepseek.com/v1",
  mark: "https://dashscope.aliyuncs.com/compatible-mode/v1",
};

function runtimePick(purpose: LlmPurpose): { model?: string; apiKey?: string } {
  if (purpose === "story") return { model: runtimeOverride.storyModel, apiKey: runtimeOverride.storyApiKey };
  if (purpose === "mark") return { model: runtimeOverride.markModel, apiKey: runtimeOverride.markApiKey };
  return {};
}

/**
 * 把「某用途该用哪家、哪个模型、多少超时」解析成一个确定的对象。
 *
 * 优先级（高 → 低）：
 *   1. 运行时覆盖（家长后台填的模型名 / 密钥）
 *   2. 该用途独立的 *BaseUrl / *ApiKey / *Model
 *   3. 全局 baseUrl / apiKey（单厂商多模型场景）
 * story / mark 的接口地址被固定，不再受 config 影响。
 */
export function resolveLlm(cfg: AppConfig, purpose: LlmPurpose): ResolvedLlm {
  const own = {
    story: { baseUrl: cfg.llm.storyBaseUrl, apiKey: cfg.llm.storyApiKey, model: cfg.llm.storyModel },
    mark: { baseUrl: cfg.llm.markBaseUrl, apiKey: cfg.llm.markApiKey, model: cfg.llm.markModel },
    suggest: { baseUrl: cfg.llm.suggestBaseUrl, apiKey: cfg.llm.suggestApiKey, model: cfg.llm.suggestModel },
  }[purpose];

  const ov = runtimePick(purpose);
  const model = ov.model ?? own.model;
  // 用 `||` 而不是 `??`：own.apiKey 是空字符串时要继续回落到全局 apiKey
  const apiKey = ov.apiKey || own.apiKey || cfg.llm.apiKey;
  // 接口地址：该用途独立 baseUrl 显式配置时优先（测试 / 换网关用），
  // 否则 story/mark 用固定地址，suggest 回落全局 baseUrl。
  const baseUrl = (own.baseUrl || FIXED_BASE_URL[purpose] || cfg.llm.baseUrl || "").trim();

  return {
    purpose,
    baseUrl,
    chatUrl: buildChatUrl(baseUrl),
    apiKey,
    model,
    timeoutMs: cfg.llm.timeoutMs[purpose],
    temperature: cfg.llm.temperature[purpose],
    usingOwnProvider: Boolean(own.baseUrl || own.apiKey || ov.apiKey),
    configured: Boolean(apiKey && model),
  };
}

/** 三个用途一次全解析出来（诊断页面 / 启动日志用） */
export function resolveAllLlm(cfg: AppConfig): ResolvedLlm[] {
  return (["story", "mark", "suggest"] as const).map((p) => resolveLlm(cfg, p));
}

/* ------------------------------------------------------------ 文生图 */

/** 阿里云百炼「千问-文生图」同步接口的默认地址（config 里没写时用） */
export const DEFAULT_IMAGE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

export interface ResolvedImagegen {
  enabled: boolean;
  model: string;
  url: string;
  apiKey: string;
  size: string;
  dir: string;
  timeoutMs: number;
  /** Key 是从哪儿来的（诊断用：独立配置 / 复用判卷 Key） */
  keyFrom: "own" | "mark" | "none";
  configured: boolean;
}

/**
 * 解析文生图该怎么调。
 *
 * Key 的优先级：imagegen.apiKey → mark（判卷）用途的 Key。
 * 判卷用的就是阿里云百炼，而千问文生图也在百炼上 —— 同一把 Key 通用，
 * 所以家长在后台填过判卷 Key 之后，画图功能不需要任何额外配置就能用。
 */
export function resolveImagegen(cfg: AppConfig): ResolvedImagegen {
  const ig = cfg.imagegen;
  const mark = resolveLlm(cfg, "mark");
  const ownKey = (ig.apiKey || "").trim();
  const apiKey = ownKey || mark.apiKey;
  const keyFrom: ResolvedImagegen["keyFrom"] = ownKey ? "own" : mark.apiKey ? "mark" : "none";

  return {
    enabled: ig.enabled,
    model: ig.model,
    url: (ig.baseUrl || DEFAULT_IMAGE_URL).trim(),
    apiKey,
    size: ig.size,
    dir: ig.dir,
    timeoutMs: ig.timeoutMs,
    keyFrom,
    configured: Boolean(ig.model && apiKey),
  };
}

/** 文生图配置摘要（/api/health 展示，密钥脱敏） */
export function imagegenSummary(cfg: AppConfig): Record<string, unknown> {
  const r = resolveImagegen(cfg);
  return {
    enabled: r.enabled,
    model: r.model,
    url: r.url,
    size: r.size,
    timeoutMs: r.timeoutMs,
    apiKey: r.apiKey ? `${maskKey(r.apiKey)} · ${r.keyFrom === "own" ? "独立" : "复用判卷 Key"}` : "(未配置)",
    ok: r.enabled && r.configured,
  };
}

/**
 * 常见模型的归属厂商标识。
 * 用来抓「模型名和接口地址对不上」这种错 —— 例如把 qwen-vl-max 挂到 api.deepseek.com、
 * 或把 deepseek-chat 挂到 dashscope 上。这类错误在调用时只会收到一个笼统的 400/404，
 * 很难反应过来是配错了，所以启动时直接点出来。
 */
const MODEL_VENDORS: { re: RegExp; vendor: string; hosts: string[] }[] = [
  { re: /^deepseek/i, vendor: "DeepSeek", hosts: ["api.deepseek.com"] },
  { re: /^(qwen|qwq|qvq)/i, vendor: "阿里云百炼", hosts: ["dashscope.aliyuncs.com"] },
  { re: /^(glm|charglm|codegeex)/i, vendor: "智谱 GLM", hosts: ["open.bigmodel.cn", "bigmodel.cn"] },
  { re: /^(moonshot|kimi)/i, vendor: "月之暗面", hosts: ["api.moonshot.cn", "moonshot.cn"] },
  { re: /^doubao/i, vendor: "火山方舟", hosts: ["ark.cn-beijing.volces.com", "volces.com"] },
  { re: /^(gpt|o1|o3|o4|chatgpt)/i, vendor: "OpenAI", hosts: ["api.openai.com"] },
  { re: /^(ernie|wenxin)/i, vendor: "百度文心", hosts: ["qianfan.baidubce.com", "aip.baidubce.com"] },
  { re: /^hunyuan/i, vendor: "腾讯混元", hosts: ["api.hunyuan.cloud.tencent.com"] },
];

/** 找出「模型名属于 A 家、接口地址却是 B 家」的配置问题 */
export function providerModelMismatches(cfg: AppConfig): string[] {
  const out: string[] = [];
  const label: Record<LlmPurpose, string> = { story: "故事", mark: "判卷", suggest: "组词" };

  for (const p of resolveAllLlm(cfg)) {
    if (!p.model || !p.baseUrl) continue;
    let host = "";
    try {
      host = new URL(p.baseUrl).host.toLowerCase();
    } catch {
      continue; // 地址本身不合法，交给别的检查报
    }

    const hit = MODEL_VENDORS.find((v) => v.re.test(p.model));
    if (!hit) continue;
    if (hit.hosts.some((h) => host.includes(h))) continue;

    // 地址落在「另一家已知厂商」的官方域名上（如 deepseek-chat 挂到 dashscope）→ 基本可以断定是配错了。
    const otherVendor = MODEL_VENDORS.find(
      (v) => v !== hit && v.hosts.some((h) => host.includes(h)),
    );
    if (!otherVendor) {
      // 既不是这家厂商的域名、也不是任何其他已知厂商的域名：
      // 典型情况是自建网关 / 私有 MaaS 端点（例如阿里云 MaaS 的 llm-xxx.maas.aliyuncs.com），
      // 模型名是用户自己起的、上面对不上是正常的。
      // 用户是显式配了 LLM_<用途>_BASE_URL 才会走到这里，属于有意为之，不该报警。
      continue;
    }

    out.push(
      `${label[p.purpose]}模型「${p.model}」看起来是 ${hit.vendor} 的，但接口地址是 ${host}` +
        `（${otherVendor.vendor} 的域名，${p.usingOwnProvider ? "已配独立 provider" : "用的是全局 baseUrl"}）→ ` +
        `调用时多半会报 model not found。请把 LLM_${p.purpose.toUpperCase()}_BASE_URL 改成 ` +
        `${hit.hosts[0]} 对应的地址，或换一个该厂商确实提供的模型名。`,
    );
  }
  return out;
}
