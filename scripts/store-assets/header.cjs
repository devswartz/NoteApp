// App Store Connect "Header" artwork (and the Search Results variant), any size:
//   node scripts/store-assets/header.cjs 5244 2950 docs/store/header/header-5244x2950.png
//   node scripts/store-assets/header.cjs <width> <height> <out.png>
// Uses existing captures in docs/screens. Layout is designed on a 3840x1646 canvas and
// scaled to fit. Everything essential sits in the centre ~35% of the width (iPhone crops the header
// to a narrow centre slice) and inside a 10% safe area; only decorative devices go toward the edges.
// Run scripts/store-assets/flatten.py afterwards to guarantee RGB with no alpha.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const [W, H, out] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
if (!W || !H || !out) { console.error('usage: header.cjs <width> <height> <out.png>'); process.exit(1); }
const ROOT = path.join(__dirname, '..', '..');
const url = (p) => 'file:///' + p.replace(/\\/g, '/');
const desk = url(path.join(ROOT, 'docs', 'screens', 'readme-light.png'));
const phone = url(path.join(ROOT, 'docs', 'screens', 'readme-mobile-tasks.png'));
const deskL = url(path.join(ROOT, 'docs', 'screens', 'readme-tasks.png'));
const deskR = url(path.join(ROOT, 'docs', 'screens', 'readme-calendar.png'));
const icon = url(path.join(ROOT, 'public', 'icon.svg'));
const FONT = "'Segoe UI Variable Display','Segoe UI','Helvetica Neue',Arial,sans-serif";

// Wide headers (about 2.3:1 and 16:9) use the full layout; squarer sizes (the 3:2 Search Results
// slot, 3840x2560 and 1920x1280) use a bolder layout with bigger type for small display.
const search = W / H < 1.6 ? true : false;
const VW = 3840, VH = search ? 2560 : 1646;
const s = Math.min(W / VW, H / VH);
const ox = (W - VW * s) / 2, oy = (H - VH * s) / 2;
const bezel = (w, r, b) => `width:${w}px;padding:${b}px;box-sizing:content-box;background:#14141a;border-radius:${r + b}px;box-shadow:0 60px 140px rgba(49,46,129,.30),0 0 0 4px #2b2b36 inset`;

const html = `<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;position:relative;font-family:${FONT};
background:linear-gradient(120deg,#e4e8ff 0%,#f1eaff 50%,#ffe6f2 100%)">
<div style="position:absolute;left:${W * .62}px;top:${-H * .25}px;width:${H * 1.1}px;height:${H * 1.1}px;border-radius:50%;background:radial-gradient(circle,rgba(109,40,217,.22),transparent 65%)"></div>
<div style="position:absolute;left:${-W * .08}px;top:${H * .45}px;width:${H * 1.1}px;height:${H * 1.1}px;border-radius:50%;background:radial-gradient(circle,rgba(67,56,202,.18),transparent 65%)"></div>
<div style="position:absolute;left:${ox}px;top:${oy}px;width:${VW}px;height:${VH}px;transform:scale(${s});transform-origin:0 0">
  ${search ? `
  <div style="position:absolute;left:0;width:${VW}px;top:290px;text-align:center;color:#1e1b4b">
    <img src="${icon}" style="width:210px;height:210px;border-radius:50px;box-shadow:0 30px 70px rgba(67,56,202,.35)">
    <div style="margin-top:50px;font-size:300px;font-weight:800;letter-spacing:-0.035em;line-height:1">Notivelo</div>
    <div style="margin-top:50px;font-size:140px;line-height:1.12;font-weight:600;letter-spacing:-0.02em;color:#4338ca">Notes and tasks,<br>beautifully together</div>
  </div>
  <div style="position:absolute;left:${(VW - 440 - 28) / 2}px;top:1330px;${bezel(440, 56, 14)}">
    <div style="overflow:hidden;border-radius:56px"><img src="${phone}" style="display:block;width:440px"></div>
  </div>` : `
  <div style="position:absolute;left:0;width:${VW}px;top:170px;text-align:center;color:#1e1b4b">
    <div style="display:inline-flex;align-items:center;gap:44px">
      <img src="${icon}" style="width:170px;height:170px;border-radius:40px;box-shadow:0 24px 60px rgba(67,56,202,.35)">
      <div style="font-size:230px;font-weight:800;letter-spacing:-0.035em;line-height:1">Notivelo</div>
    </div>
    <div style="margin-top:50px;font-size:124px;line-height:1.12;font-weight:600;letter-spacing:-0.02em;color:#4338ca">Notes and tasks,<br>beautifully together</div>
  </div>
  <!-- decorative, toward the edges only (iPhone crops the header to the centre) -->
  <div style="position:absolute;left:150px;top:830px;${bezel(900, 18, 12)};opacity:.55"><div style="overflow:hidden;border-radius:18px"><img src="${deskL}" style="display:block;width:900px"></div></div>
  <div style="position:absolute;left:2790px;top:830px;${bezel(900, 18, 12)};opacity:.55"><div style="overflow:hidden;border-radius:18px"><img src="${deskR}" style="display:block;width:900px"></div></div>
  <div style="position:absolute;left:${(VW - 1020 - 36) / 2}px;top:790px;${bezel(1020, 18, 18)}">
    <div style="overflow:hidden;border-radius:18px"><img src="${desk}" style="display:block;width:1020px"></div>
  </div>
  <div style="position:absolute;left:2190px;top:880px;${bezel(250, 34, 10)}">
    <div style="overflow:hidden;border-radius:34px"><img src="${phone}" style="display:block;width:250px"></div>
  </div>`}
</div></body></html>`;

(async () => {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const hp = path.join(__dirname, '_header.html');
  fs.writeFileSync(hp, html);
  await p.goto(url(hp));
  await p.waitForLoadState('networkidle');
  await p.waitForTimeout(300);
  await p.screenshot({ path: out, omitBackground: false });
  await b.close();
  fs.unlinkSync(hp);
})();
