// The browser's own confirm(), alert() and prompt() must not come back into src/: they are blocked or invisible in some
// webviews (the task panel's delete button did nothing because of one), look foreign, and can't be tested. Use confirmDialog /
// chooseDialog / promptDialog from src/components/shell/dialogs.tsx (toast() for a message).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** A call of the native dialogs: confirm( / alert( / prompt( on their own or as window.x(, not someObj.confirm( or confirmDialog(. */
const NATIVE = /(?<![\w$.])(?:window\.|globalThis\.)?(?:confirm|alert|prompt)\s*\(/;

test('src/ has no native confirm(), alert() or prompt() calls', () => {
  const found: string[] = [];
  for (const file of files('src')) {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    src.split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/(['"`])(?:\.|(?!\1).)*\1/g, (m) => ' '.repeat(m.length)); // not comments or strings
      if (NATIVE.test(code)) found.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, [], `native dialogs found (use confirmDialog/promptDialog from src/components/shell/dialogs.tsx):\n${found.join('\n')}`);
});

test('the guard itself catches what it should', () => {
  for (const bad of ['if (confirm("x")) go();', 'window.alert(1)', 'const v = prompt("a", b);', 'globalThis.confirm ("x")']) assert.ok(NATIVE.test(bad), bad);
  for (const ok of ['await confirmDialog({})', 'dialog.confirm(x)', 'promptDialog({})', 'const confirm = 1;', 'onConfirm()', 'x.alert(1)']) assert.ok(!NATIVE.test(ok), ok);
});
