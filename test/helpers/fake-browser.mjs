// A stand-in for the WebExtension APIs the background script uses, enough
// to load src/background/background.js in Node and drive it from outside:
// messages and ports from content scripts and extension pages, storage,
// tabs, scripting, permissions, the badge and commands. Every call the
// background makes is recorded, so a test can check what it did.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
export const BASE = 'moz-extension://renard-test/';
export const EXT_ID = 'renard@test';

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    dispatch: (...args) => listeners.map((fn) => fn(...args)),
  };
}

// Lets everything already queued (promise chains, setImmediate, short
// timers) run.
export async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

function storageArea(onChanged, areaName) {
  let data = {};
  const pick = (keys) => {
    if (keys == null) return structuredClone(data);
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = structuredClone(data[k]);
    return out;
  };
  const notify = (changes) => {
    if (onChanged && Object.keys(changes).length) setImmediate(() => onChanged.dispatch(changes, areaName));
  };
  return {
    get: async (keys) => pick(keys),
    set: async (items) => {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      notify(changes);
    },
    remove: async (keys) => {
      const changes = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
        changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      notify(changes);
    },
    clear: async () => {
      data = {};
    },
    setAccessLevel: async (opts) => {
      areaAccess.push(opts);
    },
    // Test helpers: read or replace everything without events.
    _dump: () => structuredClone(data),
    _load: (obj) => {
      data = structuredClone(obj);
    },
  };
}
const areaAccess = [];

// Just enough IndexedDB for settings.js's key store.
function fakeIndexedDB() {
  const dbs = new Map();
  return {
    _dbs: dbs,
    open(name) {
      const req = {};
      setImmediate(() => {
        let stores = dbs.get(name);
        const fresh = !stores;
        if (fresh) {
          stores = new Map();
          dbs.set(name, stores);
        }
        req.result = {
          createObjectStore: (s) => stores.set(s, new Map()),
          close() {},
          transaction(storeName) {
            const data = stores.get(storeName);
            if (!data) throw new Error('NotFoundError');
            const tx = {};
            let pending = 0;
            const done = () => {
              if (--pending === 0) setImmediate(() => tx.oncomplete && tx.oncomplete());
            };
            tx.objectStore = () => ({
              get(key) {
                const r = {};
                pending++;
                setImmediate(() => {
                  r.result = structuredClone(data.get(key));
                  done();
                });
                return r;
              },
              put(value, key) {
                const r = {};
                pending++;
                setImmediate(() => {
                  data.set(key, structuredClone(value));
                  r.result = key;
                  done();
                });
                return r;
              },
            });
            return tx;
          },
        };
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

// Match patterns as the background uses them: https://host/*, https://*/*,
// <all_urls>.
function matches(pattern, url) {
  if (pattern === '<all_urls>') return /^(https?|wss?|file|ftp):/.test(url);
  const m = /^(\*|https?):\/\/([^/]+)\/(.*)$/.exec(pattern);
  if (!m) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = m[1] === '*' ? /^https?:$/.test(u.protocol) : u.protocol === `${m[1]}:`;
  const host = m[2] === '*' || m[2] === u.hostname || (m[2].startsWith('*.') && u.hostname.endsWith(m[2].slice(1)));
  return scheme && host;
}

export function createFakeBrowser() {
  const calls = [];
  const record = (name, ...args) => calls.push({ name, args: structuredClone(args) });

  const storageChanged = event();
  const local = storageArea(storageChanged, 'local');
  const session = storageArea(null, 'session');

  const granted = new Set();
  const covers = (origin) =>
    granted.has(origin) || granted.has('<all_urls>') || (granted.has('https://*/*') && origin.startsWith('https://') && origin !== '<all_urls>');

  const tabs = [];
  const registered = [];
  const permissionsAdded = event();
  const permissionsRemoved = event();

  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  // Firefox reports content script files as full extension URLs.
  for (const cs of manifest.content_scripts) {
    cs.js = cs.js.map((f) => BASE + f);
    if (cs.css) cs.css = cs.css.map((f) => BASE + f);
  }

  // Provider and asset requests. Tests push handlers: (url, init) =>
  // Response | undefined; the first answer wins.
  const routes = [];
  const fetchLog = [];
  const fetch = async (input, init = {}) => {
    const url = String(input);
    fetchLog.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body, signal: init.signal });
    if (url.startsWith(BASE)) {
      const file = path.join(SRC, url.slice(BASE.length));
      if (!fs.existsSync(file)) return new Response('missing', { status: 404 });
      return new Response(fs.readFileSync(file));
    }
    for (const route of routes) {
      const res = await route(url, init);
      if (res) return res;
    }
    throw new TypeError(`fetch failed: no route for ${url}`);
  };

  const cacheEntries = new Map(); // cache name -> urls
  const caches = {
    open: async (name) => ({ keys: async () => (cacheEntries.get(name) || []).map((url) => ({ url })) }),
  };

  const ext = {
    runtime: {
      id: EXT_ID,
      getURL: (p = '') => BASE + String(p).replace(/^\//, ''),
      getManifest: () => structuredClone(manifest),
      getBrowserInfo: async () => ({ name: 'Firefox', version: '160.0' }),
      onMessage: event(),
      onConnect: event(),
      onInstalled: event(),
      onSuspend: event(),
      sendMessage: async (msg) => {
        record('runtime.sendMessage', msg);
      },
      openOptionsPage: async () => record('runtime.openOptionsPage'),
    },
    storage: { local, session, onChanged: storageChanged },
    tabs: {
      onRemoved: event(),
      query: async (q = {}) => {
        return tabs.filter((t) => {
          if (q.active !== undefined && t.active !== q.active) return false;
          if (q.windowId !== undefined && t.windowId !== q.windowId) return false;
          if (q.currentWindow && t.windowId !== 1) return false;
          if (q.url) {
            const list = Array.isArray(q.url) ? q.url : [q.url];
            if (!list.some((p) => matches(p, t.url))) return false;
          }
          return true;
        });
      },
      sendMessage: async (tabId, msg) => {
        record('tabs.sendMessage', tabId, msg);
      },
      captureVisibleTab: async (windowId, opts) => {
        record('tabs.captureVisibleTab', windowId, opts);
        if (fake.captureError) throw fake.captureError;
        return fake.captureResult;
      },
    },
    scripting: {
      executeScript: async ({ target, func, files }) => {
        record('scripting.executeScript', { target, files: files || null, probe: Boolean(func) });
        const tab = tabs.find((t) => t.id === target.tabId);
        if (!tab) throw new Error('No tab');
        if (tab.blocked) throw new Error('Cannot access contents of the page');
        if (func) return [{ result: Boolean(tab.booted) }];
        tab.booted = true;
        return [{ result: undefined }];
      },
      insertCSS: async ({ target, files }) => record('scripting.insertCSS', { target, files }),
      getRegisteredContentScripts: async ({ ids } = {}) => structuredClone(registered.filter((s) => !ids || ids.includes(s.id))),
      registerContentScripts: async (scripts) => {
        record('scripting.registerContentScripts', scripts);
        for (const s of scripts) registered.push(structuredClone(s));
      },
      unregisterContentScripts: async ({ ids }) => {
        record('scripting.unregisterContentScripts', ids);
        for (let i = registered.length - 1; i >= 0; i--) if (ids.includes(registered[i].id)) registered.splice(i, 1);
      },
    },
    permissions: {
      contains: async ({ origins = [] }) => origins.every(covers),
      remove: async ({ origins = [] }) => {
        record('permissions.remove', origins);
        const removed = origins.filter((o) => granted.delete(o));
        if (removed.length) setImmediate(() => permissionsRemoved.dispatch({ origins: removed, permissions: [] }));
        return removed.length > 0;
      },
      onAdded: permissionsAdded,
      onRemoved: permissionsRemoved,
    },
    action: {
      setBadgeText: async (o) => record('action.setBadgeText', o),
      setBadgeBackgroundColor: async (o) => record('action.setBadgeBackgroundColor', o),
      setTitle: async (o) => record('action.setTitle', o),
    },
    commands: {
      getAll: async () => [
        { name: 'toggle-bubble', shortcut: 'Alt+Shift+F' },
        { name: 'toggle-visibility', shortcut: 'Alt+Shift+H' },
      ],
      onCommand: event(),
    },
  };

  const fake = {
    ext,
    calls,
    tabs,
    registered,
    routes,
    fetchLog,
    fetch,
    caches,
    cacheEntries,
    indexedDB: fakeIndexedDB(),
    areaAccess,
    captureResult: null,
    captureError: null,
    granted,
    grant(...origins) {
      for (const o of origins) granted.add(o);
    },
    // The browser granting access, as the user would from a prompt.
    grantAndNotify(...origins) {
      fake.grant(...origins);
      permissionsAdded.dispatch({ origins, permissions: [] });
    },
    revokeAndNotify(...origins) {
      for (const o of origins) granted.delete(o);
      permissionsRemoved.dispatch({ origins, permissions: [] });
    },
    addTab(tab) {
      const t = { windowId: 1, active: false, discarded: false, booted: false, ...tab };
      tabs.push(t);
      return t;
    },
    callsNamed(name) {
      return calls.filter((c) => c.name === name).map((c) => c.args);
    },
    clearCalls() {
      calls.length = 0;
      fetchLog.length = 0;
    },

    // A one-off message, as runtime.sendMessage from a content script or an
    // extension page would deliver it. Resolves to the response, or to
    // 'no-response' when no listener kept the channel open.
    message(msg, sender) {
      return new Promise((resolve) => {
        let answered = false;
        const results = ext.runtime.onMessage.dispatch(msg, { id: EXT_ID, ...sender }, (res) => {
          answered = true;
          resolve(res);
        });
        if (!answered && !results.includes(true)) resolve('no-response');
      });
    },

    // A port opened to the background (runtime.connect). Returns the
    // page's end: what it received, a way to send, and disconnect.
    connect(name, sender) {
      const received = [];
      const waiters = [];
      const bgMessage = event();
      const bgDisconnect = event();
      let open = true;
      const bgPort = {
        name,
        sender: { id: EXT_ID, ...sender },
        onMessage: bgMessage,
        onDisconnect: bgDisconnect,
        postMessage: (m) => {
          if (!open) throw new Error('Attempt to postMessage on disconnected port');
          received.push(structuredClone(m));
          for (const w of [...waiters]) w();
        },
        disconnect: () => {
          open = false;
          pagePort.disconnected = true;
          for (const w of [...waiters]) w();
        },
      };
      const pagePort = {
        received,
        disconnected: false,
        send: (m) => setImmediate(() => bgMessage.dispatch(structuredClone(m), bgPort)),
        disconnect: () => {
          if (!open) return;
          open = false;
          setImmediate(() => bgDisconnect.dispatch(bgPort));
        },
        // Resolves once a message matching pred has arrived (or the port is
        // closed by the background).
        until(pred, timeoutMs = 2000) {
          return new Promise((resolve, reject) => {
            const check = () => {
              const hit = received.find(pred);
              if (hit) {
                cleanup();
                resolve(hit);
              } else if (pagePort.disconnected) {
                cleanup();
                reject(new Error(`port closed without a matching message; got ${JSON.stringify(received)}`));
              }
            };
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error(`timed out; got ${JSON.stringify(received)}`));
            }, timeoutMs);
            const cleanup = () => {
              clearTimeout(timer);
              const i = waiters.indexOf(check);
              if (i !== -1) waiters.splice(i, 1);
            };
            waiters.push(check);
            check();
          });
        },
      };
      ext.runtime.onConnect.dispatch(bgPort);
      return pagePort;
    },
  };
  return fake;
}

// Installs the fake as the browser globals the extension code reads.
export function installFakeBrowser(fake) {
  globalThis.browser = fake.ext;
  globalThis.fetch = fake.fetch;
  globalThis.caches = fake.caches;
  globalThis.indexedDB = fake.indexedDB;
}

// An SSE response body from a list of events ({ event?, data }).
export function sseResponse(events, { status = 200 } = {}) {
  const text = events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`).join('');
  return new Response(text, { status, headers: { 'content-type': 'text/event-stream' } });
}

export function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
