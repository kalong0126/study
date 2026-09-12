/**
 * 轻量 .env 加载器
 *
 * 为什么不引 dotenv：
 *   1. 我们只需要读 KEY=VALUE，为这点解析加一个依赖不划算；
 *   2. 「谁优先」的规则必须由我们完全掌握 —— 真实环境变量永远压过 .env，
 *      否则容器里注入的值会被镜像里的 .env 悄悄覆盖，那种 bug 极难查。
 *
 * 查找顺序（先命中的先赢，多个文件可互补）：
 *   server/.env   →   仓库根 .env   →   deploy/.env
 *
 * 把 deploy/.env 也纳入，是因为它原本是给 docker compose 用的，
 * 但本地直接跑后端时顺手读一下，用户就不必把 key 再抄一遍。
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, SERVER_ROOT } from "./paths.js";

/** 候选文件，按优先级从高到低 */
const CANDIDATES = [
  path.join(SERVER_ROOT, ".env"),
  path.join(REPO_ROOT, ".env"),
  path.join(REPO_ROOT, "deploy", ".env"),
];

/** 实际提供了新变量的文件（供启动日志展示） */
const loaded: string[] = [];

/**
 * 解析 .env 文本。
 * 支持：空行 / `#` 注释 / `export KEY=VALUE` / 单双引号 / 值里的 `#` / CRLF
 * 忽略：不合法的行（不抛错，避免一个手滑的字符就让服务起不来）
 */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // 允许 `export LLM_API_KEY=xxx` 这种从 shell 里复制过来的写法
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;

    const eq = body.indexOf("=");
    if (eq <= 0) continue;

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = body.slice(eq + 1).trim();

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2) {
      // 引号包裹：原样取值，里面的 # 不算注释
      const end = value.lastIndexOf(quote);
      if (end > 0) {
        value = value.slice(1, end);
        if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      }
    } else {
      // 无引号：行尾 ` #xxx` 视为注释
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

let done = false;

/**
 * 把 .env 里的变量填进 process.env。
 * **已有的变量一律不动**（真实环境变量优先；多文件也是先命中的优先）。
 */
export function loadDotEnv(force = false): void {
  if (done && !force) return;
  done = true;
  loaded.length = 0;

  for (const file of CANDIDATES) {
    let text: string;
    try {
      if (!fs.existsSync(file)) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    let used = 0;
    for (const [k, v] of Object.entries(parseEnv(text))) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
        used += 1;
      }
    }

    // 只登记真的提供了新变量的文件，避免日志里列一堆空文件
    if (used > 0) loaded.push(`${file} (${used} 项)`);
  }
}

/** 供启动日志展示：这次到底从哪儿读到了配置 */
export function dotEnvSummary(): string[] {
  return [...loaded];
}

/** 候选文件清单，报错时告诉用户「该放哪儿」 */
export function dotEnvCandidates(): string[] {
  return [...CANDIDATES];
}
