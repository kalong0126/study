#!/usr/bin/env python3
"""把 AI 出的 2048px 图标大图处理成能进前端的透明底素材。

⚠️ 这批图**不是**透明底：画面上那层方格是「假装透明」的棋盘格，是画出来的像素，
   PNG 的 alpha 通道全 255。直接拿去用，页面上就会出现一块浅灰格子方块。
   所以必须自己抠。

四个动作，缺一个图在页面上就是歪的 / 带脏边：

1. **抠背景**。背景是中性浅灰的棋盘格，还带一圈很淡的投影。
   纯按「颜色像不像背景」抠不行：物体里也有接近白的部分（书页、靶心、金属包边），
   一刀切会把它们一起打穿。
   所以分两步走定「背景候选」，再用**连通域**兜底：
     · 候选 = 离边框平均色 < 34（棋盘格两个灰阶都落在这里）
             或（三通道都 > 150 且 R/G/B 极差 < 20）（中性浅色）
     · 只保留**与画布边框相连**的那块候选当背景。
   物体内部的近白区域虽然颜色也像背景，但它被彩色像素包着、连不到边框，于是被保住。
   顺带把「豆包AI生成」水印也一起带走 —— 它在背景里，属于连到边框的那一块。

2. **按不透明像素裁掉四周留白**（阈值 90，避开羽化边）。
   不裁的话，物体在 256 画布上会显得又小又偏 —— 原图物体只占中间七八成。

3. **补成正方形 + 留 6% 边距**。正方形是为了页面上等值放缩不变形；
   留边距是因为这里对 alpha 做了羽化（见下），贴着边裁会擦掉一圈淡淡的边。

4. **羽化 alpha**（高斯 σ=0.9）。抠出来的边缘本来是硬边，直接缩到 256px 会有锯齿；
   羽化一层等于自带抗锯齿，叠在彩色卡片上边是干净的。

用法：
    python scripts/prepare-icons.py
源图放仓库根目录（已在 .gitignore 里，不进 git），产物写进 web/src/assets/icons/。
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "web" / "src" / "assets" / "icons"

# 源文件名 → 产物文件名。产物名取「它是什么」而不是「从哪来」，
# 页面上引用的是 chest/tree/target/book，以后换素材不用动 .vue。
ICONS = {
    "box.png": "chest.png",
    "tree.png": "tree.png",
    "jianba.png": "target.png",
    "book.png": "book.png",
}

WORK = 512          # 抠图在这一档分辨率上做，再缩到 256，等于自带 2× 超采样
SIZE = 256          # 产物边长
BG_TOL = 40         # 「像背景」的通道差阈值
NEUTRAL_MIN = 96    # 中性浅色判定：三通道最小值下限。
                    # 放到 150 的时候，物体底下那圈投影里偏深的一段会够不着门槛，
                    # 于是被当成物体留下来 —— 宝箱右下角就挂着一块灰印子。
                    # 放到 96 让它接上背景，再靠「连通域」保证不误伤物体内部的浅色部分。
NEUTRAL_RANGE = 24  # 中性浅色判定：三通道极差上限
MARGIN = 0.06       # 补正方形后再留的边距（占边长比例）
FEATHER = 0.9       # alpha 羽化 σ


def background_mask(rgb: np.ndarray) -> np.ndarray:
    """找出「连到画布边框的那块浅色中性区域」。"""
    h, w, _ = rgb.shape
    ring = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bgc = np.median(ring, axis=0)

    dist = np.abs(rgb.astype(np.int16) - bgc).max(axis=2)
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    candidate = (dist < BG_TOL) | ((mn > NEUTRAL_MIN) & ((mx - mn) < NEUTRAL_RANGE))

    # 连通域：只有与边框相连的候选才算背景。物体内部的近白区域连不到边框，被保住。
    labels, _ = ndimage.label(candidate, structure=np.ones((3, 3), dtype=int))
    border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    bg_labels = set(np.unique(border)) - {0}
    return np.isin(labels, list(bg_labels))


def main_island(solid: np.ndarray) -> np.ndarray:
    """只留主体那一块，扔掉零散残渣。

    投影是渐变，最外圈够得上「背景」的门槛、往里一段够不上，于是抠完之后
    物体边上会剩一小撮碎点（宝箱右下角最明显）。这些碎点各自是独立连通域，
    按面积一过滤就干净了：留下最大的那块，以及不小于它 1.5% 的附属块
    （防止把本该保留的小配件一起丢掉 —— 星芒、飘带这类装饰常是独立连通域）。
    """
    labels, n = ndimage.label(solid, structure=np.ones((3, 3), dtype=int))
    if n <= 1:
        return solid
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    floor = sizes.max() * 0.015
    keep = (sizes >= floor).copy()
    keep[0] = False
    return keep[labels]


def key_out(im: Image.Image) -> Image.Image:
    """抠掉背景，返回带羽化 alpha 的 RGBA 图。"""
    small = im.convert("RGB").resize((WORK, WORK), Image.LANCZOS)
    rgb = np.asarray(small)
    solid = main_island(~background_mask(rgb))
    alpha = ndimage.gaussian_filter(solid.astype(np.float64), FEATHER)
    # 羽化会把边缘压到 0.5 附近，重新拉伸回来，边缘才是实心的
    alpha = np.clip((alpha - 0.25) / 0.5, 0.0, 1.0)

    out = np.dstack([rgb, (alpha * 255).round().astype(np.uint8)])
    return Image.fromarray(out, "RGBA")


def solid_bbox(im: Image.Image, thresh: int = 90) -> tuple[int, int, int, int]:
    mask = im.getchannel("A").point(lambda a: 255 if a >= thresh else 0)
    bb = mask.getbbox()
    if bb is None:
        sys.exit("整张图都被当成背景抠没了，调一下 BG_TOL / NEUTRAL_*")
    return bb


def square(im: Image.Image) -> Image.Image:
    """裁到物体外框 → 补成正方形 → 缩到 SIZE。"""
    obj = im.crop(solid_bbox(im))
    ow, oh = obj.size
    side = int(round(max(ow, oh) * (1 + MARGIN * 2)))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(obj, ((side - ow) // 2, (side - oh) // 2))
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    preview = {
        "chest": (255, 0, 255),
        "tree": (0, 0, 0),
        "target": (255, 0, 255),
        "book": (255, 0, 255),
    }
    for src_name, out_name in ICONS.items():
        src = REPO / src_name
        if not src.exists():
            sys.exit(f"找不到源图：{src}")
        raw = Image.open(src).convert("RGB")
        out = square(key_out(raw))
        dst = OUT / out_name
        out.save(dst, "PNG", optimize=True)

        # 抠图对这种「物体里也有近白」的图很容易出错，必须看一眼：
        # 垫在洋红上导出，有洞 / 漏背景会非常刺眼。
        probe = Image.new("RGB", out.size, preview[out_name.split(".")[0]])
        probe.paste(out, (0, 0), out)
        probe.save(OUT / f"_preview-{out_name}", "PNG")

        keep = float((np.asarray(out.getchannel("A")) > 90).mean()) * 100
        print(
            f"{src_name:10s} {raw.size[0]}×{raw.size[1]} → {out_name:10s} "
            f"{out.size[0]}×{out.size[1]}  实心占比 {keep:4.1f}%  {dst.stat().st_size/1024:.0f} KB"
        )


if __name__ == "__main__":
    main()
