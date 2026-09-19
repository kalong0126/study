# -*- coding: utf-8 -*-
"""把 Google Fonts 的站酷快乐体（ZCOOL KuaiLe）拉成本地自托管字体。

为什么自托管而不是直接连 Google：
  孩子端是家里的平板，正文/标题全靠网络拉字体的话，断网或墙一动就回落成雅黑，
  「可爱」直接没了。字体切片本来就带 unicode-range，浏览器只下载页面真正用到的
  那几个切片（首页约 3 个、几十 KB），本地托管和 CDN 的加载量是一样的。

产物：
  web/public/fonts/zcool-kuaile/*.woff2   （原样拷进 dist，不走打包）
  web/src/styles/font-zcool.css           （@font-face + unicode-range）
"""
import os
import re
import urllib.request

CSS_URL = "https://fonts.googleapis.com/css2?family=ZCOOL+KuaiLe&display=swap"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
OUT_DIR = r"D:\aiprojects\study\web\public\fonts\zcool-kuaile"
CSS_OUT = r"D:\aiprojects\study\web\src\styles\font-zcool.css"
PUBLIC_BASE = "/fonts/zcool-kuaile"

os.makedirs(OUT_DIR, exist_ok=True)

req = urllib.request.Request(CSS_URL, headers={"User-Agent": UA})
css = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")

urls = sorted(set(re.findall(r"url\((https://fonts\.gstatic\.com/[^)]+)\)", css)))
print(f"切片 {len(urls)} 个")

total = 0
cache = {}
for u in urls:
    name = u.rsplit("/", 1)[-1].split("?")[0]
    if not name.endswith(".woff2"):
        name += ".woff2"
    dst = os.path.join(OUT_DIR, name)
    if not os.path.exists(dst):
        r = urllib.request.Request(u, headers={"User-Agent": UA})
        data = urllib.request.urlopen(r, timeout=60).read()
        with open(dst, "wb") as f:
            f.write(data)
    else:
        data = open(dst, "rb").read()
    cache[u] = name
    total += len(data)

# 把远端 URL 换成本地路径，其余（font-family / unicode-range / font-display）原样保留
out = css
for remote, local in cache.items():
    out = out.replace(f"url({remote})", f"url({PUBLIC_BASE}/{local})")

# 字重保持 Google 原生的 400，不要改写成 `100 900`。
#
# 曾经改成 100 900，理由是「这样浏览器就不再合成加粗，小字号不会糊」。那是误判：
# @font-face 声明一个字重区间后，浏览器会认为这款字体**自带全部字重**、于是不再合成 ——
# 结果是全站 400 和 900 渲染成同一个粗细（实测 32px 汉字 400/700/900 宽度都是 147.2px），
# 标题、数字、按钮的层级全部消失，整页「平」成一片；而当时看到的糊，
# 真正的元凶是同时叠加的 `-webkit-text-stroke` 描边补粗（已一并删掉）。
#
# 声明真实字重 400 后，浏览器对 700/800/900 做合成加粗，重新有了粗细层次。
# 实测 12.5 / 13.5 / 16 / 18 / 23 / 30px 六档字号下，合成加粗都清晰、笔画不粘连
# （对照图见 web/test/shots/font/weight-cmp.png，回归断言在 isle-map.mjs）。

header = (
    "/* 站酷快乐体（ZCOOL KuaiLe，SIL OFL 1.1）—— 自托管，不连 Google。\n"
    "   切片与 unicode-range 由 Google Fonts 生成：浏览器只下载页面真正用到的切片，\n"
    "   首页几十个字大约命中 3 个切片（几十 KB）。\n"
    "   font-weight 保持真实值 400：700/800/900 交给浏览器合成加粗，这样才有粗细层次。\n"
    "   千万不要改成 `100 900` 区间 —— 那会让全站所有字重渲染成一个粗细（详见脚本内注释）。\n"
    "   本文件由 scripts/fetch-round-font.py 生成，不要手改；换字体改脚本再跑一次。 */\n\n"
)
with open(CSS_OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(header + out)

print(f"字体共 {total / 1024:.0f} KB -> {OUT_DIR}")
print(f"样式 -> {CSS_OUT}")
