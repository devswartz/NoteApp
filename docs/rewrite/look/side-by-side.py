"""Side-by-side pictures of the web app (reference) and the native app, per state.

    python3 docs/rewrite/look/side-by-side.py <reference dir> <native dir> <out dir>

<reference dir> is docs/rewrite/look/reference (viewport folders inside); <native dir> holds the
native screenshots in the same layout (<viewport>/<state>.png, CI's "Look" step writes them).
For each native shot with a reference of the same name, writes <out dir>/<viewport>/<state>.png:
the reference on the left, the native shot on the right, both scaled to the reference's height,
each labelled. Native shots without a reference are copied with a label. Needs Pillow.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

LABEL_H = 44
GAP = 16
BG = (40, 40, 46)
FG = (236, 236, 239)


def font(size):
    for name in ("DejaVuSans.ttf", "Arial.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def labelled(panels, title, out):
    height = max(p.height for _, p in panels)
    width = sum(p.width for _, p in panels) + GAP * (len(panels) + 1)
    canvas = Image.new("RGB", (width, height + LABEL_H + GAP), BG)
    draw = ImageDraw.Draw(canvas)
    f = font(22)
    x = GAP
    for label, p in panels:
        draw.text((x, 10), f"{label}  ·  {title}", fill=FG, font=f)
        canvas.paste(p, (x, LABEL_H))
        x += p.width + GAP
    os.makedirs(os.path.dirname(out), exist_ok=True)
    canvas.save(out, optimize=True)


def main():
    ref_dir, native_dir, out_dir = sys.argv[1:4]
    count = 0
    for viewport in sorted(os.listdir(native_dir)):
        vdir = os.path.join(native_dir, viewport)
        if not os.path.isdir(vdir):
            continue
        for name in sorted(os.listdir(vdir)):
            if not name.endswith(".png"):
                continue
            native = Image.open(os.path.join(vdir, name)).convert("RGB")
            ref_path = os.path.join(ref_dir, viewport, name)
            title = f"{viewport}/{name[:-4]}"
            if os.path.exists(ref_path):
                ref = Image.open(ref_path).convert("RGB")
                scaled = native.resize((round(native.width * ref.height / native.height), ref.height), Image.LANCZOS)
                labelled([("web (reference)", ref), ("native", scaled)], title, os.path.join(out_dir, viewport, name))
            else:
                labelled([("native (no reference)", native)], title, os.path.join(out_dir, viewport, name))
            count += 1
    print(f"side-by-side: {count} pictures in {out_dir}")


if __name__ == "__main__":
    main()
