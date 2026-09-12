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
    server: { ...server, auth: obj(server.auth) },
    db: { ...db, sqlite: obj(db.sqlite), mysql: obj(db.mysql) },
    llm: { ...llm, timeoutMs: obj(llm.timeoutMs), temperature: obj(llm.temperature) },
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
  cfg.tts.cacheDir = resolveFromRoot(cfg.tts.cacheDir);
  cfg.logging.dir = resolveFromRoot(cfg.logging.dir);
  cfg.backup.dir = resolveFromRoot(cfg.backup.dir);

  cached = cfg;
  return cfg;
}

/** 需要启动时就建好的目录 */
export function ensureDirs(cfg: AppConfig): void {
  for (const d of [path.dirname(cfg.db.sqlite.file), cfg.tts.cacheDir, cfg.logging.dir, cfg.backup.dir]) {
    fs.mkdirSync(d, { recursive: true });
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
 * 把「某用途该用哪家、哪个模型、多少超时」解析成一个确定的对象。
 *
 * 回落规则：某用途的 baseUrl/apiKey 留空 → 用 llm.baseUrl / llm.apiKey。
 * 这样「单厂商多模型」和「多厂商多模型」两种用法都自然成立，
 * 而且老配置（只写全局 baseUrl）行为完全不变。
 */
export function resolveLlm(cfg: AppConfig, purpose: LlmPurpose): ResolvedLlm {
  const own: Record<LlmPurpose, { baseUrl: string; apiKey: string; model: string }> = {
    story: { baseUrl: cfg.llm.storyBaseUrl, apiKey: cfg.llm.storyApiKey, model: cfg.llm.storyModel },
    mark: { baseUrl: cfg.llm.markBaseUrl, apiKey: cfg.llm.markApiKey, model: cfg.llm.markModel },
    suggest: { baseUrl: cfg.llm.suggestBaseUrl, apiKey: cfg.llm.suggestApiKey, model: cfg.llm.suggestModel },
  };

  const me = own[purpose];
  const baseUrl = (me.baseUrl || cfg.llm.baseUrl || "").trim();
  const apiKey = me.apiKey || cfg.llm.apiKey;

  return {
    purpose,
    baseUrl,
    chatUrl: buildChatUrl(baseUrl),
    apiKey,
    model: me.model,
    timeoutMs: cfg.llm.timeoutMs[purpose],
    temperature: cfg.llm.temperature[purpose],
    usingOwnProvider: Boolean(me.baseUrl || me.apiKey),
    configured: Boolean(apiKey && me.model),
  };
}

/** 三个用途一次全解析出来（诊断页面 / 启动日志用） */
export function resolveAllLlm(cfg: AppConfig): ResolvedLlm[] {
  return (["story", "mark", "suggest"] as const).map((p) => resolveLlm(cfg, p));
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
