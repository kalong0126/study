/**
 * 测试用 Mock 大模型服务
 *
 * 真实接口无法稳定复现「返回数量不对」「超时」「401」这些分支，
 * 而这些恰恰是最容易出错的地方（降级、错误分类、不重试）。
 * 所以用一个可控的 mock，通过 /__mode 切换行为。
 */
import http from "node:http";

type Mode =
  | "ok"
  | "badjson"
  | "wrongcount"
  | "http401"
  | "http500"
  | "slow"
  | "empty"
  | "notjson"
  | "langcount"
  | "imgfail";

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

/* --------------------------------------------------- 语言强化（9 题型） */

/**
 * 一份符合《语言强化训练》约定的 9 题 JSON。
 * 关键点（后端解析与前端交互都依赖）：
 *   · 第 2 题给 options + answer（选择题，可自动判卷）
 *   · 第 6 题 sentences 是**打乱后**的句子、answer 是**正确顺序的 1 基下标**
 *   · 第 7 题 answer 与 observationQuestions 一一对应
 */
function languagePayload(theme: string, count = 9): string {
  const questions: Record<string, unknown>[] = [
    {
      id: 1,
      type: "word",
      ability: "word",
      subAbility: "color_word",
      difficulty: 2,
      question: "读一读「嫩绿」，说说它是什么意思，再用它说一句话。",
      word: "嫩绿",
      meaning: "又嫩又绿，是刚长出来的叶子的颜色。",
      collocation: "嫩绿的小草",
      example: "春天到了，地上长出了嫩绿的小草。",
      answer: "嫩绿：嫩绿的小草",
      answerType: "standard",
      hint: "想一想小草刚长出来的时候是什么颜色？",
      analysis: "这个词用来写刚长出来的植物。",
      tags: ["颜色", "植物"],
    },
    {
      id: 2,
      type: "word_collocation",
      ability: "collocation",
      subAbility: "adjective_noun",
      difficulty: 2,
      question: "下面哪个说法的搭配是对的？",
      options: ["温暖的阳光", "温暖的石头", "温暖的冰箱"],
      answer: "温暖的阳光",
      answerType: "standard",
      hint: "想一想，阳光照在身上是什么感觉？",
      analysis: "「温暖」常用来形容阳光、春天这些让人舒服的事物。",
      tags: ["搭配"],
    },
    {
      id: 3,
      type: "sentence_expand",
      ability: "sentence_expand",
      subAbility: "add_location",
      difficulty: 2,
      baseSentence: "小狗跑。",
      requiredElements: ["什么样的", "在哪里"],
      guideQuestions: ["什么样的小狗？", "它在哪里跑？"],
      answer: "一只雪白的小狗在草地上跑。",
      answerType: "reference",
      hint: "它是在哪里跑呢？",
      analysis: "加上「什么样的」和「在哪里」，句子就具体了。",
      tags: ["扩句"],
    },
    {
      id: 4,
      type: "sentence_correction",
      ability: "sentence_fluency",
      subAbility: "action_object",
      difficulty: 2,
      wrongSentence: "我喝了一块蛋糕。",
      errorType: "ACTION_OBJECT_ERROR",
      question: "这句话哪里不对？把它改通顺。",
      answer: "我吃了一块蛋糕。",
      answerType: "standard",
      hint: "想一想，蛋糕应该用哪个动作？",
      analysis: "「喝」是和液体搭配的，蛋糕要用「吃」。",
      tags: ["病句"],
    },
    {
      id: 5,
      type: "sentence_detail",
      ability: "sentence_detail",
      subAbility: "describe_action",
      difficulty: 2,
      baseSentence: "我很开心。",
      guideQuestions: ["开心的时候你会做什么动作？", "你的脸上是什么表情？"],
      expressionMethods: ["动作", "表情"],
      answer: "我高兴得跳了起来，脸上笑眯眯的。",
      answerType: "reference",
      hint: "开心的时候，你的手和脚会怎么样？",
      analysis: "用动作和表情来说开心，比只说「很开心」更清楚。",
      tags: ["写具体"],
    },
    {
      id: 6,
      type: "sentence_order",
      ability: "sentence_order",
      subAbility: "time_order",
      difficulty: 2,
      orderType: "TIME",
      sentences: ["然后我们把风筝放上了天。", "星期天，我和爸爸去公园放风筝。", "最后我们开开心心地回家了。"],
      answer: [2, 1, 3],
      fullParagraph: "星期天，我和爸爸去公园放风筝。然后我们把风筝放上了天。最后我们开开心心地回家了。",
      answerType: "standard",
      hint: "先想一想，哪一句是最开始的时候？",
      analysis: "按时间先后来排：先出门，再放风筝，最后回家。",
      tags: ["排序"],
    },
    {
      id: 7,
      type: "image_observation",
      ability: "observation",
      subAbility: "observe_scene",
      difficulty: 2,
      imagePrompt:
        "星期天下午，一个小男孩和爸爸在公园里放风筝。小男孩拿着风筝线向前跑，爸爸站在旁边笑着看他。天空中有几朵白云，草地上开着几朵小花。",
      imageElements: {
        time: "星期天下午",
        place: "公园",
        characters: ["小男孩", "爸爸"],
        actions: ["放风筝", "向前跑"],
        expressions: ["笑着"],
        environment: ["白云", "草地", "小花"],
      },
      observationQuestions: ["图上是什么地方？", "图上有哪些人？", "小男孩在做什么？"],
      answer: ["公园。", "小男孩和爸爸。", "小男孩在放风筝。"],
      answerType: "reference",
      hint: "先看看周围有什么，再看看人在做什么。",
      analysis: "观察图片时按「地方 → 人物 → 动作」的顺序说。",
      tags: ["观察"],
    },
    {
      id: 8,
      type: "image_speaking",
      ability: "image_expression",
      subAbility: "speak_scene",
      difficulty: 2,
      basedOnQuestionId: 7,
      guideQuestions: ["什么时候？", "在哪里？", "有谁？", "他们在做什么？", "爸爸是什么表情？"],
      question: "看着第 7 题的图画，用 3～5 句话把画面说完整。",
      answer: "星期天下午，我和爸爸去公园放风筝。我拿着风筝线向前跑，爸爸在旁边笑着看我。天空中有几朵白云，草地上还有小花。我们玩得真开心。",
      answerType: "reference",
      hint: "按问题一个一个说，最后连起来说一遍。",
      analysis: "把时间、地点、人物、事情连起来，就是一段完整的话。",
      tags: ["看图说话"],
    },
    {
      id: 9,
      type: "short_writing",
      ability: "short_writing",
      subAbility: "write_paragraph",
      difficulty: 2,
      question: "写一写你放风筝的一件小事，注意把时间、地点和心情写清楚。",
      keywords: ["星期天", "公园", "风筝", "开心"],
      guideQuestions: ["什么时候去的？", "和谁一起去的？", "后来发生了什么？"],
      requirements: { minSentences: 4, maxSentences: 6, suggestedLength: "50-100字" },
      answer: "星期天下午，我和爸爸去公园放风筝。一开始风筝总是掉下来。后来爸爸教我怎么放线，风筝终于飞起来了。我高兴得跳了起来。",
      answerType: "reference",
      hint: "先说什么时候、去哪里，再说发生了什么、你感觉怎么样。",
      analysis: "按「什么时候 → 在哪里 → 谁 → 发生了什么 → 结果 → 感受」来写。",
      tags: ["写作"],
    },
  ];

  return JSON.stringify({
    theme,
    grade: 2,
    difficulty: 2,
    trainingGoal: "学会把话说完整、把话写具体。",
    questions: questions.slice(0, count),
  });
}

/* --------------------------------------------------- 文生图（千问 qwen-image） */

/**
 * 1×1 的纯色 PNG。
 * 测试只关心「接口给回图片地址 → 我们下载 → 落盘 → 前端 <img> 能加载」这条链路，
 * 所以图不必要大，也不必好看；能通过 content-type / 尺寸校验就行。
 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** 从千问文生图的请求体里取出正向提示词（用于断言「场景描述确实被发出去了」） */
function imagePromptOf(payload: Record<string, unknown>): string {
  const input = payload.input as { messages?: { content?: { text?: string }[] }[] } | undefined;
  return input?.messages?.[0]?.content?.[0]?.text ?? "";
}

function chatResponse(prompt: string, hasImage: boolean, allText = ""): string {
  // 语言强化：系统提示词很长，参数在第一条 user 消息里，所以看的是「全部消息」
  if (/本次训练参数/.test(allText) || /上一次的输出无法被程序解析/.test(allText)) {
    // 系统提示词的示例里也有一处 "theme": "今日主题"，所以取**最后一个**匹配（即参数里的那个）
    const hits = [...allText.matchAll(/"theme"\s*:\s*"([^"]*)"/g)];
    const theme = hits.length ? hits[hits.length - 1][1] : "公园";
    return languagePayload(theme, mode === "langcount" ? 8 : 9);
  }

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

    /* ---- 文生图：同步接口（一次请求直接回图片地址） ---- */
    // 真实接口回的是 24 小时有效的 OSS 签名地址，这里回一个指向本 mock 的地址，
    // 顺带把「拿到地址后必须自己下载落盘」这条链路也测到。
    if (url === "/__image") {
      if (mode === "imgfail") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock: 画图服务端错误" } }));
        return;
      }
      let ip: Record<string, unknown> = {};
      try {
        ip = JSON.parse(body || "{}");
      } catch {
        /* ignore */
      }
      calls.push({
        url,
        model: String(ip.model ?? ""),
        prompt: imagePromptOf(ip).slice(0, 3000),
        hasImage: false,
        at: Date.now(),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          output: {
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: [{ image: `http://127.0.0.1:${PORT}/__image/pic.png` }] },
              },
            ],
            task_metric: { FAILED: 0, SUCCEEDED: 1, TOTAL: 1 },
          },
          usage: { width: 1328, height: 1328, image_count: 1 },
          request_id: "mock-image",
        }),
      );
      return;
    }
    if (url === "/__image/pic.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(TINY_PNG.length) });
      res.end(TINY_PNG);
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

    // 语言强化的判定要看「全部消息」（系统提示词 + 参数），所以另外拼一份完整文本
    const allText = messages
      .map((m) => {
        const c = m.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
          return (c as { type: string; text?: string }[])
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n");
        }
        return "";
      })
      .join("\n");

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
        setTimeout(() => send(200, chatResponse(prompt, hasImage, allText)), 15000);
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
        send(200, chatResponse(prompt, hasImage, allText));
    }
  });
});

const PORT = Number(process.env.MOCK_PORT ?? 8799);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}`);
});
