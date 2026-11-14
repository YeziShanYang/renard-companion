// Builds store-ready zips for each browser in dist/:
//   dist/renard-firefox-<version>.zip  (for addons.mozilla.org)
//   dist/renard-chrome-<version>.zip   (for the Chrome Web Store)
//
// src/manifest.json serves both browsers during development; each package
// drops the keys its browser ignores or warns about. The licensed sprite
// sheet is required, since a published build should show the real fox.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const WEB_EXT = path.join(ROOT, 'node_modules', '.bin', 'web-ext');

if (!fs.existsSync(path.join(SRC, 'assets', 'fox-sprite-sheet.png'))) {
  console.error('Missing src/assets/fox-sprite-sheet.png: store builds need the sprite sheet.');
  process.exit(1);
}
if (!fs.existsSync(path.join(SRC, 'vendor', 'transformers', 'transformers.min.js'))) {
  console.error('Missing src/vendor/transformers/: run npm install (or npm run vendor).');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

const TARGETS = {
  // Firefox runs background.scripts; service_worker is ignored there.
  firefox: (m) => {
    delete m.background.service_worker;
    // The built-in model runs in Firefox's background page; offscreen
    // documents are Chrome's.
    m.permissions = m.permissions.filter((p) => p !== 'offscreen');
    return m;
  },
  // Chrome runs background.service_worker and does not know Firefox's keys.
  chrome: (m) => {
    delete m.background.scripts;
    delete m.browser_specific_settings;
    return m;
  },
};

fs.mkdirSync(DIST, { recursive: true });
for (const [target, adjust] of Object.entries(TARGETS)) {
  const dir = path.join(DIST, target);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(SRC, dir, { recursive: true, filter: (p) => !path.basename(p).startsWith('.') });
  const m = adjust(structuredClone(manifest));
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
  const filename = `renard-${target}-${manifest.version}.zip`;
  execFileSync(WEB_EXT, ['build', '--source-dir', dir, '--artifacts-dir', DIST, '--filename', filename, '--overwrite-dest'], { stdio: 'inherit' });
  if (target === 'firefox') execFileSync(WEB_EXT, ['lint', '--source-dir', dir], { stdio: 'inherit' });
  console.log(`built dist/${filename}`);
}
