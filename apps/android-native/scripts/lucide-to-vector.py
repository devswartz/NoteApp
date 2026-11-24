"""Converts the Lucide SVGs the Android app uses (docs/rewrite/look/icons/) to Android vector drawables.

    python apps/android-native/scripts/lucide-to-vector.py

Writes app/src/main/res/drawable/ic_<name>.xml (24x24 viewport, stroke only, black: tint it in Compose).
The stroke width is in viewport units, so it scales with the icon like the web's (2 -> 1.5 dp at 18 dp).
Variants with another stroke width (the active tab icons 2.3, the FAB plus 2.25, small checks 3) get a
suffix: ic_book_open_s23.xml. Add a name to ICONS to use another icon, then re-run.
"""
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SRC = os.path.join(ROOT, "docs", "rewrite", "look", "icons")
OUT = os.path.join(ROOT, "apps", "android-native", "app", "src", "main", "res", "drawable")

# icon name -> extra stroke widths (as a variant suffix, e.g. 2.3 -> _s23)
ICONS = {
    "menu": [], "bell": [], "search": [2.3], "book-open": [2.3], "list-checks": [2.3], "calendar-days": [2.3],
    "plus": [2.25], "chevron-right": [], "chevron-down": [], "chevron-left": [], "chevron-up": [],
    "lock": [], "ellipsis": [], "clock": [], "book-plus": [], "file-text": [], "file-plus": [],
    "layout-template": [], "folder-plus": [], "upload": [], "panel-left-close": [], "panel-left-open": [],
    "circle-check": [], "check": [3], "x": [], "log-out": [], "user-round": [], "settings": [],
    "letter-b": [], "italic": [], "underline": [], "strikethrough": [], "baseline": [], "highlighter": [], "remove-formatting": [],
    "list": [], "list-ordered": [], "list-indent-decrease": [], "list-indent-increase": [], "table": [], "image-plus": [],
    "paperclip": [], "link-2": [], "file-symlink": [], "minus": [], "paint-bucket": [], "rows-3": [], "printer": [],
    "list-tree": [], "undo-2": [], "redo-2": [], "sun": [], "calendar-range": [], "inbox": [], "layers": [],
    "arrow-up-down": [], "eye": [], "user": [], "tag": [], "users-round": [], "users": [], "flag": [],
    "sliders-horizontal": [], "funnel-x": [], "bookmark": [], "bookmark-plus": [], "list-todo": [],
    "message-square": [], "user-plus": [], "face-slightly-smiling-plus": [], "square-check": [], "list-plus": [],
    "maximize-2": [], "file-x-corner": [], "image": [], "download": [], "trash": [], "repeat": [], "arrow-left": [],
    "type": [], "heading-1": [], "heading-2": [], "heading-3": [], "square-check-big": [], "quote": [], "message-square-quote": [], "code-xml": [], "at-sign": [],
}
# Icons drawn filled as well (the priority flag): ic_<name>_filled.xml
FILLED = ["flag"]

NS = "{http://www.w3.org/2000/svg}"


def num(v, default=0.0):
    return float(v) if v is not None else default


def fmt(v):
    s = ("%.4f" % v).rstrip("0").rstrip(".")
    return s if s else "0"


def circle(cx, cy, rx, ry):
    return (f"M{fmt(cx - rx)},{fmt(cy)}a{fmt(rx)},{fmt(ry)} 0 1,0 {fmt(2 * rx)},0"
            f"a{fmt(rx)},{fmt(ry)} 0 1,0 {fmt(-2 * rx)},0z")


def rect(x, y, w, h, rx, ry):
    rx = min(rx or ry or 0, w / 2)
    ry = min(ry or rx or 0, h / 2)
    if rx == 0 and ry == 0:
        return f"M{fmt(x)},{fmt(y)}h{fmt(w)}v{fmt(h)}h{fmt(-w)}z"
    return (f"M{fmt(x + rx)},{fmt(y)}h{fmt(w - 2 * rx)}a{fmt(rx)},{fmt(ry)} 0 0 1 {fmt(rx)},{fmt(ry)}"
            f"v{fmt(h - 2 * ry)}a{fmt(rx)},{fmt(ry)} 0 0 1 {fmt(-rx)},{fmt(ry)}"
            f"h{fmt(-(w - 2 * rx))}a{fmt(rx)},{fmt(ry)} 0 0 1 {fmt(-rx)},{fmt(-ry)}"
            f"v{fmt(-(h - 2 * ry))}a{fmt(rx)},{fmt(ry)} 0 0 1 {fmt(rx)},{fmt(-ry)}z")


NUM = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")
ARGS = {"m": 2, "l": 2, "h": 1, "v": 1, "c": 6, "s": 4, "q": 4, "t": 2, "a": 7, "z": 0}
SEP = " ,\t\r\n"


def normalize(d):
    """Path data with every command written out and arc flags separated: Android's parser does not read
    glued flags ("a2 2 0 0022 17") or repeated arcs the way SVG does."""
    out = []
    i = 0
    n = len(d)
    while i < n:
        cmd = d[i]
        i += 1
        if cmd in SEP:
            continue
        k = ARGS[cmd.lower()]
        if k == 0:
            out.append(cmd)
            continue
        first = True
        while True:
            vals = []
            for j in range(k):
                while i < n and d[i] in SEP:
                    i += 1
                if cmd.lower() == "a" and j in (3, 4):
                    vals.append(d[i])
                    i += 1
                else:
                    m = NUM.match(d, i)
                    if not m:
                        raise ValueError("bad path data: " + d)
                    vals.append(m.group(0))
                    i = m.end()
            c = cmd if first else {"m": "l", "M": "L"}.get(cmd, cmd)
            out.append(c + " ".join(vals))
            first = False
            while i < n and d[i] in SEP:
                i += 1
            if i >= n or d[i].isalpha():
                break
    return "".join(out)


def paths(svg_file):
    out = []
    for el in ET.parse(svg_file).getroot().iter():
        tag = el.tag.replace(NS, "")
        a = el.attrib
        if tag == "path":
            out.append(normalize(a["d"]))
        elif tag == "circle":
            out.append(circle(num(a.get("cx")), num(a.get("cy")), num(a["r"]), num(a["r"])))
        elif tag == "ellipse":
            out.append(circle(num(a.get("cx")), num(a.get("cy")), num(a["rx"]), num(a["ry"])))
        elif tag == "rect":
            out.append(rect(num(a.get("x")), num(a.get("y")), num(a["width"]), num(a["height"]),
                            num(a.get("rx")), num(a.get("ry"))))
        elif tag == "line":
            out.append(f"M{a['x1']},{a['y1']}L{a['x2']},{a['y2']}")
        elif tag in ("polyline", "polygon"):
            pts = re.split(r"[\s,]+", a["points"].strip())
            pairs = [f"{pts[i]},{pts[i + 1]}" for i in range(0, len(pts), 2)]
            out.append("M" + "L".join(pairs) + ("z" if tag == "polygon" else ""))
    return out


def write(name, width, suffix, fill=False):
    ps = paths(os.path.join(SRC, name + ".svg"))
    lines = ['<?xml version="1.0" encoding="utf-8"?>',
             '<!-- Generated by apps/android-native/scripts/lucide-to-vector.py from docs/rewrite/look/icons/%s.svg (Lucide, ISC). -->' % name,
             '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
             '    android:width="24dp"', '    android:height="24dp"',
             '    android:viewportWidth="24"', '    android:viewportHeight="24">']
    for d in ps:
        lines += ['    <path', f'        android:pathData="{d}"', '        android:fillColor="%s"' % ("#FF000000" if fill else "#00000000"),
                  '        android:strokeColor="#FF000000"', f'        android:strokeWidth="{fmt(width)}"',
                  '        android:strokeLineCap="round"', '        android:strokeLineJoin="round" />']
    lines.append("</vector>")
    fname = "ic_" + name.replace("-", "_") + suffix + ".xml"
    with open(os.path.join(OUT, fname), "w", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    return fname


def main():
    os.makedirs(OUT, exist_ok=True)
    count = 0
    for name, variants in ICONS.items():
        write(name, 2, "")
        count += 1
        for w in variants:
            write(name, w, "_s" + fmt(w).replace(".", ""))
            count += 1
    for name in FILLED:
        write(name, 2, "_filled", fill=True)
        count += 1
    print(f"lucide-to-vector: {count} drawables in {OUT}")


if __name__ == "__main__":
    sys.exit(main())
