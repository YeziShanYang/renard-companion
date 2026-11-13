// Settings access for extension pages and the background script. Content
// scripts never import this; they go through background messages, which
// strip the API keys.
import './constants.js';

const R = globalThis.Renard;

export const ext = globalThis.browser ?? globalThis.chrome;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export async function loadSettings() {
  const stored = await ext.storage.local.get(Object.keys(R.DEFAULTS));
  const out = {};
  for (const [key, def] of Object.entries(R.DEFAULTS)) {
    const val = stored[key];
    out[key] = isPlainObject(def) ? { ...def, ...(isPlainObject(val) ? val : {}) } : val ?? def;
  }
  return out;
}

export function saveSettings(partial) {
  return ext.storage.local.set(partial);
}

export async function hasOrigins(origins) {
  try {
    return await ext.permissions.contains({ origins });
  } catch {
    return false;
  }
}

// Origins Renard needs for the current settings: every enabled site plus the
// selected provider's API.
export function requiredOrigins(settings) {
  const sites = Object.values(R.SITES)
    .filter((s) => settings.sites[s.id] !== false)
    .flatMap((s) => s.origins);
  return [...sites, ...R.PROVIDERS[settings.provider].origins];
}
