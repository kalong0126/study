/**
 * 大模型客户端（OpenAI 兼容协议）
 *
 * 相比之前在浏览器里直接 fetch，服务端调用有三个实打实的好处：
 *   1. 没有 CORS 限制（之前 OpenAI 在浏览器里被 CORS 拦死）
 *   2. 密钥不下发到前端
 *   3. 超时/重试/错误分类可以集中做，日志能落到文件
 *
 * 错误分类是重点：浏览器里「CORS 拦截 / 404 / 域名不通 / 超时」都表现为同一句
 * `TypeError: Failed to fetch`，页面上根本没法区分。服务端能拿到真实原因，
 * 所以这里把 kind 明确区分出来，供日志与前端提示使用。
 */
import { buildChatUrl, loadConfig, maskKey, resolveLlm, type ResolvedLlm } from "../config.js";
import { logLlm } from "../logger.js";

export type LlmErrorKind = "config" | "timeout" | "network" | "http" | "parse" | "empty";

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly detail: Record<string, unknown> = {},
    /** 是否值得重试。4xx（除限流/超时类）重试没有意义，只会白等一遍超时。 */
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type ChatContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export interface ChatOptions {
  /**
   * 用哪个用途的模型配置。它决定了 baseUrl / apiKey / 模型名 / 超时 / 温度。
   * 传 resolveLlm(cfg, "story" | "mark" | "suggest") 的返回值。
   */
  provider: ResolvedLlm;
  messages: ChatMessage[];
  /** 临时覆盖 provider 里的值（一般不用，留给特殊场景） */
  model?: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  retries?: number;
  /**
   * 要求模型「只输出 JSON」。DeepSeek / 阿里百炼等 OpenAI 兼容接口都支持。
   * 少数网关不支持这个字段（会返回 400），调用方应当捕获后去掉它再重试一次。
   */
  responseFormat?: "json_object";
  /** 日志标签，例如 "story" / "mark" / "suggest" / "language" */
  tag: string;
}

export interface ChatResult {
  text: string;
  ms: number;
  status: number;
  usage: Record<string, unknown> | null;
  model: string;
}

/** 从各家五花八门的响应里抠出正文（有些厂商 content 是数组） */
export function extractContent(data: unknown): string {
  try {
    const choices = (data as { choices?: unknown[] })?.choices;
    if (!Array.isArray(choices) || !choices.length) return "";
    const msg = (choices[0] as { message?: { content?: unknown } })?.message;
    const content = msg?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((p) => (typeof p === "string" ? p : ((p as { text?: string })?.text ?? "")))
        .join("");
    }
    // 少数兼容实现把文本放在 choices[0].text
    const alt = (choices[0] as { text?: unknown })?.text;
    if (typeof alt === "string") return alt;
    return "";
  } catch {
    return "";
  }
}

/**
 * 判断这次响应是不是「推理型模型的思考内容」：
 * content 为空、但 reasoning_content 有内容。
 * 这类模型（deepseek-v4-pro / deepseek-reasoner 等）判卷、生成童话都不合适：
 * 输出先进 reasoning_content，一旦 max_tokens 被思考过程吃光，content 就是空的。
 */
export function isReasoningOnly(data: unknown): boolean {
  try {
    const choices = (data as { choices?: unknown[] })?.choices;
    if (!Array.isArray(choices) || !choices.length) return false;
    const msg = (choices[0] as { message?: Record<string, unknown> })?.message;
    if (!msg) return false;
    const content = msg.content;
    const reasoning = msg.reasoning_content ?? msg.reasoning;
    const hasContent = typeof content === "string" && content.trim().length > 0;
    const hasReasoning = typeof reasoning === "string" && reasoning.trim().length > 0;
    return !hasContent && hasReasoning;
  } catch {
    return false;
  }
}

/** 从错误响应体里抠出厂商给的原话 */
function extractErrorText(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    const m = j?.error?.message ?? j?.message;
    if (m) return String(m);
  } catch {
    /* 非 JSON */
  }
  return raw.slice(0, 200);
}

const RETRYABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * 发一次对话请求。失败时抛 LlmError（带 kind），调用方按 kind 决定怎么提示。
 */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const cfg = loadConfig();
  const p = opts.provider;
  const model = opts.model || p.model;
  const timeoutMs = opts.timeoutMs ?? p.timeoutMs;
  const temperature = opts.temperature ?? p.temperature;
  const url = p.chatUrl;
  const maxAttempts = Math.max(1, (opts.retries ?? cfg.llm.retries) + 1);
  const bodySize = JSON.stringify(opts.messages).length;

  let lastErr: LlmError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();

    try {
      if (!p.apiKey) {
        throw new LlmError(
          "config",
          `后端未配置 ${p.purpose} 用途的 API Key（环境变量 LLM_API_KEY 或 LLM_${p.purpose.toUpperCase()}_API_KEY 为空）`,
          { purpose: p.purpose, baseUrl: p.baseUrl },
        );
      }
      if (!model) {
        throw new LlmError("config", `${p.purpose} 用途没有配置模型名`, { purpose: p.purpose });
      }

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${p.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: opts.messages,
          ...(temperature !== undefined ? { temperature } : {}),
          ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.responseFormat ? { response_format: { type: opts.responseFormat } } : {}),
        }),
        signal: ac.signal,
      });

      const ms = Date.now() - t0;
      const raw = await res.text();

      if (!res.ok) {
        const apiMsg = extractErrorText(raw);
        const retryable = RETRYABLE_HTTP.has(res.status);
        const err = new LlmError(
          "http",
          `HTTP ${res.status}：${apiMsg}`,
          { status: res.status, apiMsg, attempt, ms },
          retryable,
        );
        lastErr = err;
        if (retryable && attempt < maxAttempts) {
          logLlm.warn(
            { tag: opts.tag, model: model, url, status: res.status, ms, attempt, apiMsg: apiMsg.slice(0, 200) },
            "大模型返回可重试错误，准备重试",
          );
          continue;
        }
        // 注意：这里必须 throw，不能 continue —— continue 会绕开下面的 catch，
        // 导致「不可重试的错误」也被重试一遍（401 白等一轮超时）。
        throw err;
      }

      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new LlmError("parse", "接口返回的不是 JSON，多半是 Base URL 写错了", {
          bodyHead: raw.slice(0, 200),
          status: res.status,
          ms,
        });
      }

      const text = extractContent(data).trim();
      if (!text) {
        if (isReasoningOnly(data)) {
          throw new LlmError(
            "empty",
            "这个模型是「推理型」的，回复只写了思考过程（reasoning_content），没有给出正文。" +
              "判卷 / 生成童话要用能直接输出的模型，例如 deepseek-chat。",
            { status: res.status, ms, model, bodyHead: raw.slice(0, 200) },
          );
        }
        throw new LlmError("empty", "模型没有返回内容", { status: res.status, ms, bodyHead: raw.slice(0, 200) });
      }

      const usage = (data as { usage?: Record<string, unknown> }).usage ?? null;
      logLlm.info(
        {
          tag: opts.tag,
          model: model,
          ms,
          status: res.status,
          attempt,
          reqChars: bodySize,
          resChars: text.length,
          usage: usage ? JSON.stringify(usage) : undefined,
        },
        "大模型调用成功",
      );
      return { text, ms, status: res.status, usage, model: model };
    } catch (e) {
      const ms = Date.now() - t0;
      let err: LlmError;

      if (e instanceof LlmError) {
        err = e;
      } else {
        const name = (e as { name?: string })?.name;
        if (name === "AbortError" || name === "TimeoutError") {
          err = new LlmError(
            "timeout",
            `请求超时（${Math.round(timeoutMs / 1000)} 秒未响应）`,
            { timeoutMs, ms, attempt, url },
            true,
          );
        } else {
          const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
          let host = url;
          try {
            host = new URL(url).host;
          } catch {
            /* url 本身不合法，原样输出 */
          }
          err = new LlmError(
            "network",
            `网络不通（连不上 ${host}${cause?.code ? ` · ${cause.code}` : ""}）`,
            { url, cause: cause?.code ?? cause?.message ?? String(e), ms, attempt },
            true,
          );
        }
      }

      lastErr = err;
      // 只有明确「可重试」的错误才重试；401/403/404 这类重试一次只是白等
      if (err.retryable && attempt < maxAttempts) continue;

      logLlm.error(
        { tag: opts.tag, model: model, url, kind: err.kind, attempt, ms, err, detail: err.detail },
        "大模型调用失败",
      );
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new LlmError("network", "请求失败", { url });
}

/**
 * 自检用：把每个用途最终生效的 provider / 模型整理出来（密钥脱敏）。
 * 前端诊断页直接展示这份数据，用户就能一眼看出「故事走了哪家、判卷走了哪家」。
 */
export function llmConfigSummary(): Record<string, unknown> {
  const cfg = loadConfig();
  const story = resolveLlm(cfg, "story");
  const mark = resolveLlm(cfg, "mark");
  const suggest = resolveLlm(cfg, "suggest");
  const purposes = [story, mark, suggest].map((p) => ({
    purpose: p.purpose,
    model: p.model || "(未配置)",
    baseUrl: p.baseUrl,
    chatUrl: p.chatUrl,
    // 脱敏：告诉用户「用的是独立 key 还是共享 key」，但不泄露内容
    apiKey: p.apiKey ? (p.usingOwnProvider ? `${maskKey(p.apiKey)} · 独立` : `${maskKey(p.apiKey)} · 共享`) : "(未配置)",
    timeoutMs: p.timeoutMs,
    ok: p.configured,
  }));

  return {
    // 全局默认（未单独配置的用途都走它）
    baseUrl: cfg.llm.baseUrl,
    chatUrl: buildChatUrl(cfg.llm.baseUrl),
    apiKey: maskKey(cfg.llm.apiKey),
    retries: cfg.llm.retries,
    // 各用途解析结果
    purposes,
    // 为了兼容老前端的字段（这里返回「生效值」，已含运行时覆盖）
    storyModel: story.model,
    markModel: mark.model,
    suggestModel: suggest.model,
    // 前端表单用：只给脱敏状态，用于「已配置，留空则不修改」的占位提示
    storyApiKeyMasked: story.apiKey ? maskKey(story.apiKey) : "",
    markApiKeyMasked: mark.apiKey ? maskKey(mark.apiKey) : "",
    timeouts: cfg.llm.timeoutMs,
  };
}
