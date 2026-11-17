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
  if (key === 'otherSites' || key === 'skippedSites') return [...new Set(val.filter((h) => R.isWebHost(h)))];
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

// ---- API keys -----------------------------------------------------------------
//
// The keys live in an IndexedDB database of the extension's own origin,
// not in storage.local: Firefox lets content scripts read storage.local
// (Chrome only stops them from version 140), so a content process taken
// over by a malicious page could read the keys there, on every https site
// once Every website is on. Content scripts run in the page's origin and
// can't open this database. (Firefox runs the bubble's extension frame in
// the page's process, so there a taken-over process could reach it once
// the bubble has been opened on that page. Pages' own scripts can't.)
// Clearing site data, including Firefox's
// "delete cookies and site data when Firefox is closed", leaves extension
// origins alone. A key-free value in storage.local (apiKeysVersion) tells
// every page and the background script that the keys changed.
//
// Only the background script reads and writes the keys. The settings page
// asks it for them (renard:apiKeys) and saves through it, so the two never
// disagree, also where one of them can't open the database (Firefox refuses
// it to extension pages in a private window). Keys found in storage.local
// (from an earlier version, or saved there when the database couldn't be
// opened) are the newest copy, so they're read first, then moved into the
// database and deleted from storage.local.

const SECRETS_DB = 'renard-secrets';
let movesKeys = false;

// Called by the background script.
export function moveKeysHere() {
  movesKeys = true;
}

function secrets(mode, use) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(SECRETS_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('secrets');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction('secrets', mode);
        const req = use(tx.objectStore('secrets'));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      } catch (err) {
        // A connection the browser closed, or a value it can't store.
        db.close();
        reject(err);
      }
    };
  });
}

// This page's copy of the keys, dropped whenever they change (here or in
// another page), so the background script doesn't open the database for
// every page asking for its state.
let keysCache;
try {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('apiKeysVersion' in changes || 'apiKeys' in changes)) keysCache = undefined;
  });
} catch {
  // not an extension page (unit tests)
}

async function loadApiKeys() {
  if (keysCache !== undefined) return keysCache;
  keysCache = movesKeys ? await readApiKeys() : await askForApiKeys();
  return keysCache;
}

async function askForApiKeys() {
  const res = await ext.runtime.sendMessage({ type: 'renard:apiKeys' });
  if (!res || !res.ok) throw new Error((res && res.error) || 'No response from Renard');
  return res.result;
}

async function readApiKeys() {
  const { apiKeys: loose } = await ext.storage.local.get('apiKeys');
  if (loose !== undefined) {
    if (movesKeys) {
      try {
        await secrets('readwrite', (s) => s.put(cleanSetting('apiKeys', loose), 'apiKeys'));
        await ext.storage.local.remove('apiKeys');
      } catch {
        // The database can't be opened: the keys stay in storage.local.
      }
    }
    return loose;
  }
  try {
    return await secrets('readonly', (s) => s.get('apiKeys'));
  } catch {
    return undefined;
  }
}

async function saveApiKeys(apiKeys) {
  keysCache = undefined;
  try {
    await secrets('readwrite', (s) => s.put(apiKeys, 'apiKeys'));
  } catch {
    await ext.storage.local.set({ apiKeys });
    return;
  }
  // A copy left in storage.local would be read first.
  await ext.storage.local.remove('apiKeys');
  await ext.storage.local.set({ apiKeysVersion: `${Date.now()}-${Math.random().toString(36).slice(2)}` });
}

// Loads settings with defaults filled in. Pages that have no use for the API
// keys (the toolbar popup) pass the keys they need, so they never read them.
export async function loadSettings(keys = Object.keys(R.DEFAULTS)) {
  const plain = keys.filter((k) => k !== 'apiKeys');
  const stored = plain.length ? await ext.storage.local.get(plain) : {};
  if (keys.includes('apiKeys')) stored.apiKeys = await loadApiKeys();
  const out = {};
  for (const key of keys) out[key] = cleanSetting(key, stored[key]);
  return out;
}

export async function saveSettings(partial) {
  const { apiKeys, ...plain } = partial;
  if (apiKeys !== undefined) await saveApiKeys(apiKeys);
  if (Object.keys(plain).length) await ext.storage.local.set(plain);
}

// A storage.onChanged change set, with a change to the keys (made through
// saveSettings) listed as apiKeys.
export function changedSettings(changes) {
  const keys = Object.keys(changes).filter((k) => Object.prototype.hasOwnProperty.call(R.DEFAULTS, k));
  if ('apiKeysVersion' in changes && !keys.includes('apiKeys')) keys.push('apiKeys');
  return keys;
}

export async function hasOrigins(origins) {
  try {
    return await ext.permissions.contains({ origins });
  } catch {
    return false;
  }
}

// Whether Renard runs on a site: it's turned on in Renard, and the browser
// lets Renard in. Firefox lets users take that access away (and doesn't
// grant it on every install). s needs sites, otherSites, allSites and
// skippedSites.
export async function siteIsOn(s, site) {
  if (!site) return false;
  if (!site.generic) return s.sites[site.id] !== false && (await hasOrigins(site.origins));
  // Turned off from the toolbar popup: off in either mode.
  if (s.skippedSites.includes(site.name)) return false;
  if (s.allSites) return (await hasOrigins([R.ALL_WEB])) || (await hasOrigins(site.origins));
  return s.otherSites.includes(site.name) && (await hasOrigins(site.origins));
}

// Origins Renard needs for the current settings: every enabled site plus the
// selected provider's API.
export function requiredOrigins(settings) {
  const sites = Object.values(R.SITES)
    .filter((s) => settings.sites[s.id] !== false)
    .flatMap((s) => s.origins);
  return [...sites, ...R.PROVIDERS[settings.provider].origins];
}
