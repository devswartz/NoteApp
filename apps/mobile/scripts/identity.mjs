// Copies the product name from shared/config.ts (APP_NAME) into the native
// projects, so renaming the app stays a one-line change. Run by
// `npm run mobile:sync` after `cap sync` (which doesn't touch these files).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = readFileSync(join(mobile, '../../shared/config.ts'), 'utf8');
const name = /export const APP_NAME = '([^']+)'/.exec(config)?.[1];
if (!name) throw new Error('APP_NAME not found in shared/config.ts');
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const androidName = xml(name).replace(/'/g, "\\'");

const edit = (rel, fn) => {
  const file = join(mobile, rel);
  const before = readFileSync(file, 'utf8');
  const after = fn(before);
  if (after !== before) {
    writeFileSync(file, after);
    console.log(`identity: updated ${rel}`);
  }
};

edit('android/app/src/main/res/values/strings.xml', (s) =>
  s.replace(/(<string name="(?:app_name|title_activity_main)">)[^<]*(<\/string>)/g, `$1${androidName}$2`),
);
for (const plist of ['ios/App/App/Info.plist', 'ios/App/ShareExtension/Info.plist', 'ios/App/TodayWidget/Info.plist']) {
  try {
    edit(plist, (s) => s.replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${xml(name)}$2`));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
