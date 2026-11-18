// Files the content script needs (stylesheet, lines, sprite, fonts), sent
// to it as text and base64 so the page's Content Security Policy never sees
// an extension URL.
import { ext } from '../shared/settings.js';

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function fetchAsset(path, as) {
  const res = await fetch(ext.runtime.getURL(path));
  if (!res.ok) throw new Error(`Missing asset: ${path}`);
  if (as === 'text') return res.text();
  if (as === 'json') return res.json();
  return toBase64(await res.arrayBuffer());
}

let assetsPromise = null;

// Loaded once and kept; a failed load is tried again next time.
export function loadAssets() {
  if (!assetsPromise) {
    assetsPromise = Promise.all([
      fetchAsset('content/renard.css', 'text'),
      fetchAsset('lines.json', 'json'),
      // The sprite sheet is licensed art kept out of the repository; the
      // content script falls back to a static icon when it is absent.
      fetchAsset('assets/fox-sprite-sheet.png', 'base64').catch(() => null),
      fetchAsset('icons/icon-16.png', 'base64'),
      fetchAsset('fonts/Silkscreen-Regular.ttf', 'base64'),
      fetchAsset('fonts/Silkscreen-Bold.ttf', 'base64'),
    ])
      .then(([css, lines, sprite, icon, fontRegular, fontBold]) => ({ css, lines, sprite, icon, fontRegular, fontBold }))
      .catch((err) => {
        assetsPromise = null;
        throw err;
      });
  }
  return assetsPromise;
}
