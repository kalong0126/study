#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
下载圆体拉丁字体（数字 / 英文 / 符号的专用字体）。

为什么需要这个：站酷快乐体是展示型中文字体，它的数字与西文是「手写涂鸦」风 ——
`0` 是歪斜的椭圆、`1` 像一撇、每个数字宽度都不齐，而且没有 tabular-nums 特性。
站点里数字用量极大（积分 30px/900、进度 0/6、口算答案输入、用时 1:32、+10 奖励），
用它渲染既难看又读不准，叠上合成加粗后小字号还会糊成实心块。

做法：CSS 里把圆体拉丁放在中文字体**之前**，`font-family` 是逐字符回退 ——
数字/字母命中拉丁字体，汉字没有字形就落到站酷快乐体。中文的可爱感不受影响。

用法：python scripts/fetch-latin-font.py <slug> "<Google Fonts family+axis>"
  例：python scripts/fetch-latin-font.py nunito "Nunito:wght@200..1000"
      python scripts/fetch-latin-font.py baloo2 "Baloo+2:wght@400..800"
"""
import os
import re
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_BASE = "/fonts"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# 只要拉丁：数字、英文、常用符号都在 latin / latin-ext 里；
# cyrillic / vietnamese / greek 这些切片整个站点都用不到，不下。
KEEP_SUBSETS = ("latin", "latin-ext")

slug = sys.argv[1]
family = sys.argv[2]
name = slug
OUT_DIR = os.path.join(REPO, "web", "public", "fonts", name)
CSS_OUT = os.path.join(REPO, "web", "src", "styles", f"font-{slug}.css")
os.makedirs(OUT_DIR, exist_ok=True)

url = f"https://fonts.googleapis.com/css2?family={family}&display=swap"
req = urllib.request.Request(url, headers={"User-Agent": UA})
css = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")

# 按注释里的 subset 名切块，只留需要的子集
blocks = re.split(r"(/\*\s*[a-z-]+\s*\*/)", css)
picked = []
cur_subset = None
for chunk in blocks:
    m = re.match(r"/\*\s*([a-z-]+)\s*\*/", chunk)
    if m:
        cur_subset = m.group(1)
        continue
    if cur_subset in KEEP_SUBSETS and "@font-face" in chunk:
        picked.append(chunk)
css = "".join(picked)
if not css.strip():
    raise SystemExit(f"没切到任何 @font-face（子集 {KEEP_SUBSETS}），检查 family 写法：{family}")

urls = sorted(set(re.findall(r"url\((https://fonts\.gstatic\.com/[^)]+)\)", css)))
print(f"切片 {len(urls)} 个（子集 {'/'.join(KEEP_SUBSETS)}）")

cache = {}
total = 0
for u in urls:
    fn = u.rsplit("/", 1)[-1].split("?")[0]
    if not fn.endswith((".woff2", ".woff", ".ttf")):
        fn += ".woff2"
    dst = os.path.join(OUT_DIR, fn)
    if not os.path.exists(dst):
        r = urllib.request.Request(u, headers={"User-Agent": UA})
        data = urllib.request.urlopen(r, timeout=60).read()
        with open(dst, "wb") as f:
            f.write(data)
    else:
        data = open(dst, "rb").read()
    cache[u] = fn
    total += len(data)

out = css
for remote, local in cache.items():
    out = out.replace(f"url({remote})", f"url({PUBLIC_BASE}/{name}/{local})")

weight_line = re.search(r"font-weight:\s*([0-9 ]+);", out)
info = weight_line.group(1).strip() if weight_line else "?"

# 把 U+2000-206F（通用标点）从覆盖范围里摘掉，让这些字符落到中文字体去。
#
# Google 给的 latin 子集 unicode-range 里带着 U+2000-206F，这一块含：
#   U+2018-201F  弯引号 ‘ ’ “ ”
#   U+2026       省略号 …
#   U+2010-2015  各种连字符与破折号（含中文句子里的 ——）
# 拉丁字体画这些字符是「按拉丁文排版」的：省略号只占三分之一字宽、左对齐，
# 破折号细而低。中文里它们必须是全角、居中的 —— 混进中文句子一眼就不对。
# 本站在页面里真的会渲染 `…`（"正在打开学习台…"、"AI 正在批改…"）
# 和 `—`（"写下来 —— 一个字写一格"），所以这一块必须让给中文圆体。
#
# 摘掉之后这些字符会按 font-family 顺序继续往下找，落到站酷快乐体 ——
# 它覆盖 `…` `—` `“”`（已用逐字覆盖检测确认）。
# ASCII 的 `-` `'` `"` 在 U+0000-00FF 里，不受影响，英文缩写照旧走本字体。
out = re.sub(r"U\+2000-206F,\s*", "", out)

header = (
    f"/* {name} —— 数字 / 西文专用圆体（自托管，SIL OFL 1.1）。\n"
    "   为什么单独来一份：站酷快乐体的数字是手写涂鸦风的异形（0 是歪椭圆、1 像一撇、\n"
    "   宽度不齐、无 tabular-nums），而站点的数字用量极大。中文仍由站酷快乐体负责。\n"
    "   font-family 逐字符回退：把本字体写在 --font-round 最前面即可，\n"
    "   数字/字母命中这里，汉字没有字形自动落到后面的站酷快乐体。\n"
    "   ⚠️ unicode-range 已从 Google 原版里摘掉 U+2000-206F：那一段含中文要用的\n"
    "   `…` `—` `“”`，交给拉丁字体画会变成英文排版的窄标点（详见脚本内注释）。\n"
    f"   字重区间 {info}（可变字体，用 variable font，一份数据覆盖全档）。\n"
    "   本文件由 scripts/fetch-latin-font.py 生成，不要手改。 */\n\n"
)
with open(CSS_OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(header + out)

print(f"字体共 {total / 1024:.0f} KB -> {OUT_DIR}")
print(f"样式 -> {CSS_OUT}")
