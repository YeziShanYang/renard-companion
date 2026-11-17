// Builds each browser's package in dist/<browser>/ and, unless --no-zip,
// a store-ready zip:
//   dist/renard-firefox-<version>.zip  (for addons.mozilla.org)
//   dist/renard-chrome-<version>.zip   (for the Chrome Web Store)
// --target firefox|chrome builds just one.
//
// src/manifest.json is written for Firefox, so src/ loads in Firefox without
// warnings. Each package adjusts it: Chrome gets a service worker in place of
// background scripts, the offscreen permission (for the built-in model), and
// drops Firefox-only keys. The licensed sprite sheet is required for the
// zips, since a published build should show the real fox. A --no-zip build
// for local testing works without it, as src/ does.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const WEB_EXT = path.join(ROOT, 'node_modules', '.bin', 'web-ext');

const args = process.argv.slice(2);
const only = args.includes('--target') ? args[args.indexOf('--target') + 1] : null;
const zip = !args.includes('--no-zip');

if (zip && !fs.existsSync(path.join(SRC, 'assets', 'fox-sprite-sheet.png'))) {
  console.error('Missing src/assets/fox-sprite-sheet.png: store builds need the sprite sheet (--no-zip builds without it).');
  process.exit(1);
}
if (!fs.existsSync(path.join(SRC, 'vendor', 'transformers', 'transformers.min.js'))) {
  console.error('Missing src/vendor/transformers/: run npm install (or npm run vendor).');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

const TARGETS = {
  // Firefox runs background.scripts; service_worker is ignored there.
  firefox: (m) => m,
  // Chrome runs a service worker, needs an offscreen document for the
  // built-in model (its service worker can't use the GPU for it), and does
  // not know Firefox's keys.
  chrome: (m) => {
    m.background = { service_worker: m.background.scripts[0], type: 'module' };
    delete m.browser_specific_settings;
    m.permissions = [...new Set([...m.permissions, 'offscreen'])];
    // chrome.runtime.getContexts (the offscreen check) and AbortSignal.any.
    m.minimum_chrome_version = '116';
    return m;
  },
};

if (only && !TARGETS[only]) {
  console.error(`Unknown --target ${only}; use firefox or chrome.`);
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
for (const [target, adjust] of Object.entries(TARGETS)) {
  if (only && target !== only) continue;
  const dir = path.join(DIST, target);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(SRC, dir, { recursive: true, filter: (p) => !path.basename(p).startsWith('.') });
  // The GPL travels with every copy of Renard that is handed out.
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(dir, 'LICENSE'));
  const m = adjust(structuredClone(manifest));
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
  if (!zip) {
    console.log(`built dist/${target}/`);
    continue;
  }
  const filename = `renard-${target}-${manifest.version}.zip`;
  execFileSync(WEB_EXT, ['build', '--source-dir', dir, '--artifacts-dir', DIST, '--filename', filename, '--overwrite-dest'], { stdio: 'inherit' });
  if (target === 'firefox') execFileSync(WEB_EXT, ['lint', '--source-dir', dir], { stdio: 'inherit' });
  console.log(`built dist/${filename}`);
}
