// What every section of the settings page shares: the settings as this
// page last saw them, saving, and a few controls.
import '../shared/constants.js';
import { ext, saveSettings, send } from '../shared/settings.js';

export { send };

export const $ = (id) => document.getElementById(id);

export const IS_FIREFOX = typeof ext.runtime.getBrowserInfo === 'function';

// Every setting, as loaded at startup and kept up to date by this page's
// own saves and by changes made elsewhere (see options.js).
export const settings = {};

let savedTimer = 0;

function flashSaved() {
  const el = $('saved');
  el.textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    el.textContent = '';
  }, 1400);
}

export async function save(partial) {
  Object.assign(settings, partial);
  await saveSettings(partial);
  flashSaved();
}

// Sets one entry of a nested setting (sites, prefs, apiKeys, models,
// localModel). The background applies it on top of the stored value, in the
// same queue as its own writes, so two quick toggles here, or a change made
// elsewhere (another settings tab, the popup, a bubble), never cancel out.
export async function saveEntry(key, entry, value) {
  settings[key] = { ...settings[key], [entry]: value };
  await send('renard:setEntry', { key, entry, value });
  flashSaved();
}

// JSON with sorted keys, so stored objects compare equal whatever order a
// browser returns their keys in.
export function stable(value) {
  return JSON.stringify(value, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
}

export function switchControl(id, checked, labelledBy) {
  const label = document.createElement('label');
  label.className = 'switch';
  const input = Object.assign(document.createElement('input'), { type: 'checkbox', id, checked });
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-labelledby', labelledBy);
  const track = document.createElement('span');
  track.className = 'switch-track';
  const thumb = document.createElement('span');
  thumb.className = 'switch-thumb';
  track.append(thumb);
  label.append(input, track);
  return { label, input };
}

// permissions.request() must run synchronously inside the click handler
// (Firefox drops the user gesture after an await), so origins are computed
// before the click.
export function accessButton(origins, onDone, label = 'Allow access') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    ext.permissions.request({ origins }).then(onDone, onDone);
  });
  return btn;
}
