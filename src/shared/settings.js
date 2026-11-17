// Settings access for extension pages and the background script. Content
// scripts never import this; they go through background messages, which
// strip the API keys.
import './constants.js';

const R = globalThis.Renard;

export const ext = globalThis.browser ?? globalThis.chrome;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameShape(def, val) {
  if (isPlainObject(def)) return isPlainObject(val);
  if (Array.isArray(def)) return Array.isArray(val);
  return typeof val === typeof def;
}

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

// A stored model record as listModels makes it, or null. Its fields go
// straight into requests (model id, max_tokens).
function cleanModel(m) {
  if (!isPlainObject(m) || typeof m.id !== 'string' || !m.id || m.id.length > 200) return null;
  return {
    id: m.id,
    name: typeof m.name === 'string' && m.name ? m.name.slice(0, 200) : m.id,
    maxTokens: Number.isInteger(m.maxTokens) && m.maxTokens > 0 ? m.maxTokens : null,
    effortLow: m.effortLow === true,
  };
}

// A fox position: which edge, and how far down it (0 to 1).
function cleanPosition(p) {
  if (!isPlainObject(p) || (p.edge !== 'left' && p.edge !== 'right') || !Number.isFinite(p.y)) return null;
  return { edge: p.edge, y: Math.min(1, Math.max(0, p.y)) };
}

// A stored value can be anything (an older version, a bug, or someone
// editing extension storage by hand), so each one is checked against the
// shape of its default, entry by entry. Anything that doesn't fit falls back
// to the default instead of reaching the code that reads it.
export function cleanSetting(key, val) {
  const def = R.DEFAULTS[key];
  if (val === undefined || val === null || !sameShape(def, val)) return structuredClone(def);
  if (key === 'provider') return R.own(R.PROVIDERS, val) ? val : def;
  if (key === 'otherSites') return [...new Set(val.filter((h) => R.isWebHost(h)))];
  if (!isPlainObject(def)) return val;
  const out = structuredClone(def);
  for (const [k, v] of Object.entries(val)) {
    if (RESERVED.has(k)) continue;
    const known = Object.prototype.hasOwnProperty.call(def, k);
    if (known && def[k] !== null && !sameShape(def[k], v)) continue;
    // Entries without a typed default (a model record, a position) must
    // still be objects.
    if ((!known || def[k] === null) && v !== null && !isPlainObject(v) && key !== 'apiKeys') continue;
    out[k] = v;
  }
  if (key === 'models') {
    for (const k of Object.keys(out)) out[k] = cleanModel(out[k]);
  }
  if (key === 'positions') {
    for (const [k, p] of Object.entries(out)) {
      const clean = cleanPosition(p);
      if (clean) out[k] = clean;
      else delete out[k];
    }
  }
  if (key === 'localModel') {
    if (!R.own(R.LOCAL_MODELS, out.key)) out.key = def.key;
    out.ready = Object.fromEntries(Object.entries(out.ready).filter(([id, r]) => R.own(R.LOCAL_MODELS, id) && isPlainObject(r)));
  }
  return out;
}

// Loads settings with defaults filled in. Pages that have no use for the API
// keys (the toolbar popup) pass the keys they need, so they never read them.
export async function loadSettings(keys = Object.keys(R.DEFAULTS)) {
  const stored = await ext.storage.local.get(keys);
  const out = {};
  for (const key of keys) out[key] = cleanSetting(key, stored[key]);
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
