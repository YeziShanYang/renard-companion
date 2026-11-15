// Toolbar popup: show or hide Renard everywhere, turn it on or off for the
// site in the current tab, and a way into settings. It reads only the
// settings it shows, never the API keys.
import '../shared/constants.js';
import { ext, loadSettings, saveSettings, hasOrigins, requiredOrigins } from '../shared/settings.js';

const R = globalThis.Renard;
const $ = (id) => document.getElementById(id);
const KEYS = ['spawned', 'provider', 'sites', 'otherSites'];

let tab = null; // { id, host, site } for the active tab

async function send(type, payload) {
  const res = await ext.runtime.sendMessage({ type, ...payload });
  if (!res || !res.ok) throw new Error((res && res.error) || 'No response from Renard');
  return res.result;
}

// The active tab and the site Renard would treat it as. Opening the popup
// grants temporary access to the tab (activeTab), so its address is visible.
async function activeTab() {
  try {
    const [t] = await ext.tabs.query({ active: true, currentWindow: true });
    if (!t) return null;
    const url = new URL(t.url || '');
    if (url.protocol !== 'https:') return { id: t.id, host: null, site: null, insecure: url.protocol === 'http:' };
    const host = url.hostname;
    return { id: t.id, host, site: R.siteForHost(host) || (R.isWebHost(host) ? R.webSite(host) : null) };
  } catch {
    return null;
  }
}

async function siteIsOn(s, site) {
  if (!site) return false;
  const listed = site.generic ? s.otherSites.includes(site.name) : s.sites[site.id] !== false;
  return listed && (await hasOrigins(site.origins));
}

function note(text) {
  $('note').textContent = text || '';
  $('note').hidden = !text;
}

async function render() {
  const s = await loadSettings(KEYS);
  tab = await activeTab();
  const site = tab && tab.site;
  const spawned = s.spawned !== false;
  const on = await siteIsOn(s, site);
  $('spawned').checked = spawned;

  $('site-row').hidden = !site;
  if (site) {
    $('site-host').textContent = tab.host;
    $('site-on').checked = on;
  }

  let status;
  if (!spawned) status = 'Napping at home. Flip the switch to bring me out!';
  else if (on) status = 'Out exploring this page!';
  else if (site) status = 'Not on this site yet. Want me here?';
  else if (tab && tab.insecure) status = 'I only visit secure (https) pages.';
  else if (tab && !tab.host) status = "I can't visit this kind of page.";
  else status = 'Out and about!';
  $('status').textContent = status;

  const access = await hasOrigins(requiredOrigins(s));
  note(access ? '' : 'I need access to a few sites. Open settings to let me in!');
}

$('spawned').addEventListener('change', async (e) => {
  // The background script sees the change and updates every open tab.
  await saveSettings({ spawned: e.target.checked });
  render();
});

// Handled on click so the permission request runs inside the click: Firefox
// shows its prompt only for a request made directly from user input.
$('site-on').addEventListener('click', (e) => {
  const input = e.currentTarget;
  const site = tab && tab.site;
  if (!site) return;
  const on = input.checked;

  if (!site.generic) {
    // claude.ai or ChatGPT: the same switch as in settings.
    loadSettings(['sites']).then(({ sites }) => saveSettings({ sites: { ...sites, [site.id]: on } }).then(render));
    if (on) ext.permissions.request({ origins: site.origins }).then(render, render);
    return;
  }

  if (!on) {
    send('renard:removeSite', { host: site.name }).then(render, render);
    return;
  }
  // Granting access to one website adds it (the background script handles
  // that, since Firefox may close this popup for the prompt). The message
  // covers access that was already granted, where no prompt appears.
  ext.permissions.request({ origins: site.origins }).then(
    (granted) => {
      if (!granted) {
        input.checked = false;
        return;
      }
      send('renard:addSite', { host: site.name }).then(render, (err) => {
        note(String(err.message || err));
        render();
      });
    },
    () => {
      input.checked = false;
    },
  );
});

$('open-settings').addEventListener('click', async () => {
  await ext.runtime.openOptionsPage();
  window.close();
});

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

drawFox();
render();
