/**
 * 备份与恢复接口
 */
import { Router } from "express";
import { todayStr } from "../db/index.js";
import { currentChildId } from "../services/child.js";
import { exportAll, listBackupFiles, restorePack, runBackup } from "../services/backup.js";
import { ah, fail, ok } from "./helpers.js";

export const backupRouter = Router();

/** 下载全量 JSON（浏览器直接下载文件） */
backupRouter.get(
  "/backup",
  ah(async (_req, res) => {
    const childId = await currentChildId();
    const pack = await exportAll(childId);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="grade2-backup-${todayStr()}.json"`);
    res.send(JSON.stringify(pack, null, 2));
  }),
);

backupRouter.get(
  "/backup/list",
  ah(async (_req, res) => {
    const files = await listBackupFiles();
    ok(res, {
      files: files.map((f) => ({ file: f.file, kb: Math.round(f.bytes / 1024), at: new Date(f.mtime).toISOString() })),
    });
  }),
);

backupRouter.post(
  "/backup/run",
  ah(async (_req, res) => {
    const childId = await currentChildId();
    const r = await runBackup(childId);
    ok(res, { file: r.file, kb: Math.round(r.bytes / 1024) });
  }),
);

/**
 * 恢复。
 * 兼容两种文件：本服务导出的 v2 备份，以及老版单文件 HTML 导出的 v1 备份。
 * 请求体可以是备份对象本身，也可以是 { pack, mode, skipDemo }。
 */
backupRouter.post(
  "/restore",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const wrapped = body.pack && typeof body.pack === "object";
    const pack = wrapped ? body.pack : body;
    const mode = body.mode === "replace" ? "replace" : "merge";
    const skipDemo = body.skipDemo !== false;

    try {
      const summary = await restorePack(childId, pack, { mode, skipDemo });
      ok(res, { summary });
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : String(e))
    }
  }),
);
