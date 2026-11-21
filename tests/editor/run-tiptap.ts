// Runs the editor suite (tests/editor/scenarios/*.json) against today's TipTap editor, headless in
// Chromium: builds ./harness with Vite, serves it, and plays each scenario's steps as real key
// presses, typing, pastes and commands. See tests/editor/README.md.
//
//   node --import tsx tests/editor/run-tiptap.ts [filter] [--print] [--headed]
//
// filter: only scenarios whose "file/name" contains it. --print: show the actual state of every
// scenario run (for writing expectations).
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, type Page } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const print = args.includes('--print');
const headed = args.includes('--headed');
const filter = args.find((a) => !a.startsWith('--')) ?? '';

type Tasks = Record<string, { title?: string; status?: 'open' | 'done' }>;
type Step =
  | { type: string }
  | { key: string; times?: number }
  | { command: string; args?: Record<string, unknown> }
  | { paste: Record<string, string> }
  | { copy: { html?: string; text?: string }; cut?: boolean }
  | { wait: number }
  | { expect: Expect };
interface Expect {
  doc?: string;
  tasks?: Tasks;
  /** Where the keyboard focus is: "editor", or "title:<task>" for a task line's title. */
  focus?: string;
}
interface Scenario {
  name: string;
  doc: string;
  tasks?: Tasks;
  steps: Step[];
  expect: Expect;
  /** Not run against an engine, with the reason: { "tiptap": "…", "rust": "…" }. */
  skip?: Record<string, string>;
}

/** The suite's commands, as TipTap commands. Each returns [name, args]. */
const COMMANDS: Record<string, (a: Record<string, unknown>) => [string, unknown[]]> = {
  toggleMark: (a) => [`toggle${cap(String(a.mark))}`, []],
  setLink: (a) => ['setLink', [{ href: a.href }]],
  unsetLink: () => ['unsetLink', []],
  setColor: (a) => ['setColor', [a.color]],
  setHighlight: (a) => ['setHighlight', [{ color: a.color }]],
  setParagraph: () => ['setParagraph', []],
  setHeading: (a) => ['setHeading', [{ level: a.level }]],
  toggleHeading: (a) => ['toggleHeading', [{ level: a.level }]],
  toggleBulletList: () => ['toggleBulletList', []],
  toggleOrderedList: () => ['toggleOrderedList', []],
  toggleChecklist: () => ['toggleTaskList', []],
  toggleQuote: () => ['toggleBlockquote', []],
  toggleCodeBlock: () => ['toggleCodeBlock', []],
  insertTable: (a) => ['insertTable', [{ rows: a.rows ?? 3, cols: a.cols ?? 3, withHeaderRow: a.header ?? true }]],
  addRowAfter: () => ['addRowAfter', []],
  addColumnAfter: () => ['addColumnAfter', []],
  deleteRow: () => ['deleteRow', []],
  deleteColumn: () => ['deleteColumn', []],
  deleteTable: () => ['deleteTable', []],
  insertTask: (a) => ['insertTask', a.title === undefined ? [] : [a.title]],
  convertToTask: () => ['convertToTask', []],
  insertPageLink: (a) => ['insertContent', [{ type: 'pageLink', attrs: a }]],
  insertMention: (a) => ['insertContent', [{ type: 'mention', attrs: a }]],
  selectAll: () => ['selectAll', []],
  undo: () => ['undo', []],
  redo: () => ['redo', []],
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const pwKey = (k: string) => k.replace(/\bMod\b/g, 'ControlOrMeta');

function loadScenarios(): { file: string; s: Scenario }[] {
  const dir = join(here, 'scenarios');
  const out: { file: string; s: Scenario }[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { scenarios: Scenario[] };
    for (const s of data.scenarios) out.push({ file: f.replace(/\.json$/, ''), s });
  }
  return out;
}

async function buildHarness(): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'nv-editor-harness-'));
  await build({
    root: join(here, 'harness'),
    configFile: false,
    logLevel: 'warn',
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify('editor-suite') },
    build: { outDir, emptyOutDir: true, sourcemap: false, minify: false, chunkSizeWarningLimit: 100000 },
  });
  return outDir;
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function serve(dir: string): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      const file = join(dir, path === '/' ? 'index.html' : path);
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const a = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${a.port}/`, close: () => server.close() });
  }));
}

/** A tiny fake of the server's task API, so task create / update / delete succeed as they would. */
async function stubApi(page: Page) {
  const tasks = new Map<string, Record<string, unknown>>();
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    let body: Record<string, unknown> = {};
    try {
      body = (req.postDataJSON() as Record<string, unknown>) ?? {};
    } catch {
      /* not JSON */
    }
    const id = /\/tasks\/([^/?]+)/.exec(req.url())?.[1];
    let out: unknown = req.method() === 'GET' ? [] : {};
    if (req.method() === 'POST' && /\/tasks$/.test(new URL(req.url()).pathname)) {
      const now = new Date().toISOString();
      const t = { workspaceId: 'w1', description: '', status: 'open', priority: 4, dueDate: null, dueTime: null, recurrence: null, reminderAt: null, assigneeId: null, createdBy: 'u1', pageId: null, parentId: null, teamId: null, tagIds: [], position: 1, completedAt: null, createdAt: now, updatedAt: now, ...body };
      tasks.set(String(t.id), t);
      out = t;
    } else if (req.method() === 'PATCH' && id) {
      const t = { ...(tasks.get(id) ?? { id }), ...body };
      tasks.set(id, t);
      out = t;
    } else if (req.method() === 'DELETE' && id) tasks.delete(id);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  await page.route(/\/(ws|collab|events)/, (r) => r.abort());
}

type State = { doc: string; tasks: Tasks; focus: string };

async function check(page: Page, exp: Expect, label: string): Promise<string[]> {
  const st = (await page.evaluate(() => (window as any).nv.state())) as State;
  const fails: string[] = [];
  if (exp.doc !== undefined) {
    const want = (await page.evaluate((d) => (window as any).nv.canonical(d), exp.doc)) as string;
    if (want !== st.doc) fails.push(`${label} doc\n    want: ${want.replace(/\n/g, '\n          ')}\n    got:  ${st.doc.replace(/\n/g, '\n          ')}`);
  }
  if (exp.tasks !== undefined) {
    const got = Object.fromEntries(Object.entries(st.tasks).map(([k, v]) => [k, { title: v.title, status: v.status }]));
    const want = Object.fromEntries(Object.entries(exp.tasks).map(([k, v]) => [k, { title: v.title ?? '', status: v.status ?? 'open' }]));
    if (!isDeepStrictEqual(got, want)) fails.push(`${label} tasks\n    want: ${JSON.stringify(want)}\n    got:  ${JSON.stringify(got)}`);
  }
  if (exp.focus !== undefined && exp.focus !== st.focus) fails.push(`${label} focus: want ${exp.focus}, got ${st.focus}`);
  return fails;
}

async function run(page: Page, s: Scenario): Promise<string[]> {
  await page.evaluate(({ doc, tasks }) => (window as any).nv.load(doc, tasks), { doc: s.doc, tasks: s.tasks ?? {} });
  const fails: string[] = [];
  let n = 0;
  for (const step of s.steps) {
    n++;
    if ('type' in step) await page.keyboard.type(step.type);
    else if ('key' in step) for (let i = 0; i < (step.times ?? 1); i++) await page.keyboard.press(pwKey(step.key));
    else if ('command' in step) {
      const map = COMMANDS[step.command];
      if (!map) throw new Error(`unknown command ${step.command}`);
      const [name, a] = map(step.args ?? {});
      await page.evaluate(({ name, a }) => (window as any).nv.command(name, a), { name, a });
    } else if ('paste' in step) await page.evaluate((d) => (window as any).nv.paste(d), step.paste);
    else if ('copy' in step) {
      const got = (await page.evaluate((cut) => (window as any).nv.copy(cut), !!step.cut)) as { html: string; text: string };
      if (step.copy.text !== undefined && got.text !== step.copy.text) fails.push(`step ${n} copied text\n    want: ${JSON.stringify(step.copy.text)}\n    got:  ${JSON.stringify(got.text)}`);
      if (step.copy.html !== undefined && got.html !== step.copy.html) fails.push(`step ${n} copied html\n    want: ${step.copy.html}\n    got:  ${got.html}`);
    } else if ('wait' in step) await page.waitForTimeout(step.wait);
    else if ('expect' in step) {
      await page.waitForTimeout(20);
      fails.push(...(await check(page, step.expect, `step ${n}`)));
    }
  }
  // Task conversions run in a microtask and API writes settle asynchronously.
  await page.waitForTimeout(50);
  fails.push(...(await check(page, s.expect, 'end')));
  return fails;
}

const all = loadScenarios().filter(({ file, s }) => `${file}/${s.name}`.includes(filter));
const dir = await buildHarness();
const server = await serve(dir);
const browser = await chromium.launch({ headless: !headed });
let failed = 0;
let skipped = 0;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  page error:', e.message));
  await stubApi(page);
  await page.goto(server.url);
  await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
  for (const { file, s } of all) {
    const id = `${file}/${s.name}`;
    if (s.skip?.tiptap) {
      skipped++;
      console.log(`skip  ${id}  (${s.skip.tiptap})`);
      continue;
    }
    let fails: string[];
    try {
      fails = await run(page, s);
    } catch (e) {
      fails = [`threw: ${(e as Error).message}`];
    }
    if (print) {
      const st = (await page.evaluate(() => (window as any).nv.state())) as State;
      console.log(`----  ${id}\n${st.doc}\ntasks ${JSON.stringify(st.tasks)}  focus ${st.focus}`);
    }
    if (fails.length) {
      failed++;
      console.log(`FAIL  ${id}\n  ${fails.join('\n  ')}`);
    } else console.log(`ok    ${id}`);
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${all.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
