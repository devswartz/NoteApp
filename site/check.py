#!/usr/bin/env python3
"""Checks on the built marketing site (python3 site/check.py site/dist). Standard library only.

Fails on:
- a page without a <title>, a meta description, or exactly one <h1>
- an inline style attribute (the CSP drops them silently)
- an internal link or asset that doesn't resolve to a built file
- an unhashed CSS or JS file under /assets/ (they're cached for a year)
- a sitemap URL that doesn't resolve, or an indexable page missing from the sitemap
"""
import os
import re
import sys

root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "dist")
errors = []

def resolves(path):
    path = path.split("#")[0].split("?")[0]
    if path.startswith("/download/"):
        return True  # served from the host volume, not the build
    if path.endswith("/"):
        return os.path.isfile(os.path.join(root, path.lstrip("/"), "index.html"))
    full = os.path.join(root, path.lstrip("/"))
    return os.path.isfile(full) or os.path.isfile(full + ".html")

pages = {}
for dirpath, _, files in os.walk(root):
    for f in files:
        if f.endswith(".html"):
            rel = os.path.relpath(os.path.join(dirpath, f), root).replace(os.sep, "/")
            with open(os.path.join(dirpath, f), encoding="utf-8") as fh:
                pages[rel] = fh.read()

if not pages:
    sys.exit(f"no pages found in {root}")

indexable = set()
for rel, html in pages.items():
    if "<title>" not in html:
        errors.append(f"{rel}: no <title>")
    if not re.search(r'<meta name="description" content="[^"]+"', html):
        errors.append(f"{rel}: no meta description")
    if len(re.findall(r"<h1[\s>]", html)) != 1:
        errors.append(f"{rel}: needs exactly one <h1>")
    if re.search(r"<[a-zA-Z][^>]*\sstyle=", html):
        errors.append(f"{rel}: inline style attribute (blocked by the CSP)")
    for ref in re.findall(r'(?:href|src)="(/[^"]*)"', html):
        if not resolves(ref):
            errors.append(f"{rel}: broken internal link {ref}")
    if 'name="robots" content="noindex' not in html:
        url = "/" + rel[:-len(".html")]
        url = url[: -len("index")] if url.endswith("/index") or url == "/index" else url
        indexable.add(url or "/")

assets = os.path.join(root, "assets")
for f in os.listdir(assets) if os.path.isdir(assets) else []:
    if f.endswith((".css", ".js")) and not re.match(r"^[\w-]+\.[0-9a-f]{10}\.(css|js)$", f):
        errors.append(f"assets/{f}: CSS/JS under /assets/ must be content-hashed")

sitemap = os.path.join(root, "sitemap.xml")
if os.path.isfile(sitemap):
    with open(sitemap, encoding="utf-8") as fh:
        urls = {re.sub(r"^https://notiveloapp\.com", "", u) or "/" for u in re.findall(r"<loc>([^<]+)</loc>", fh.read())}
    for u in urls:
        if not resolves(u):
            errors.append(f"sitemap.xml: {u} doesn't resolve")
    for u in sorted(indexable - urls):
        errors.append(f"{u}: indexable page missing from sitemap.xml")
else:
    errors.append("no sitemap.xml")

if errors:
    print("\n".join(errors))
    sys.exit(1)
print(f"ok: {len(pages)} pages")
