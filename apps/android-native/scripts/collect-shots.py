"""Names the Paparazzi snapshots like docs/rewrite/look/reference/ and writes <out>/<viewport>/<state>.png.

    python3 apps/android-native/scripts/collect-shots.py <paparazzi images dir> <out dir>

Paparazzi writes <package>_<TestClass>_<method>.png (apps/android-native/app/src/test/snapshots/images/); the
three test classes are the three reference viewports and the method name is the state with _ for -.
The `sidebar` reference is the sidebar column only (282 px wide), so the native shot is cropped to it.
"""
import os
import re
import sys

from PIL import Image

VIEWPORTS = {
    "PhoneShots": "iphone",
    "TabletPortraitShots": "ipad-portrait",
    "TabletLandscapeShots": "ipad-landscape",
}
# `sidebar` reference width in CSS px (rail 64 + sidebar 217 + 1) and the viewports' heights in CSS px
# (Paparazzi caps a snapshot at 1000 px high, so crop in proportion).
SIDEBAR_CROP = 282
HEIGHT = {"ipad-portrait": 1180, "ipad-landscape": 820}


def main():
    src, out = sys.argv[1:3]
    count = 0
    for name in sorted(os.listdir(src)):
        m = re.match(r".*_(PhoneShots|TabletPortraitShots|TabletLandscapeShots)_(.+)\.png$", name, re.I)
        if not m:
            continue
        klass = next(k for k in VIEWPORTS if k.lower() == m.group(1).lower())
        viewport = VIEWPORTS[klass]
        state = m.group(2).replace("_", "-").lower()
        img = Image.open(os.path.join(src, name)).convert("RGB")
        if state == "sidebar" and viewport != "iphone":
            img = img.crop((0, 0, round(SIDEBAR_CROP * img.height / HEIGHT[viewport]), img.height))
        dest = os.path.join(out, viewport)
        os.makedirs(dest, exist_ok=True)
        img.save(os.path.join(dest, state + ".png"))
        count += 1
    print(f"collect-shots: {count} shots in {out}")


if __name__ == "__main__":
    main()
