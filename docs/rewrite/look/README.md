# Look reference: how to regenerate

Reference screenshots of today's web app (`reference/`), the Lucide icons it uses (`icons/`), and the
scripts that make them. The design spec built from them is `docs/rewrite/LOOK.md`.

| File | What |
|---|---|
| `seed.ts` | Seeds an empty `DATA_DIR`: the normal demo seed (`server/demo.ts`: `demo@example.com`, workspace "Demo Team") plus a notebook "Look reference" (section "Corpus": one page per `tests/corpus/cases` case and a "Sandbox" copy of canvas-boxes to type into; section "Empty section") and an empty workspace "Empty Space". |
| `capture.mjs` | Signs in as the demo user and screenshots every state at three viewports (Playwright Chromium with the iPad / iPhone device descriptors: touch, mobile UA). Writes `reference/<viewport>/<state>.png` and `reference/index.md`. |
| `export-icons.mjs` | Writes `icons/<name>.svg` for every Lucide icon imported in `src/`, from the installed `lucide-react`, plus `icons/index.md` (sizes and files). |

## Steps (Git Bash, from the repo root; Windows paths shown as POSIX)

```sh
D=/path/to/scratch/look-data            # a scratch directory, never real data
rm -rf "$D"
DATA_DIR=$D DEMO_PASSWORD=demo-pass-123 SEED_DEMO=1 node --import tsx docs/rewrite/look/seed.ts

# API on 4417 and the web dev server on 4418 (two terminals, or background them)
DATA_DIR=$D PORT=4417 SEED_DEMO=1 DEMO_PASSWORD=demo-pass-123 SIGNUP_MODE=open npx tsx server/index.ts
API_URL=http://localhost:4417 npx vite --port 4418 --strictPort --host 127.0.0.1

# all viewports (about 6 minutes), or name some: ipad-landscape ipad-portrait iphone
DATA_DIR=$D BASE=http://127.0.0.1:4418 node docs/rewrite/look/capture.mjs

node docs/rewrite/look/export-icons.mjs
```

`npx playwright install chromium` first if Playwright has no browser yet. The seed must run before
the server starts (it writes the SQLite file directly). `capture.mjs` reads page and workspace ids
from `$D/noteapp.db` (read-only). It types into the "Sandbox" page and deletes what it typed, so a
re-run on the same data gives the same pictures, but a fresh seed is the clean way.

## Notes

- Viewports: `ipad-landscape` 1180×820 and `ipad-portrait` 820×1180 at 1x, `iphone` 390×844 at 2x
  (CSS px; the PNGs are viewport × scale). Light theme everywhere; `dark-*` and `hybrid-*` files
  repeat the main screens (Hybrid, dark chrome around a light page, is the web app's default).
- Fonts: the CSS asks for `-apple-system` (SF Pro) first. Captured on Windows, the screenshots show
  the fallback (Segoe UI), so glyph shapes and text widths differ slightly from an iPad running the
  web app. Sizes, weights, line heights, colours and layout are as on Apple devices. Capturing on a
  Mac gives SF Pro.
- Dates in the demo content are relative to the day of capture ("Today", "Edited 3m ago").
