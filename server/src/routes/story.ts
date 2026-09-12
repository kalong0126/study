/**
 * 童话生成
 *
 * 与旧版相比：密钥改为后端持有、请求改为后端发起（不再受浏览器 CORS 限制），
 * 并且让模型第一行显式输出《标题》，标题因此变成真标题而不是正文的前 12 个字。
 */
import { Router } from "express";
import { loadConfig, resolveLlm } from "../config.js";
import { addReadTitle, addStory, listReadTitles, listStories } from "../db/repo/state.js";
import { currentChildId } from "../services/child.js";
import { chat } from "../services/llm.js";
import { STORY_SYSTEM, buildStoryPrompt, parseStory } from "../services/prompts/storyPrompt.js";
import { ah, handleLlmError, ok, qInt } from "./helpers.js";

export const storyRouter = Router();

storyRouter.post(
  "/story/generate",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const cfg = loadConfig();

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
