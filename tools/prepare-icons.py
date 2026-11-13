"""将生成的 Logo 处理为 Chrome 所需的多尺寸透明 PNG。"""

import argparse
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
image = Image.open(args.source).convert("RGBA")
# 去掉几乎透明的边缘杂点，让小尺寸图标的主体更清楚。
alpha = image.getchannel("A")
mask = alpha.point(lambda value: 255 if value >= 100 else 0)
bounds = mask.getbbox()
if not bounds:
    raise ValueError("Logo 不包含可见图像")
image = image.crop(bounds)
args.destination.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 128, 256):
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    content = image.copy()
    content.thumbnail((round(size * 0.9), round(size * 0.9)), Image.Resampling.LANCZOS)
    icon.alpha_composite(content, ((size - content.width) // 2, (size - content.height) // 2))
    target = args.destination / f"icon-{size}.png"
    if target.exists():
        raise FileExistsError(f"不覆盖已有图标：{target}")
    icon.save(target, optimize=True)
    print(f"已生成：{target}（{size}×{size}）")
