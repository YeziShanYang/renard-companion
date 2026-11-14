// Toolbar popup: show or hide Renard everywhere, and a way into settings.
// It reads only the settings it shows, never the API keys.
import '../shared/constants.js';
import { ext, loadSettings, saveSettings, hasOrigins, requiredOrigins } from '../shared/settings.js';

const R = globalThis.Renard;
const $ = (id) => document.getElementById(id);
const KEYS = ['spawned', 'provider', 'sites'];

// The site in the active tab, if it is one of Renard's. The tab's URL is only
// visible for sites Renard has access to, which is the case that matters.
async function activeSite() {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    return tab && tab.url ? R.siteForHost(new URL(tab.url).hostname) : null;
  } catch {
    return null;
  }
}

async function render() {
  const s = await loadSettings(KEYS);
  const [site, access] = await Promise.all([activeSite(), hasOrigins(requiredOrigins(s))]);
  const spawned = s.spawned !== false;
  $('spawned').checked = spawned;

  let status;
  if (!spawned) status = 'Resting at home.';
  else if (site && s.sites[site.id] === false) status = `Turned off for ${site.name} in settings.`;
  else if (site) status = 'Out on this page.';
  else status = 'Out on claude.ai and ChatGPT.';
  $('status').textContent = status;

  const note = $('note');
  note.hidden = access;
  note.textContent = access ? '' : 'Renard needs access to some sites. Open settings to allow it.';
}

function drawFox() {
  const canvas = $('fox');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = (sheet, fallback) => {
    const sprite = new R.Sprite(canvas, sheet, fallback);
    if (reduce) sprite.hold('idle', 0);
    else sprite.play('idle');
  };
  const img = new Image();
  img.onload = () => start(img, null);
  img.onerror = () => {
    const icon = new Image();
    icon.onload = () => start(null, icon);
    icon.src = '../icons/icon-16.png';
  };
  img.src = '../assets/fox-sprite-sheet.png';
}

$('spawned').addEventListener('change', async (e) => {
  // The background script sees the change and updates every open tab.
  await saveSettings({ spawned: e.target.checked });
  render();
});

$('open-settings').addEventListener('click', async () => {
  await ext.runtime.openOptionsPage();
  window.close();
});

drawFox();
render();
