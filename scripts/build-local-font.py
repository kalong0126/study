# -*- coding: utf-8 -*-
"""
把一份**本地**字体文件（.ttf / .otf）切成 unicode-range 分片 + 生成 @font-face CSS。
用来做「全站统一圆体」这类需求：字库大（方正粗圆简体 2.85MB / 8106 字形），
整包丢给浏览器太重，切片后浏览器只下载页面真正命中的那几片。

用法（默认参数就是本项目当前这一版）：
    python scripts/build-local-font.py
    python scripts/build-local-font.py --src D:/xxx/别的字体.ttf --slug other --family "别的字体"

产出：
    web/public/fonts/<slug>/<slug>.<hash>.<i>.woff2
    web/src/styles/font-<slug>.css

⚠️ 两个已经踩过的坑，改脚本时别踩回去：
  1. @font-face 的 font-weight 只能写真值（本字体只有一个字重 → 400）。
     写成 `100 900` 区间，浏览器会认为字体自带全字重 → **停止合成加粗** →
     全站 400/700/900 渲染成一个粗细，标题层级全部消失。
  2. 文件名里带源文件哈希：字体在 public/ 下是稳定 URL，SW 对 /fonts/ 走 cache-first，
     同名换内容会一直吃旧缓存。哈希变了名字就变，天然失效。

依赖（隔离 venv，别装到系统 python）：
    C:/Users/kalon/.workbuddy/binaries/python/envs/default/Scripts/python.exe -m pip install fonttools brotli
"""
import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from fontTools.ttLib import TTFont

REPO = Path(__file__).resolve().parent.parent
DEF_SRC = REPO / "方正粗圆简体.ttf"


def fmt_ranges(codepoints):
    """[0x4e00,0x4e01,0x4e03] -> 'U+4e00-4e01, U+4e03'"""
    out, start, prev = [], None, None
    for cp in sorted(codepoints):
        if start is None:
            start = prev = cp
        elif cp == prev + 1:
            prev = cp
        else:
            out.append((start, prev))
            start = prev = cp
    if start is not None:
        out.append((start, prev))
    return ", ".join(f"U+{a:04x}" if a == b else f"U+{a:04x}-{b:04x}" for a, b in out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(DEF_SRC), help="本地字体文件（.ttf/.otf）")
    ap.add_argument("--slug", default="fzcuyuan", help="产出目录与 CSS 文件名后缀")
    ap.add_argument("--family", default="方正粗圆简体", help="@font-face 的 family 名")
    ap.add_argument("--local-names", default="方正粗圆简体,FZCuYuan-M03S,FZY4JW--GB1-0",
                    help="src 里的 local() 兜底名，逗号分隔；本机装了就不下载")
    ap.add_argument("--slices", type=int, default=180, help="切成多少片（片越小、单页下载越少，但总数变大）")
    ap.add_argument("--weight", default="400", help="@font-face font-weight，**必须写真值**")
    ap.add_argument("--tabular-digits", default="1",
                    help="把 0-9 的步进宽度统一成最宽那个（1 默认是正题，不改的话计时器跳秒会左右抖）")
    args = ap.parse_args()

    src = Path(args.src)
    if not src.exists():
        sys.exit(f"找不到字体文件：{src}")

    out_dir = REPO / "web" / "public" / "fonts" / args.slug
    css_path = REPO / "web" / "src" / "styles" / f"font-{args.slug}.css"

    font = TTFont(src, lazy=True)
    cps = sorted(font.getBestCmap().keys())
    total = len(cps)
    print(f"源文件：{src.name}  ({src.stat().st_size/1024/1024:.2f} MB)")
    print(f"字形：{font['maxp'].numGlyphs}  可映射码位：{total}  码位范围：U+{cps[0]:04x}-U+{cps[-1]:04x}")

    # ── 数字等宽化 ──────────────────────────────────────────────────────────
    # 中文粗圆体的西文数字是**比例宽度**：方正粗圆简体里 0/2-6/8/9 = 146/256em，
    # 7 = 137，1 只有 94（大约只有别的数字的 2/3）。它又没有 tnum 特性
    # （GSUB 里只有 vert），所以 CSS 的 `font-variant-numeric: tabular-nums`
    # 在这份字体上是**空转**的 —— 计时器每跳一秒、分数每加一分，宽度都会变，
    # 后面的字符跟着左右抖一下。
    # 修法：把 0-9 的步进宽度统一成其中最宽的那个（只改间距，不动任何字形轮廓）。
    # ⚠️ 这属于**二次加工**。个人自用没问题，一旦要商用必须换成可商用的字库。
    work_src = src
    if args.tabular_digits not in ("0", "false", "no"):
        f2 = TTFont(src)
        cm2, hm2 = f2.getBestCmap(), f2["hmtx"]
        dg = [c for c in range(0x30, 0x3A) if c in cm2]
        widths = {hm2[cm2[c]][0] for c in dg}
        if len(widths) > 1:
            target = max(widths)
            for c in dg:
                gn = cm2[c]
                hm2[gn] = (target, hm2[gn][1])
            work_src = src.with_name(f"_{src.stem}.tabular.ttf")
            f2.save(work_src)
            print(f"数字等宽化：0-9 步进 {sorted(widths)} → 全部 {target}（仅改间距，字形不动）")
        else:
            print("数字本来就是等宽的，跳过等宽化")
        f2.close()

    digest = hashlib.sha256(work_src.read_bytes()).hexdigest()[:8]

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    n = max(1, min(args.slices, total))
    size = (total + n - 1) // n
    chunks = [cps[i * size:(i + 1) * size] for i in range(n)]
    chunks = [c for c in chunks if c]

    venv_py = Path(r"C:/Users/kalon/.workbuddy/binaries/python/envs/default/Scripts/python.exe")
    py = sys.executable if not venv_py.exists() else str(venv_py)

    heads = []
    total_bytes = 0
    for idx, chunk in enumerate(chunks):
        woff2 = out_dir / f"{args.slug}.{digest}.{idx}.woff2"
        unicodes = ",".join(f"{cp:04x}" for cp in chunk)
        # GSUB 里只有 vert（竖排），vhea/vmtx 是竖排用的度量 —— 网页横排一律用不到，
        # 每片都白带一份，直接丢掉。注意别丢 cmap/glyf/hmtx/head/hhea/maxp。
        cmd = [
            py, "-m", "fontTools.subset", str(work_src),
            f"--unicodes={unicodes}",
            "--flavor=woff2",
            "--no-hinting",
            "--drop-tables+=DSIG,GSUB,vhea,vmtx",
            f"--output-file={woff2}",
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0 or not woff2.exists():
            sys.exit(f"切片 {idx} 失败：\n{r.stderr[-2000:]}")
        total_bytes += woff2.stat().st_size
        heads.append((woff2.name, fmt_ranges(chunk)))

    locals_src = ", ".join(f'local("{x.strip()}")' for x in args.local_names.split(",") if x.strip())
    lines = [
        f"/* {args.family} —— 本地字体自托管切片（不连任何 CDN）。",
        f"   源文件：{src.name}（个人自用，非商用授权，别跟着仓库外发出去）。",
        "   切片 + unicode-range：浏览器只下载页面真正命中的那几片，首页几十个字通常只命中几片。",
        f"   font-weight 保持真实值 {args.weight}：更粗的字重交给浏览器合成，这样才有粗细层次。",
        "   ⚠️ 千万别改成 `100 900` 之类的区间 —— 那会让全站字重渲染成一个粗细。",
        "   本文件由 scripts/build-local-font.py 生成，不要手改；换字体改脚本再跑一次。 */",
        "",
    ]
    for fname, rng in heads:
        lines += [
            "@font-face {",
            f"  font-family: '{args.family}';",
            "  font-style: normal;",
            f"  font-weight: {args.weight};",
            "  font-display: swap;",
            f"  src: {locals_src},",
            f"       url(/fonts/{args.slug}/{fname}) format('woff2');",
            f"  unicode-range: {rng};",
            "}",
        ]
    css_path.parent.mkdir(parents=True, exist_ok=True)
    css_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    if work_src != src and work_src.exists():
        work_src.unlink()

    print(f"切片：{len(chunks)} 片，共 {total_bytes/1024:.0f} KB（源 TTF {src.stat().st_size/1024/1024:.2f} MB）")
    print(f"产出：{out_dir.relative_to(REPO)}")
    print(f"CSS  ：{css_path.relative_to(REPO)}")
    print("下一步：把 font-family 接到 --font-round 最前面，并删掉旧字体的 CSS 与 woff2。")


if __name__ == "__main__":
    main()
