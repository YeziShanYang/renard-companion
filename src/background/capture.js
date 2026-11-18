// Screenshots: a region of the visible tab, cropped and scaled to attach to
// a question.
import '../shared/constants.js';
import '../shared/image.js';
import { ext } from '../shared/settings.js';

const R = globalThis.Renard;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// A data: URL from captureVisibleTab as a Blob. fetch() would need data: in
// the extension's connect-src.
function dataUrlBlob(url) {
  const comma = url.indexOf(',');
  return R.base64Blob(url.slice(comma + 1), url.slice(5, comma).split(';')[0]);
}

// The visible part of a tab, as a PNG data: URL. Both browsers require
// access to all websites (or a fresh toolbar or shortcut use) for this; the
// bubble asks for that access when the camera is clicked.
async function captureTab(tab) {
  try {
    return await ext.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    if (/activeTab|all_urls|permission/i.test(String((err && err.message) || err))) {
      throw new Error('Renard needs access to all websites to take screenshots. Allow it under Screenshots in settings.');
    }
    throw err;
  }
}

let capturing = false;

// The region (CSS pixels) of the tab the user picked it in. The content
// script hides Renard first. The viewport's size in CSS pixels gives the
// capture's scale (device pixels and zoom). One capture at a time.
export async function captureRegion(tab, rect, viewport) {
  const r = rect || {};
  const vw = Number(viewport && viewport.w);
  const vh = Number(viewport && viewport.h);
  if (![r.x, r.y, r.w, r.h, vw, vh].every(Number.isFinite) || vw < 1 || vh < 1) throw new Error('Bad region');
  // captureVisibleTab takes whichever tab is showing in the window.
  const [shown] = await ext.tabs.query({ active: true, windowId: tab.windowId });
  if (!shown || shown.id !== tab.id) throw new Error('The tab is no longer showing.');
  if (capturing) throw new Error('A screenshot is already being taken.');
  capturing = true;
  try {
    const bitmap = await createImageBitmap(dataUrlBlob(await captureTab(tab)));
    try {
      const sx = bitmap.width / vw;
      const sy = bitmap.height / vh;
      const x = clamp(r.x, 0, vw - 1);
      const y = clamp(r.y, 0, vh - 1);
      const w = clamp(r.w, 1, vw - x);
      const h = clamp(r.h, 1, vh - y);
      return await R.prepareImage(bitmap, { x: x * sx, y: y * sy, width: w * sx, height: h * sy });
    } finally {
      bitmap.close();
    }
  } finally {
    capturing = false;
  }
}
