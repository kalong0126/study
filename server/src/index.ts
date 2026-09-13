/**
 * 二年级快乐学习台 · 后端入口
 *
 * 启动顺序有意为之：
 *   配置 → 目录 → 数据库 → 内容种子 → 清理中断任务 → 起 HTTP → 安排定时备份
 * 任何一步失败都直接退出并打印原因，避免「服务起来了但根本不能用」这种更难查的状态。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { SERVER_ROOT, ensureDirs, loadConfig, maskKey, resolveAllLlm, startupWarnings } from "./config.js";
import { dotEnvCandidates, dotEnvSummary } from "./env.js";
import { closeDb, initDb } from "./db/index.js";
import { kvGet } from "./db/repo/state.js";
import { logHttp, logSys } from "./logger.js";
import { adminRouter } from "./routes/admin.js";
import { backupRouter } from "./routes/backup.js";
import { diagRouter } from "./routes/diag.js";
import { fail } from "./routes/helpers.js";
import { healthRouter } from "./routes/health.js";
import { lessonsRouter } from "./routes/lessons.js";
import { markRouter } from "./routes/mark.js";
import { pointsRouter } from "./routes/points.js";
import { stateRouter } from "./routes/state.js";
import { storyRouter } from "./routes/story.js";
import { ttsRouter } from "./routes/tts.js";
import { seedLessons } from "./seed/index.js";
import { scheduleDailyBackup, stopDailyBackup } from "./services/backup.js";
import { currentChildId } from "./services/child.js";
import { failStaleTasks } from "./services/mark.js";
import { setRuntimeVoice, ttsInfo } from "./services/tts/index.js";

function localAddresses(port: number): string[] {
  const out: string[] = [];
  // 过滤掉虚拟网卡（WSL / Docker / VMware / VirtualBox）：
  // 它们的地址打印出来只会误导——平板根本连不上 172.17.x.x 这种。
  const VIRTUAL = /wsl|docker|veth|vmware|virtualbox|hyper-v|loopback|tailscale|zerotier/i;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const info of ifaces[name] ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (info.address.startsWith("169.254.")) continue; // APIPA，无效地址
      out.push(`http://${info.address}:${port}`);
    }
  }
  return out;
}

function createApp(): express.Express {
  const cfg = loadConfig();
  const app = express();
  app.disable("x-powered-by");

  app.use(
    cors({
      origin: cfg.server.corsOrigins.length ? cfg.server.corsOrigins : true,
      credentials: false,
    }),
  );

  // 手写判卷要传 base64 图片，8 张字图 + 1 张合成图，30MB 留足余量
  app.use(express.json({ limit: "30mb" }));
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));

  // 请求日志：4xx/5xx 记 warn，音频请求降为 debug（量大且无信息量）
  app.use((req: Request, res: Response, next: NextFunction) => {
    const t0 = Date.now();
    // 注意：必须在进入 router 之前把路径存下来。
    // Express 在 app.use("/api", api) 时会改写 req.url，等 res 的 finish 事件触发时
    // 再读 req.path 拿到的已经是去掉挂载前缀的 "/health"，日志里就看不出完整路径了。
    const fullPath = (req.originalUrl || req.url || "").split("?")[0];
    res.on("finish", () => {
      const ms = Date.now() - t0;
      if (fullPath === "/api/health" || fullPath.startsWith("/api/diag/logs")) return;
      const fields = {
        method: req.method,
        path: fullPath,
        status: res.statusCode,
        ms,
        bytes: Number(res.getHeader("content-length") ?? 0) || undefined,
      };
      if (res.statusCode >= 400) logHttp.warn(fields, "请求异常");
      else if (fullPath.startsWith("/api/tts")) logHttp.debug(fields, "请求");
      else logHttp.info(fields, "请求");
    });
    next();
  });

  const api = express.Router();
  api.use(healthRouter);
  api.use(lessonsRouter);
  api.use(storyRouter);
  api.use(ttsRouter);
  api.use(markRouter);
  api.use(pointsRouter);
  api.use(stateRouter);
  api.use(adminRouter);
  api.use(backupRouter);
  api.use(diagRouter);
  api.use((req: Request, res: Response) => {
    fail(res, 404, `接口不存在：${req.method} ${req.originalUrl}`);
  });
  app.use("/api", api);

  // 若前端已构建（web/dist 存在），顺手由后端托管，省一个 nginx
  const webDist = path.resolve(SERVER_ROOT, "..", "web", "dist");
  if (fs.existsSync(webDist)) {
    // 带 hash 的资源文件可以放心缓存 1 小时；但 index.html 绝对不能缓存：
    // 重新构建后文件名 hash 会变，浏览器若还用缓存的旧 index.html，
    // 就会去引用已经被删掉的旧 chunk，表现为「改了代码看不到效果」。
    const noStoreIndex = { "Cache-Control": "no-cache, must-revalidate" };
    app.use(
      express.static(webDist, {
        index: "index.html",
        maxAge: "1h",
        setHeaders(res, filePath) {
          if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache, must-revalidate");
        },
      }),
    );
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET" || req.path.startsWith("/api")) return next();
      // SPA 回退同样不缓存
      res.sendFile(path.join(webDist, "index.html"), { headers: noStoreIndex });
    });
    logSys.info({ webDist }, "已启用前端静态托管");
  } else {
    logSys.info({ webDist }, "未找到前端构建产物（web/dist），仅提供 API（开发时用 Vite dev server）");
  }

  // 兜底错误处理
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err.type === "entity.too.large") {
      fail(res, 413, "请求体过大（单次提交的图片总体积请控制在 30MB 内）");
      return;
    }
    logSys.error({ err }, "未捕获的请求错误");
    fail(res, err.status ?? 500, err.message || "服务器内部错误");
  });

  return app;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  ensureDirs(cfg);

  logSys.info(
    {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      config: path.join(SERVER_ROOT, "config", "config.yaml"),
    },
    "正在启动 二年级快乐学习台 后端",
  );

  // 把「配置从哪儿来的」讲清楚，避免出现「明明填了 key 却说没配置」的困惑
  const envFiles = dotEnvSummary();
  if (envFiles.length) logSys.info({ 来源: envFiles.join("、") }, "已加载 .env");
  else logSys.info({ 查找过: dotEnvCandidates().join("、") }, "没有可用的 .env（全部靠环境变量或 config.yaml 默认值）");

  for (const w of startupWarnings(cfg)) logSys.warn(w);

  await initDb();

  // 恢复家长上次在后台选的音色（存 app_kv child_id=0，系统级）
  const savedVoice = await kvGet<string>(0, "ttsVoice");
  if (savedVoice) {
    setRuntimeVoice(savedVoice);
    logSys.info({ voice: savedVoice }, "已恢复上次选择的音色");
  }

  const childId = await currentChildId();
  logSys.info({ childId }, "当前孩子上下文就绪");

  const cleaned = await failStaleTasks();
  if (cleaned) logSys.warn({ cleaned }, "已把上次异常退出遗留的判卷任务标记为失败");

  const seed = await seedLessons();
  if (seed.created) logSys.info(seed, "首次启动，已导入课文种子数据");
  else logSys.info({ lessons: seed.lessons }, "课文数据已存在，跳过种子导入");

  const tts = ttsInfo();
  logSys.info(
    { provider: tts.provider, voice: tts.voice, rate: tts.rate, cacheDir: tts.cacheDir },
    "语音合成配置",
  );
  // 逐个用途打印最终生效的模型与厂商，配错了一眼能看出来
  for (const p of resolveAllLlm(cfg)) {
    logSys.info(
      {
        用途: p.purpose,
        model: p.model || "(未配置)",
        地址: p.baseUrl,
        provider: p.usingOwnProvider ? "独立" : "共享",
        key: p.apiKey ? maskKey(p.apiKey) : "(未配置)",
      },
      "大模型配置",
    );
  }

  const app = createApp();
  const server = app.listen(cfg.server.port, cfg.server.host, () => {
    logSys.info({ port: cfg.server.port, host: cfg.server.host }, "服务已就绪");
    for (const addr of localAddresses(cfg.server.port)) {
      logSys.info({ 访问地址: addr }, "平板 / 电脑可用这个地址打开");
    }
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      logSys.fatal({ port: cfg.server.port }, `端口 ${cfg.server.port} 已被占用，请改 config.yaml 里的 server.port`);
    } else {
      logSys.fatal({ err: e }, "HTTP 服务启动失败");
    }
    process.exit(1);
  });

  scheduleDailyBackup(currentChildId);

  const shutdown = async (signal: string): Promise<void> => {
    logSys.info({ signal }, "收到退出信号，正在关闭…");
    stopDailyBackup();
    server.close();
    await closeDb();
    logSys.info("已安全退出");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logSys.error({ err: reason }, "未处理的 Promise 拒绝（已忽略，服务继续运行）");
  });
  process.on("uncaughtException", (e) => {
    logSys.fatal({ err: e }, "未捕获异常");
  });
}

main().catch((e) => {
  // 这里还没法用 logger（可能配置都读不出来），直接输出到 stderr
  console.error("\n启动失败：");
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
