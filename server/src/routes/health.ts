import { Router } from "express";
import { loadConfig, startupWarnings } from "../config.js";
import { db } from "../db/index.js";
import { countChars, listLessons } from "../db/repo/lessons.js";
import { llmConfigSummary } from "../services/llm.js";
import { ttsInfo, ttsStats } from "../services/tts/index.js";
import { ah, ok } from "./helpers.js";

const startedAt = Date.now();

export const healthRouter = Router();

healthRouter.get(
  "/health",
  ah(async (_req, res) => {
    const cfg = loadConfig();
    const lessons = await listLessons(false);
    const chars = await countChars();
    const tts = await ttsStats();
    ok(res, {
      version: "1.0.0",
      uptimeMs: Date.now() - startedAt,
      db: { driver: db().driver, lessons: lessons.length, chars },
      llm: llmConfigSummary(),
      tts: { ...ttsInfo(), cacheCount: tts.count, cacheBytes: tts.bytes },
      server: { port: cfg.server.port, host: cfg.server.host, authEnabled: cfg.server.auth.enabled },
      warnings: startupWarnings(cfg),
    });
  }),
);
