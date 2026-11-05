import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatKeys, listCommands, parseKeys, registerCommands, runCommand } from '../src/hooks/useShortcuts.ts';

test('parseKeys handles sequences and modifiers', () => {
  assert.deepEqual(parseKeys('g t'), [
    { key: 'g', mod: false, shift: false, alt: false },
    { key: 't', mod: false, shift: false, alt: false },
  ]);
  assert.deepEqual(parseKeys('mod+shift+K'), [{ key: 'k', mod: true, shift: true, alt: false }]);
  assert.deepEqual(parseKeys('mod++'), [{ key: '+', mod: true, shift: false, alt: false }]);
});

test('formatKeys renders display labels (non-Apple in node)', () => {
  assert.deepEqual(formatKeys('mod+k'), ['Ctrl', 'K']);
  assert.deepEqual(formatKeys('g t'), ['G', 'then', 'T']);
  assert.deepEqual(formatKeys('mod+shift+enter'), ['Ctrl', 'Shift', '↵']);
  assert.deepEqual(formatKeys('?'), ['?']);
});

test('registry: register, run, when, unregister, override by id', () => {
  let ran = 0;
  let enabled = true;
  const off = registerCommands([{ id: 't.a', title: 'A', run: () => void ran++, when: () => enabled }]);
  assert.equal(runCommand('t.a'), true);
  assert.equal(ran, 1);
  enabled = false;
  assert.equal(runCommand('t.a'), false);
  assert.equal(listCommands().some((c) => c.id === 't.a'), false);
  enabled = true;
  const off2 = registerCommands([{ id: 't.a', title: 'A2', run: () => void (ran += 10) }]);
  runCommand('t.a');
  assert.equal(ran, 11);
  off(); // unregistering the replaced one leaves the override in place
  assert.equal(listCommands().find((c) => c.id === 't.a')?.title, 'A2');
  off2();
  assert.equal(runCommand('t.a'), false);
});

test('"Send feedback" is a palette command registered by the shell, and the help overlay links to it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const line = src('../src/components/shell/commands.tsx').split('\n').find((l) => l.includes("id: 'app.feedback'"));
  assert.ok(line, 'app.feedback is registered');
  assert.match(line, /title: 'Send feedback'/);
  assert.match(line, /run: openFeedback/);
  assert.doesNotMatch(line, /palette: false/); // visible in the command palette
  assert.match(src('../src/components/Overlays.tsx'), /openFeedback\(\)/); // listed in help (the ? overlay and Settings > Keyboard shortcuts)
  assert.match(src('../src/components/AppShell.tsx'), /<FeedbackHost \/>/);
});
