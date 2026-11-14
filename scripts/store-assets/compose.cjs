// Composites the store graphics from the captured screenshots (see capture.cjs):
// GitHub social preview, link-preview image, and the App Store screenshots.
//   node scripts/store-assets/compose.cjs        (everything)
//   node scripts/store-assets/compose.cjs mac    (only docs/store/mac, from the mac-* raw shots)
// Then flatten.py removes the alpha channel and checks the exact sizes.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const RAW = process.env.RAW_DIR || path.join(__dirname, '.store-raw');
const STORE = path.join(ROOT, 'docs', 'store');
const SCREENS = path.join(ROOT, 'docs', 'screens');
const url = (p) => 'file:///' + p.replace(/\\/g, '/');

const FONT = "'Segoe UI Variable Display','Segoe UI','Helvetica Neue',Arial,sans-serif";

/** A device-like frame: dark bezel with rounded corners around the screenshot. */
const frame = (src, w, radius, bezel, extra = '', crop = 0) => `
  <div style="position:absolute;${extra};width:${w}px;padding:${bezel}px;box-sizing:content-box;background:#14141a;border-radius:${radius + bezel}px;
    box-shadow:0 30px 80px rgba(49,46,129,.28),0 0 0 3px #2b2b36 inset">
    <div style="${crop ? `height:${crop}px;` : ''}overflow:hidden;border-radius:${radius}px">
      <img src="${url(src)}" style="display:block;width:${w}px">
    </div>
  </div>`;

/** "Start from a template": the picker on top, the filled-in meeting notes below. */
const templateSlide = (raw, [W, picker, result]) =>
  frame(raw('template-picker'), W.w, W.r, W.b, `left:${(W.W - W.w - 2 * W.b) / 2}px;top:${W.top}px`, picker) +
  frame(raw('page-kickoff'), W.w, W.r, W.b, `left:${(W.W - W.w - 2 * W.b) / 2}px;top:${W.top + picker + 2 * W.b + W.gap}px`, result);

const page = (w, h, body) => `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;position:relative;font-family:${FONT}">${body}</body></html>`;

const SOFT_BG = 'linear-gradient(160deg,#eef0ff 0%,#f6f0ff 55%,#ffeef6 100%)';
const caption = (text, size, top, pad) =>
  `<div style="position:absolute;left:${pad}px;right:${pad}px;top:${top}px;text-align:center;font-size:${size}px;line-height:1.1;font-weight:800;letter-spacing:-0.02em;color:#1e1b4b">${text}</div>`;

const SLIDES = [
  ['01-write-anywhere', 'Write anywhere<br>on the page', 'page-kickoff'],
  ['02-tasks-in-notes', 'Tasks that live<br>in your notes', 'tasks-upcoming'],
  ['03-share-a-page', 'Share a page<br>with anyone', 'share'],
  ['04-start-from-template', 'Start from<br>a template', 'template-picker'],
  ['05-light-dark-hybrid', 'Your way: Light,<br>Dark or Hybrid', null],
];

function phoneSlide(d, [, text, shot]) {
  const W = 1320, H = 2868;
  const raw = (n) => path.join(RAW, `iphone-${n}.png`);
  let body = caption(text, 128, 150, 60);
  if (shot === 'template-picker') {
    body += templateSlide(raw, [{ W, w: 860, r: 70, b: 18, top: 520, gap: 50 }, 900, 1100]);
  } else if (shot) {
    body += frame(raw(shot), 1000, 80, 22, 'left:138px;top:540px');
  } else {
    body += frame(raw('page-hybrid'), 700, 62, 16, 'left:-40px;top:1000px');
    body += frame(raw('page-dark'), 700, 62, 16, 'left:660px;top:1000px');
    body += frame(raw('page-brief'), 800, 70, 18, 'left:250px;top:620px');
  }
  return [W, H, page(W, H, `<div style="position:absolute;inset:0;background:${SOFT_BG}"></div>${body}`)];
}

function padSlide(d, [, text, shot]) {
  const W = 2064, H = 2752;
  const raw = (n) => path.join(RAW, `ipad-${n}.png`);
  let body = caption(text, 150, 130, 80);
  if (shot === 'template-picker') {
    body += templateSlide(raw, [{ W, w: 1500, r: 40, b: 24, top: 520, gap: 56 }, 760, 1200]);
  } else if (shot) {
    body += frame(raw(shot), 1500, 40, 24, 'left:252px;top:520px');
  } else {
    body += frame(raw('page-hybrid'), 1000, 34, 18, 'left:30px;top:1280px');
    body += frame(raw('page-dark'), 1000, 34, 18, 'left:1000px;top:1280px');
    body += frame(raw('page-brief'), 1200, 40, 20, 'left:432px;top:640px');
  }
  return [W, H, page(W, H, `<div style="position:absolute;inset:0;background:${SOFT_BG}"></div>${body}`)];
}

/**
 * A macOS-style window: rounded corners, a title bar with the three traffic-light dots and a
 * centred title, hairline border and a soft shadow. `crop` cuts the screenshot to that height.
 */
const macWindow = (src, w, extra = '', { dark = false, crop = 0 } = {}) => {
  const bar = Math.round(w * 0.026), dot = Math.round(bar * 0.42), r = Math.round(w * 0.0075);
  return `
  <div style="position:absolute;${extra};width:${w}px;border-radius:${r}px;overflow:hidden;
    background:${dark ? '#1f1f24' : '#fff'};border:1px solid ${dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.14)'};
    box-shadow:0 ${r * 3}px ${r * 9}px rgba(49,46,129,.28),0 ${r}px ${r * 2}px rgba(0,0,0,.08)">
    <div style="position:relative;height:${bar}px;background:${dark ? '#2a2a30' : '#ececef'};border-bottom:1px solid ${dark ? '#000' : '#d6d6da'};
      display:flex;align-items:center;gap:${Math.round(dot * 0.7)}px;padding-left:${Math.round(dot * 1.1)}px">
      ${['#ff5f57', '#febc2e', '#28c840'].map((c) => `<span style="width:${dot}px;height:${dot}px;border-radius:50%;background:${c};box-shadow:0 0 0 1px rgba(0,0,0,.12) inset"></span>`).join('')}
      <span style="position:absolute;left:0;right:0;text-align:center;font-size:${Math.round(bar * 0.4)}px;font-weight:600;color:${dark ? '#c9c9d1' : '#4b4b55'}">Notivelo</span>
    </div>
    <div style="${crop ? `height:${crop}px;` : ''}overflow:hidden">
      <img src="${url(src)}" style="display:block;width:${w}px">
    </div>
  </div>`;
};

/** Mac App Store, 2880x1800: one-line caption over a macOS window (raw shots are 2880x1800). */
function macSlide(d, [, text, shot]) {
  const W = 2880, H = 1800;
  const raw = (n) => path.join(RAW, `mac-${n}.png`);
  let body = caption(text.replace('<br>', ' '), 132, 96, 80);
  if (shot === 'template-picker') {
    // The picker cropped to its top part, behind; the filled-in meeting notes in front, lower right.
    body += macWindow(raw('template-picker'), 1600, 'left:90px;top:330px', { crop: 620 });
    body += macWindow(raw('page-kickoff'), 1600, 'left:1190px;top:690px');
  } else if (shot) {
    body += macWindow(raw(shot), 2200, 'left:340px;top:300px');
  } else {
    body += macWindow(raw('page-hybrid'), 1500, 'left:70px;top:700px', { dark: true });
    body += macWindow(raw('page-dark'), 1500, 'left:1310px;top:700px', { dark: true });
    body += macWindow(raw('page-brief'), 1860, 'left:510px;top:330px');
  }
  return [W, H, page(W, H, `<div style="position:absolute;inset:0;background:${SOFT_BG}"></div>${body}`)];
}

function social(W, H) {
  const k = W / 1280;
  const s = (n) => Math.round(n * k);
  const shot = path.join(SCREENS, 'readme-light.png');
  const body = `
    <div style="position:absolute;inset:0;background:linear-gradient(135deg,#4338ca 0%,#6d28d9 60%,#a21caf 100%)"></div>
    <div style="position:absolute;left:${s(70)}px;top:${s(110)}px;width:${s(520)}px;color:#fff">
      <div style="display:flex;align-items:center;gap:${s(18)}px">
        <img src="${url(path.join(ROOT, 'public', 'icon.svg'))}" style="width:${s(84)}px;height:${s(84)}px;border-radius:${s(20)}px">
        <div style="font-size:${s(84)}px;font-weight:800;letter-spacing:-0.03em">Notivelo</div>
      </div>
      <div style="margin-top:${s(36)}px;font-size:${s(48)}px;line-height:1.15;font-weight:600">Notes and tasks, beautifully together</div>
      <div style="margin-top:${s(30)}px;font-size:${s(26)}px;opacity:.85">Web · Windows · Mac · iPhone · Android</div>
    </div>
    <div style="position:absolute;left:${s(640)}px;top:${s(90)}px;width:${s(1000)}px;border-radius:${s(22)}px;overflow:hidden;box-shadow:0 ${s(24)}px ${s(70)}px rgba(0,0,0,.4);border:${s(3)}px solid rgba(255,255,255,.25)">
      <img src="${url(shot)}" style="display:block;width:${s(1000)}px">
    </div>`;
  return [W, H, page(W, H, body)];
}

(async () => {
  // node compose.cjs mac → only the Mac App Store slides (needs only the mac-* raw shots).
  const only = process.argv[2];
  for (const d of ['ios-6.9', 'ipad-13', 'mac']) fs.mkdirSync(path.join(STORE, d), { recursive: true });
  const jobs = [];
  if (only !== 'mac') {
    jobs.push([path.join(STORE, 'github-social-preview.png'), ...social(1280, 640)]);
    jobs.push([path.join(STORE, 'og-image.png'), ...social(1200, 630)]);
  }
  for (const s of SLIDES) {
    if (only !== 'mac') {
      jobs.push([path.join(STORE, 'ios-6.9', s[0] + '.png'), ...phoneSlide('iphone', s)]);
      jobs.push([path.join(STORE, 'ipad-13', s[0] + '.png'), ...padSlide('ipad', s)]);
    }
    jobs.push([path.join(STORE, 'mac', s[0] + '.png'), ...macSlide('mac', s)]);
  }
  const b = await chromium.launch();
  for (const [out, W, H, html] of jobs) {
    const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const hp = path.join(RAW, '_c.html');
    fs.writeFileSync(hp, html);
    await p.goto(url(hp));
    await p.waitForLoadState('networkidle');
    await p.waitForTimeout(300);
    await p.screenshot({ path: out, omitBackground: false });
    await p.close();
  }
  fs.unlinkSync(path.join(RAW, '_c.html'));
  await b.close();
})();
