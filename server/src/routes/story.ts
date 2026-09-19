/**
 * 童话生成
 *
 * 与旧版相比：密钥改为后端持有、请求改为后端发起（不再受浏览器 CORS 限制），
 * 并且让模型第一行显式输出《标题》，标题因此变成真标题而不是正文的前 12 个字。
 *
 * 「今日童话」的幂等在这里：不带 `force` 时，今天已经有故事就**原样返回**，
 * 不再调模型 —— 孩子端一进童话页就会自动请求生成，刷新一次就会重复花钱。
 * 想换一篇（家长后台 / 孩子端的「换一篇」按钮）才带 `force: true`。
 */
import { Router } from "express";
import { loadConfig, resolveLlm } from "../config.js";
import { addReadTitle, addStory, listReadTitles, listStories, storyOfDay } from "../db/repo/state.js";
import { currentChildId } from "../services/child.js";
import { chat } from "../services/llm.js";
import { STORY_SYSTEM, buildStoryPrompt, parseStory } from "../services/prompts/storyPrompt.js";
import { ah, handleLlmError, ok, qInt } from "./helpers.js";

export const storyRouter = Router();

/** 今天的童话（没有就 story: null）。孩子端一进来先问这个，再决定要不要生成。 */
storyRouter.get(
  "/story/today",
  ah(async (_req, res) => {
    const childId = await currentChildId();
    const story = await storyOfDay(childId);
    ok(res, { story });
  }),
);

storyRouter.post(
  "/story/generate",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const cfg = loadConfig();

    const force = req.body?.force === true;

    if (!force) {
      const today = await storyOfDay(childId);
      if (today) {
        ok(res, {
          id: today.id,
          title: today.title,
          text: today.text,
          charCount: today.text.replace(/\s/g, "").length,
          avoidCount: 0,
          ms: 0,
          model: "cached",
          cached: true,
        });
        return;
      }
    }

    const fromBody: string[] = Array.isArray(req.body?.avoidTitles)
      ? req.body.avoidTitles.filter((x: unknown) => typeof x === "string")
      : [];
    const stored = await listReadTitles(childId);
    const avoid = Array.from(new Set([...stored, ...fromBody]));

    let result;
    try {
      result = await chat({
        tag: "story",
        provider: resolveLlm(cfg, "story"),
        messages: [
          { role: "system", content: STORY_SYSTEM },
          { role: "user", content: buildStoryPrompt(avoid) },
        ],
        // 正文 600～700 字 + 标题（约 1100～1400 token）。显式给足上限：
        // 不传就是厂商默认值，推理型模型一思考就可能把额度吃光 → content 为空（见 llm.ts）。
        maxTokens: 6000,
      });
    } catch (e) {
      if (handleLlmError(res, e)) return;
      throw e;
    }

    const parsed = parseStory(result.text);
    const id = await addStory(childId, parsed.title, parsed.text);
    await addReadTitle(childId, parsed.title);

    ok(res, {
      id,
      title: parsed.title,
      text: parsed.text,
      charCount: parsed.text.replace(/\s/g, "").length,
      avoidCount: avoid.length,
      ms: result.ms,
      model: result.model,
      cached: false,
    });
  }),
);

storyRouter.get(
  "/stories",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const limit = qInt(req.query.limit, 20, 1, 100);
    ok(res, {
      stories: await listStories(childId, limit),
      readTitles: await listReadTitles(childId),
    });
  }),
);

storyRouter.get(
  "/stories",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const limit = qInt(req.query.limit, 20, 1, 100);
    ok(res, {
      stories: await listStories(childId, limit),
      readTitles: await listReadTitles(childId),
    });
  }),
);
