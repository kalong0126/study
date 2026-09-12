/**
 * 测试用 Mock 大模型服务
 *
 * 真实接口无法稳定复现「返回数量不对」「超时」「401」这些分支，
 * 而这些恰恰是最容易出错的地方（降级、错误分类、不重试）。
 * 所以用一个可控的 mock，通过 /__mode 切换行为。
 */
import http from "node:http";

type Mode = "ok" | "badjson" | "wrongcount" | "http401" | "http500" | "slow" | "empty" | "notjson";

let mode: Mode = "ok";
let calls: { url: string; model: string; prompt: string; hasImage: boolean; at: number }[] = [];

/** 从批量判卷 prompt 里抠出目标字：形如 "1. 两" */
function extractTargets(prompt: string): string[] {
  const out: string[] = [];
  const re = /^\s*(\d+)\.\s*(\S)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const idx = Number(m[1]);
    out[idx - 1] = m[2];
  }
  return out.filter(Boolean);
}

/** 从单字判卷 prompt 里抠出目标字 */
function extractSingleTarget(prompt: string): string {
  const m = /目标字是「(.)」/.exec(prompt);
  return m ? m[1] : "?";
}

function buildItem(index: number, target: string) {
  // 奇数判对、偶数判错 —— 确定性设计，便于同时覆盖两条分支
  const correct = index % 2 === 1;
  return {
    index,
    written: correct ? target : "?",
    correct,
    score: correct ? 92 : 35,
    comment: correct ? "写对啦，真棒" : "再写一次会更好",
  };
}

function chatResponse(prompt: string, hasImage: boolean): string {
  const isBatch = /包含\s*\d+\s*个田字格/.test(prompt);
  if (isBatch) {
    const targets = extractTargets(prompt);
    if (mode === "wrongcount") {
      // 故意少返回一项，触发降级
      const partial = targets.slice(0, Math.max(1, targets.length - 1)).map((t, i) => buildItem(i + 1, t));
      return JSON.stringify({ items: partial });
    }
    return JSON.stringify({ items: targets.map((t, i) => buildItem(i + 1, t)) });
  }

  const target = extractSingleTarget(prompt);
  if (hasImage || /田字格/.test(prompt)) {
    return JSON.stringify(buildItem(1, target));
  }
  // 故事生成
  return [
    "《小水滴的旅行》",
    "",
    "从前有一滴小水珠，住在一朵白云里。",
    "有一天，它从云里落了下来，开始了自己的旅行。",
    "它落在小溪里，跟着溪水一起唱歌。",
    "它落在田野里，让禾苗喝饱了水。",
    "最后，它又回到了天上，变成了一朵白云。",
  ].join("\n");
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = (req.url || "").split("?")[0];

    if (url === "/__mode") {
      try {
        const j = JSON.parse(body || "{}");
        mode = (j.mode as Mode) ?? "ok";
      } catch {
        mode = "ok";
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode }));
      return;
    }
    if (url === "/__reset") {
      mode = "ok";
      calls = [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === "/__calls") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: calls.length, calls }));
      return;
    }

    if (!url.endsWith("/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock: 未知路径 " + url } }));
      return;
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      /* ignore */
    }
    const messages = (payload.messages ?? []) as { content: unknown }[];
    const userMsg = messages[messages.length - 1];
    const content = userMsg?.content;
    const prompt =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as { type: string; text?: string }[])
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("\n")
          : "";
    const hasImage =
      Array.isArray(content) && (content as { type: string }[]).some((p) => p.type === "image_url");

    calls.push({ url, model: String(payload.model ?? ""), prompt: prompt.slice(0, 3000), hasImage, at: Date.now() });

    const send = (status: number, objByText: string | object): void => {
      const text = typeof objByText === "string" ? objByText : JSON.stringify(objByText);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      );
    };

    switch (mode) {
      case "http401":
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock: 密钥无效" } }));
        return;
      case "http500":
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock: 服务端错误" } }));
        return;
      case "slow":
        setTimeout(() => send(200, chatResponse(prompt, hasImage)), 15000);
        return;
      case "empty":
        send(200, "");
        return;
      case "badjson":
        send(200, "抱歉，这张图我看不清，请重新上传一次。");
        return;
      case "notjson":
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>这是某个网站首页，不是接口</body></html>");
        return;
      case "ok":
      default:
        send(200, chatResponse(prompt, hasImage));
    }
  });
});

const PORT = Number(process.env.MOCK_PORT ?? 8799);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}`);
});
