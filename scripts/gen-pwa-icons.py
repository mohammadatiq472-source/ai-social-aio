#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 PWA 图标（可重跑、确定性输出）。

为什么要有这个脚本：`web/public/manifest.webmanifest` 的 icons 曾经是空数组，
装到桌面/主屏是默认图标，iOS 首屏是网页截图。图标是本仓库唯一需要位图的品牌资产，
所以用脚本生成而不是手工拖文件 —— 任何人重跑一遍就能得到同样尺寸/同样观感的图标。

设计约束（对应 AGENTS.md / 架构与约束.md §6）：
  * 底色用品牌蓝 #12b7f5（= token --qq-blue）。图标是位图，不归 verify:tokens 管。
  * 图形：白色对话气泡 + 居中「AI」。为什么是气泡：这个产品就是群聊。
  * apple-touch-icon **不自己画圆角**：iOS 会自己加遮罩，自画圆角会在四角露出底色。
  * maskable 版本把内容缩到中间 80% 安全区（Android 会按圆形/方圆裁切），四周仍是纯底色。

确定性：
  * 全部用 Pillow 的几何绘制 + 4x 超采样 LANCZOS 缩放，不使用随机数/时间戳；
  * 字号由「测量一次再按比例缩放」算出，不做迭代搜索；
  * 同一台机器重跑得到字节一致的 PNG（脚本尾部会打印 sha256 供比对）。

用法：
    python scripts/gen-pwa-icons.py              # 生成到 web/public
    python scripts/gen-pwa-icons.py --outdir tmp # 生成到别处（不会碰真实资源）
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - 环境问题要给清楚的话
    sys.exit("需要 Pillow：python -m pip install Pillow")

# 品牌蓝，等价于 web/src/styles/01-tokens.css 的 --qq-blue
BRAND = (18, 183, 245)
WHITE = (255, 255, 255)
SS = 4  # 超采样倍数：圆角与字形边缘靠它抗锯齿

# 「AI」字形的字体候选：优先本机常见粗体无衬线；都找不到就退回 Pillow 内置字体。
FONT_CANDIDATES = [
    os.environ.get("PWA_ICON_FONT", ""),
    r"C:\Windows\Fonts\segoeuib.ttf",   # Segoe UI Bold
    r"C:\Windows\Fonts\arialbd.ttf",    # Arial Bold
    r"C:\Windows\Fonts\msyhbd.ttc",     # 微软雅黑 Bold
    r"C:\Windows\Fonts\simhei.ttf",     # 黑体
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]

# 目标产物：(相对 web/public 的路径, 像素边长, 内容占画布比例)
#   any       → 0.88：浏览器按原图显示，留一点呼吸感
#   maskable  → 0.80：Android 会裁到中间安全区，超出部分会被切
#   apple     → 0.88：与 any 同构图，iOS 自己加圆角
TARGETS = [
    ("icons/icon-192.png", 192, 0.88),
    ("icons/icon-512.png", 512, 0.88),
    ("icons/icon-maskable-512.png", 512, 0.80),
    ("apple-touch-icon.png", 180, 0.88),
]


def pick_font() -> tuple[ImageFont.FreeTypeFont | ImageFont.ImageFont, str]:
    """返回一个「量宽用的 100px 字体」和它的来源名，方便在日志里确认用的是哪个字体。"""
    for path in FONT_CANDIDATES:
        if path and os.path.exists(path):
            return ImageFont.truetype(path, 100), os.path.basename(path)
    print("警告：没找到候选粗体字体，退回 Pillow 内置字体（字形会偏细）", file=sys.stderr)
    return ImageFont.load_default(size=100), "<pillow-default>"


def fitted_ai_font(font: ImageFont.FreeTypeFont | ImageFont.ImageFont, target_width: float):
    """把「AI」的墨迹宽度缩放到 target_width：量一次 100px 的宽，再按比例定字号。"""
    probe = ImageDraw.Draw(Image.new("RGBA", (10, 10))).textbbox((0, 0), "AI", font=font)
    probe_w = max(1, probe[2] - probe[0])
    size = max(8, int(round(100 * target_width / probe_w)))
    variant = getattr(font, "font_variant", None)
    return variant(size=size) if variant else font


def render(size: int, content_scale: float) -> Image.Image:
    """画一张 size×size 的图标：整块品牌蓝 + 中间白色气泡 + 「AI」。"""
    canvas = size * SS
    content = max(8, int(round(canvas * content_scale)))

    # 内容层（透明底）画在 content×content 上，最后整体贴到纯色底 —— 这样 maskable
    # 的四周是同色底而不是透明，Android 裁切时不会露出「内容被放大」的破绽。
    layer = Image.new("RGBA", (content, content), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    bw = 0.78 * content          # 气泡宽
    bh = 0.60 * content          # 气泡高
    bx = (content - bw) / 2
    by = (content - bh) / 2 - 0.045 * content  # 略微上移，给底部的气泡尾巴留位
    radius = 0.19 * bw

    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=radius, fill=WHITE)

    # 气泡尾巴：贴在左下，尖朝下（对话气泡的识别度就靠这一笔）
    d.polygon(
        [
            (bx + 0.20 * bw, by + bh - 0.02 * bh),
            (bx + 0.36 * bw, by + bh - 0.02 * bh),
            (bx + 0.17 * bw, by + bh + 0.13 * bh),
        ],
        fill=WHITE,
    )

    # 「AI」：先用气泡内宽定字号，再把字形墨迹的包围盒对到气泡中心。
    # 为什么不直接靠 anchor="mm"：它对齐的是排版盒（含「I」的侧边距、ascender/descender），
    # 实测渲染出来整体偏左 1%+，肉眼能看出「AI 没居中」。先把字画到透明层上裁出墨迹，
    # 再按裁出的方框精确居中 —— 换字体也不会偏。
    font, _ = pick_font()
    font = fitted_ai_font(font, target_width=0.58 * bw)
    ink = Image.new("RGBA", (int(bw), int(bh * 1.4)), (0, 0, 0, 0))
    ImageDraw.Draw(ink).text((0, 0), "AI", font=font, fill=BRAND, anchor="lt")
    bounds = ink.getbbox()
    if not bounds:
        raise SystemExit("内部错误：没画出「AI」字形")
    glyph = ink.crop(bounds)
    cx, cy = bx + bw / 2, by + bh / 2
    layer.alpha_composite(
        glyph,
        (int(round(cx - glyph.width / 2)), int(round(cy - glyph.height / 2))),
    )


    base = Image.new("RGB", (canvas, canvas), BRAND)
    offset = (canvas - content) // 2
    base.paste(layer, (offset, offset), layer)
    return base.resize((size, size), Image.LANCZOS)


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 PWA 图标（192/512/maskable/apple-touch）")
    ap.add_argument("--outdir", default=None, help="输出目录（默认 web/public）")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    outdir = args.outdir or os.path.join(root, "web", "public")
    _, font_name = pick_font()
    print(f"字体：{font_name}")

    for rel, size, scale in TARGETS:
        img = render(size, scale)
        if img.size != (size, size):  # 尺寸写错会让 manifest 校验失败，早失败早说
            raise SystemExit(f"内部错误：{rel} 生成成 {img.size}")
        dest = os.path.join(outdir, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        # optimize=True 只影响编码体积、不影响像素；不写入任何时间戳元数据
        img.save(dest, format="PNG", optimize=True)
        with open(dest, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        print(f"{os.path.relpath(dest, root)}  {img.size[0]}x{img.size[1]}  "
              f"{os.path.getsize(dest)} B  sha256={digest[:16]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
