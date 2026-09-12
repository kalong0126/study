/**
 * 路径常量。
 *
 * 单独抽成一个模块，是为了断开 config ⇄ env 的循环导入：
 * config 需要 env 来读 .env，env 需要 SERVER_ROOT 来定位候选文件——
 * 两边都从这里取，就没有环了（否则 ESM 下会踩 const 的 TDZ，报未初始化）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** server/ 根目录（dev 时这里是 src/，构建后是 dist/，上一级都是 server/） */
export const SERVER_ROOT = path.resolve(here, "..");

/** 仓库根目录（server/ 的上一级） */
export const REPO_ROOT = path.resolve(SERVER_ROOT, "..");
