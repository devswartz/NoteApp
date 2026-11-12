"""Flatten the store PNGs to RGB (no alpha, as App Store Connect requires) and check exact sizes.
   python scripts/store-assets/flatten.py
"""
import glob
import os
from PIL import Image

store = os.path.join(os.path.dirname(__file__), '..', '..', 'docs', 'store')
expect = {
    'github-social-preview.png': (1280, 640),
    'og-image.png': (1200, 630),
}
bad = 0
for f in sorted(glob.glob(os.path.join(store, '**', '*.png'), recursive=True)):
    rel = os.path.relpath(f, store).replace('\\', '/')
    want = expect.get(rel) or ((1320, 2868) if rel.startswith('ios-6.9/') else (2064, 2752) if rel.startswith('ipad-13/') else None)
    im = Image.open(f)
    if im.mode != 'RGB':
        im.convert('RGB').save(f, optimize=True)
        im = Image.open(f)
    ok = im.size == want and im.mode == 'RGB'
    bad += not ok
    print(('ok  ' if ok else 'BAD ') + rel, im.size, im.mode)
raise SystemExit(1 if bad else 0)
