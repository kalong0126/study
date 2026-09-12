/**
 * TTS 磁盘缓存
 *
 * 寻址方式：把「文本 + 音色 + 语速 + 音量 + 音调」序列化后取 sha1，
 * 前两位做子目录（避免单目录堆几万个文件），文件名就是完整 hash。
 *
 * 这样做的收益：课文生字音频**只合成一次，永久复用**。
 * 孩子听写时点一下就有声，不依赖网络，也不受临时限流影响。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../config.js";

export interface CacheKeyParts {
  text: string;
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
  provider: string;
}

export function buildCacheKey(parts: CacheKeyParts): string {
  const raw = [
    `provider=${parts.provider}`,
    `voice=${parts.voice}`,
    `rate=${parts.rate}`,
    `volume=${parts.volume}`,
    `pitch=${parts.pitch}`,
    `text=${parts.text}`,
  ].join("|");
  return crypto.createHash("sha1").update(raw, "utf8").digest("hex");
}

export function keyToPath(key: string): string {
  const dir = loadConfig().tts.cacheDir;
  return path.join(dir, key.slice(0, 2), `${key}.mp3`);
}

export async function readCache(key: string): Promise<Buffer | null> {
  const p = keyToPath(key);
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile() || st.size < 128) return null; // 太小的当坏文件
    return await fs.promises.readFile(p);
  } catch {
    return null;
  }
}

export async function writeCache(key: string, buf: Buffer): Promise<void> {
  const p = keyToPath(key);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  // 先写临时文件再改名，避免并发读到一个写了一半的文件
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, buf);
  await fs.promises.rename(tmp, p);
}

export interface CacheStats {
  count: number;
  bytes: number;
  dir: string;
}

export async function cacheStats(): Promise<CacheStats> {
  const dir = loadConfig().tts.cacheDir;
  let count = 0;
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith(".mp3")) {
        count++;
        try {
          bytes += (await fs.promises.stat(full)).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  await walk(dir);
  return { count, bytes, dir };
}

export async function clearCache(): Promise<{ removed: number; bytes: number }> {
  const dir = loadConfig().tts.cacheDir;
  const before = await cacheStats();
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return { removed: before.count, bytes: before.bytes };
}

/**
 * 超出容量上限时，按最后访问时间（近似用 mtime）从旧到新删。
 * 生字音频一旦生成通常会被反复命中，所以用 mtime 排序够用了。
 */
export async function enforceMaxSize(maxMB: number): Promise<{ removed: number; bytes: number }> {
  if (maxMB <= 0) return { removed: 0, bytes: 0 };
  const dir = loadConfig().tts.cacheDir;
  const files: { p: string; size: number; mtime: number }[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith(".mp3")) {
        try {
          const st = await fs.promises.stat(full);
          files.push({ p: full, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  await walk(dir);

  const total = files.reduce((n, f) => n + f.size, 0);
  const limit = maxMB * 1024 * 1024;
  if (total <= limit) return { removed: 0, bytes: 0 };

  files.sort((a, b) => a.mtime - b.mtime);
  let freed = 0;
  let removed = 0;
  let cur = total;
  for (const f of files) {
    if (cur <= limit) break;
    try {
      await fs.promises.unlink(f.p);
      cur -= f.size;
      freed += f.size;
      removed++;
    } catch {
      /* ignore */
    }
  }
  return { removed, bytes: freed };
}
