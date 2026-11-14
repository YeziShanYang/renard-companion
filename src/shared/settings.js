// Settings access for extension pages and the background script. Content
// scripts never import this; they go through background messages, which
// strip the API keys.
import './constants.js';

const R = globalThis.Renard;

export const ext = globalThis.browser ?? globalThis.chrome;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Loads settings with defaults filled in. Pages that have no use for the API
// keys (the toolbar popup) pass the keys they need, so they never read them.
export async function loadSettings(keys = Object.keys(R.DEFAULTS)) {
  const stored = await ext.storage.local.get(keys);
  const out = {};
  for (const key of keys) {
    const def = R.DEFAULTS[key];
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
