// The Display section: readable text and sound.
import { $, settings, saveEntry } from './page.js';

const PREF_SWITCHES = { readable: 'readableText', sound: 'sound' };

export function renderPrefs() {
  for (const [id, pref] of Object.entries(PREF_SWITCHES)) $(id).checked = Boolean(settings.prefs[pref]);
}

export function bindPrefs() {
  renderPrefs();
  for (const [id, pref] of Object.entries(PREF_SWITCHES)) {
    const input = $(id);
    input.addEventListener('change', () => saveEntry('prefs', pref, input.checked));
  }
}
