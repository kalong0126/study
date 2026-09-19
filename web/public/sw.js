/**
 * 二年级快乐学习台 · Service Worker
 *
 * 为什么需要它：光有 manifest 是装不成应用的。安卓 Chrome 要生成 WebAPK
 * （独立窗口、没有地址栏和底栏），必须三条同时满足：
 *   1. 安全上下文（https:// 或 http://localhost）
 *   2. manifest 里有 name / short_name / start_url / display:standalone / ≥144px 图标
 *   3. 已注册的 Service Worker，且它监听了 fetch 事件
 * 少任何一条，「添加到主屏幕」就退化成普通书签快捷方式 —— 打开还是 Chrome，地址栏和底栏都在。
 *
 * 缓存策略是刻意保守的，因为这个应用不是纯静态页面：
 *   · navigation（HTML）→ **network-first**。
 *     绝不能 cache-first：前端每次构建都会换 chunk 的 hash，旧 index.html 会去引用
 *     已经被删掉的 chunk，直接白屏。后端也是为此把 index.html 设成 no-cache 的。
 *   · /api/** → **一律放行**，完全不碰。
 *     状态、判卷、语音都在这里；语音后端自己带 7 天强缓存，SW 再存一份纯属浪费空间。
 *   · /assets/** 和 /fonts/** → cache-first。文件名带 hash，内容变了名字必变，缓存永远是安全的。
 *     字体（方正准圆简体）一百多个切片、1.3MB，虽然按 unicode-range 只下真正用到的那几片，
 *     也仍然不该每次进页面都重发一遍请求。
 *   · 其余同源 GET（manifest / 图标）→ stale-while-revalidate。
 *
 * 改了下面的缓存清单或策略，记得把 VERSION 加一，否则老 SW 不会更新。
 */
const VERSION = "v3";
const CACHE = `grade2-shell-${VERSION}`;

/** app shell：只预缓存这几个，不带 hash 的入口文件 */
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 逐个 add 并各自兜住失败：缺一张图标不能让整个 SW 装不上
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/** 只有「同源 + 200」的响应才值得存；304 / opaque / 错误页一律不存 */
function isCacheable(res) {
  return !!res && res.status === 200 && res.type === "basic";
}

async function networkFirst(req, cache) {
  try {
    const res = await fetch(req);
    // 统一存成 "/"：不管访问的是 / 还是 /story，SPA 返回的都是同一份 index.html
    if (isCacheable(res)) await cache.put("/", res.clone());
    return res;
  } catch {
    const hit = await cache.match("/");
    return hit ?? Response.error();
  }
}

async function cacheFirst(req, cache) {
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (isCacheable(res)) await cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, cache) {
  const hit = await cache.match(req);
  const net = fetch(req)
    .then(async (res) => {
      if (isCacheable(res)) await cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit ?? Response.error());
  return hit ?? net;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 接口完全不插手（含 /api/tts 的音频）
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (req.mode === "navigate") return networkFirst(req, cache);
      // 字体文件名带内容哈希 → 内容不变、改了必改文件名，缓存优先最合适，
      // 不必像 stale-while-revalidate 那样每次都发一次网络请求。
      if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/")) {
        return cacheFirst(req, cache);
      }
      return staleWhileRevalidate(req, cache);
    })(),
  );
});
