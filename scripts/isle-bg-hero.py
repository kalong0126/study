# -*- coding: utf-8 -*-
"""生成首页 hero 用的海洋背景 assets/isle-bg-hero.jpg。

为什么不能让原图直接铺满 hero：
  原图 isle-bg.jpg 是 2048x576（3.556:1），而 hero 要装两层东西 —— 标题区（约 96px）
  + 六座岛区（约 285px），比例约 2.75:1。直接 cover 到 2.75:1 会把左右各裁掉一大块，
  灯塔、帆船、沙滩全出画。所以在上方补一段同色天空，让图本身变成 hero 的比例，
  铺的时候 cover 零裁切。

原图的太阳为什么抹掉：
  补完天空后太阳（x 275..339）落在标题区正下方，会和标题文字、第一座岛叠在一起。
  抹掉后由 DOM 里的太阳图标承担这个角色（参考图里太阳本来就是界面元素，不是背景的一部分）。

接缝怎么做到看不出来：
  1) 先把原图最上面 BAND 行**渐进横向抹平**（向"该行横向平均值"过渡）——
     天空本来就是横向恒定的，这一步只削掉云的横向起伏，人眼看不出来；
  2) 补的天用第 1 步抹平后的那一行向上延伸，所以底行与下面的像素完全相等，接缝为零。
  不用镜像（会把云和远岛翻上去）、不用拉伸（会把云拉成竖条）。
"""
from PIL import Image, ImageOps

SRC = r"D:\aiprojects\study\web\src\assets\isle-bg.jpg"
DST = r"D:\aiprojects\study\web\src\assets\isle-bg-hero.jpg"

CARD_W = 1048.0   # 宽屏下 hero 卡片的实际宽度（wrap 1080 - padding 32）
CARD_H = 381.0    # 标题区 96 + 岛区 285
BAND = 64         # 顶部抹平行数
FLATTEN = 0.94    # 第 0 行抹平强度
WHITEN = 0.45     # 补天区顶部漂白强度（越大越白）

im = Image.open(SRC).convert("RGB")
W, H = im.size
EXT = round(W / (CARD_W / CARD_H)) - H
print(f"src {W}x{H}  ratio {W / H:.4f}")
print(f"目标卡片 {CARD_W:.0f}x{CARD_H:.0f} -> 新图高 {H + EXT}，向上补 {EXT}px 天空")

# ---------- 1. 抹掉太阳（bbox 275..339 x 21..85）：左右邻列线性插值 ----------
X0, X1, Y1 = 252, 368, 104   # 覆盖范围（含光晕）
XL, XR = 250, 372            # 左右参考列（都在太阳之外）
px = im.load()
patch = Image.new("RGB", (X1 - X0, Y1))
pp = patch.load()
for y in range(Y1):
    l, r = px[XL, y], px[XR, y]
    for x in range(X1 - X0):
        t = x / (X1 - X0 - 1)
        pp[x, y] = (
            int(l[0] + (r[0] - l[0]) * t),
            int(l[1] + (r[1] - l[1]) * t),
            int(l[2] + (r[2] - l[2]) * t),
        )
im.paste(patch, (X0, 0))
print("太阳已抹除")

# ---------- 2. 顶部天空横向抹平（削掉云的起伏，接缝才有干净的一行可接） ----------
band = im.crop((0, 0, W, BAND))
# 缩到 1px 宽再放大回来 = 每行的横向平均值，天空的纵向渐变原样保留
smooth = band.resize((1, BAND), Image.BOX).resize((W, BAND), Image.BICUBIC)
m = ImageOps.invert(Image.linear_gradient("L").resize((W, BAND), Image.BILINEAR))
m = m.point(lambda v: int(v * FLATTEN))       # 顶行抹平 94%，向下线性归零
im.paste(smooth, (0, 0), m)
print("顶部天空已抹平")

# ---------- 3. 向上补天空：底行逐列取抹平后的第 0 行 -> 零接缝；向上略渐白 ----------
base = smooth.crop((0, 0, W, 1)).resize((W, EXT), Image.NEAREST)
white = Image.new("RGB", (W, EXT), (255, 255, 255))
m2 = ImageOps.invert(Image.linear_gradient("L").resize((W, EXT), Image.BILINEAR))
m2 = m2.point(lambda v: int(v * WHITEN))
sky = Image.composite(white, base, m2)
print("天空已补")

# ---------- 4. 拼接输出 ----------
out = Image.new("RGB", (W, H + EXT))
out.paste(sky, (0, 0))
out.paste(im, (0, EXT))
out.save(DST, quality=90, subsampling=0, optimize=True)

ratio = out.size[0] / out.size[1]
card_h = 1048 / ratio
print(f"out {out.size[0]}x{out.size[1]}  ratio {ratio:.4f}")
print(f"  卡片 1048 宽 -> 高 {card_h:.1f}px（目标 {CARD_H}）")
print(f"  海平线（原 y=202）-> 新图 y={202 + EXT}，卡片内 y={(202 + EXT) / (H + EXT) * card_h:.0f}px")
print(f"  标题区 0..{(EXT + 0) / (H + EXT) * card_h:.0f}px 落在补天区的纯净天空里")
print(f"  输出 {DST}")
