/**
 * 二年级快乐学习台 · 后端入口
 *
 * 启动顺序有意为之：
 *   配置 → 目录 → 数据库 → 内容种子 → 清理中断任务 → 起 HTTP → 安排定时备份
 * 任何一步失败都直接退出并打印原因，避免「服务起来了但根本不能用」这种更难查的状态。
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  SERVER_ROOT,
  ensureDirs,
  loadConfig,
  maskKey,
  resolveAllLlm,
  resolveHttps,
  resolvedConfigPath,
  setLlmRuntimeOverride,
  startupWarnings,
  valueSource,
} from "./config.js";
import { dotEnvCandidates, dotEnvSummary } from "./env.js";
import { closeDb, initDb } from "./db/index.js";
import { kvGet } from "./db/repo/state.js";
import { logHttp, logSys } from "./logger.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { backupRouter } from "./routes/backup.js";
import { diagRouter } from "./routes/diag.js";
import { fail } from "./routes/helpers.js";
import { healthRouter } from "./routes/health.js";
import { languageRouter } from "./routes/language.js";
import { lessonsRouter } from "./routes/lessons.js";
import { pointsRouter } from "./routes/points.js";
import { stateRouter } from "./routes/state.js";
import { storyRouter } from "./routes/story.js";
import { ttsRouter } from "./routes/tts.js";
import { videoRouter } from "./routes/video.js";
import { seedLessons } from "./seed/index.js";
import { createGuard } from "./services/auth.js";
import { scheduleDailyBackup, stopDailyBackup } from "./services/backup.js";
import { currentChildId } from "./services/child.js";
import { imagegenInfo } from "./services/imagegen.js";
import { setRuntimeVoice, ttsInfo } from "./services/tts/index.js";

function localAddresses(port: number, scheme: "http" | "https"): string[] {
  const out: string[] = [];
  // 过滤掉虚拟网卡（WSL / Docker / VMware / VirtualBox）：
  // 它们的地址打印出来只会误导——平板根本连不上 172.17.x.x 这种。
  const VIRTUAL = /wsl|docker|veth|vmware|virtualbox|hyper-v|loopback|tailscale|zerotier/i;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const info of ifaces[name] ?? []) {
      if (info.internal) continue;
      if (info.family === "IPv4") {
        if (info.address.startsWith("169.254.")) continue; // APIPA，无效地址
        out.push(`${scheme}://${info.address}:${port}`);
      } else if (info.family === "IPv6") {
        // 只报「出门能路由」的全局地址：fe80:: 是链路本地、fc/fd 是 ULA，都到不了公网。
        // 做 DDNS 时注意这种隐私扩展地址会定期变，别把带临时标记的那个填进去。
        if (/^(fe80|f[cd])/i.test(info.address)) continue;
        out.push(`${scheme}://[${info.address}]:${port}`);
      }
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

  // 家长后台恢复导入的备份 JSON 可能很大（含全部学习历史），给足余量
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
      // 视频流一个片子要发几十上百个 Range 片段，逐条 info 会把日志刷爆
      else if (fullPath.startsWith("/api/video/stream")) logHttp.debug(fields, "请求");
      else logHttp.info(fields, "请求");
    });
    next();
  });

  const api = express.Router();

  // ① 健康检查 + 登录：必须排在鉴权网关**之前**。
  //    前端的启动流程就是靠 /auth/me 判断「这一步要不要先弹口令框」。
  api.use(healthRouter);
  api.use(authRouter);

  // ② 鉴权网关：公网（来源地址不在内网）只放孩子端 ——
  //    内容后台 / 备份恢复 / 运行诊断 / 预生成音频一律拒；内网默认照旧不受影响。
  //    具体哪些路径算「家长专属」集中在 services/auth.ts 的 isParentOnly()。
  api.use(createGuard(cfg));

  // ③ 业务接口
  api.use(lessonsRouter);
  api.use(storyRouter);
  api.use(languageRouter);
  api.use(videoRouter);
  api.use(ttsRouter);
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
      config: resolvedConfigPath(),
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

  // 恢复家长上次在后台填的模型名 / API Key（存 app_kv child_id=0，系统级）
  const savedLlm = await kvGet<Record<string, string>>(0, "llmRuntime");
  if (savedLlm && typeof savedLlm === "object") {
    setLlmRuntimeOverride({
      storyModel: savedLlm.storyModel,
      storyApiKey: savedLlm.storyApiKey,
    });
    logSys.info({ keys: Object.keys(savedLlm).join("、") }, "已恢复上次填写的模型配置");
  }

  const childId = await currentChildId();
  logSys.info({ childId }, "当前孩子上下文就绪");

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

  // 文生图（语言强化看图题的配图），Key 独立配置（imagegen.apiKey / IMAGEGEN_API_KEY）
  const ig = imagegenInfo();
  logSys.info(
    {
      enabled: ig.enabled,
      model: ig.model,
      size: ig.size,
      key: ig.configured ? "已配置" : "(未配置，看图题将退回文字描述)",
    },
    "文生图配置",
  );

  // 英文故事的视频目录。共享没挂上时这里只是记录配置，真正的连通性问题由页面自己报
  // （启动时去 stat 一个 SMB 路径会拖慢启动，而且共享迟一点挂上也完全正常）
  logSys.info(
    {
      enabled: cfg.video.enabled,
      目录: cfg.video.dir || "(未配置，页面会提示家长填)",
      格式: cfg.video.exts.join(" "),
    },
    "英文故事视频配置",
  );

  // 鉴权：只打状态，绝不打口令本身。
  // 「来自 ...」这一项是**故意**加的：容器里生效的是打进镜像的那份 config.yaml，
  // 「在 .env 里配了口令却登不上」几乎都是它没被读到（或镜像里的那份是旧版）。
  if (cfg.server.auth.enabled) {
    logSys.info(
      {
        内网免口令: cfg.server.auth.lanBypass,
        信任网段: cfg.server.auth.lanCidrs.length
          ? cfg.server.auth.lanCidrs.join(" ")
          : "(未配置 → 容器里一律按公网处理，家里也要输口令；非容器则自动按本机网段)",
        公网策略: cfg.server.auth.forcePublic ? "全部按公网处理（forcePublic）" : "按来源地址区分",
        会话天数: cfg.server.auth.sessionDays,
        孩子口令: cfg.server.auth.childPin
          ? `已设置（${cfg.server.auth.childPin.length} 位，来自 ${valueSource("CHILD_PIN")}）`
          : "(未设置 → 公网将无人能登录)",
        家长口令: cfg.server.auth.parentPin
          ? `已设置（仅内网可用，来自 ${valueSource("PARENT_PIN")}）`
          : "(未设置)",
      },
      "访问鉴权已开启",
    );
  } else {
    logSys.warn(
      "访问鉴权未开启（server.auth.enabled=false）→ 能连上这个端口就能读写全部数据。只建议在纯内网使用。",
    );
  }

  const app = createApp();

  // HTTPS：安卓 Chrome 只有在安全上下文里才会把网页装成应用（WebAPK，没有地址栏和底栏），
  // 也才能注册 Service Worker。证书读不出来时 resolveHttps 会给出 problem，
  // 这里**回退 HTTP 而不是退出** —— 学习台停服比降级糟得多，具体原因 startupWarnings 已经喊过了。
  const tls = resolveHttps(cfg);
  if (tls.enabled) {
    logSys.info({ cert: tls.certFile }, "已启用 HTTPS（安全上下文，平板可安装为应用）");
  }

  const scheme: "http" | "https" = tls.enabled ? "https" : "http";
  const server: http.Server = tls.enabled
    ? https.createServer({ cert: tls.cert ?? undefined, key: tls.key ?? undefined }, app)
    : http.createServer(app);

  // "::" = 双栈，IPv4 与 IPv6 一起收 —— 这是「公网 IPv6 直连」的前提。
  // 显式写 ipv6Only:false 是不赌系统默认值：某些平台上 "::" 默认只收 IPv6，
  // 那样内网的 IPv4 设备（平板、电脑）会突然全部连不上。
  const host = cfg.server.host;
  const listenOpts: { port: number; host: string; ipv6Only?: boolean } =
    host === "::" || host === ""
      ? { port: cfg.server.port, host: "::", ipv6Only: false }
      : { port: cfg.server.port, host };

  server.listen(listenOpts, () => {
    logSys.info(
      { port: cfg.server.port, host, scheme, stack: listenOpts.ipv6Only === false ? "IPv4+IPv6（双栈）" : "IPv4" },
      "服务已就绪",
    );
    for (const addr of localAddresses(cfg.server.port, scheme)) {
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
