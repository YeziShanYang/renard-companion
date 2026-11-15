// Background script: the only extension context (besides the options page)
// that reads API keys. Content scripts reach it through messages and a
// streaming port, and only ever receive non-secret state.
import '../shared/constants.js';
import { ext, loadSettings, saveSettings, hasOrigins, requiredOrigins } from '../shared/settings.js';
import { listModels, streamAnswer, ProviderError } from '../shared/providers.js';
import { SYSTEM_PROMPT, trimChat, trimPage, buildUserMessage } from '../shared/prompt.js';
import { CACHE_NAME, hasModelFiles } from '../engine/hub.js';

const R = globalThis.Renard;

// ---------------------------------------------------------------------------
// Assets for the content script (CSS, lines, sprite, fonts). Sent as text and
// base64 so the page's CSP never sees an extension URL.

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function fetchAsset(path, as) {
  const res = await fetch(ext.runtime.getURL(path));
  if (!res.ok) throw new Error(`Missing asset: ${path}`);
  if (as === 'text') return res.text();
  if (as === 'json') return res.json();
  return toBase64(await res.arrayBuffer());
}

let assetsPromise = null;
function loadAssets() {
  if (!assetsPromise) {
    assetsPromise = Promise.all([
      fetchAsset('content/renard.css', 'text'),
      fetchAsset('lines.json', 'json'),
      // The sprite sheet is licensed art kept out of the repository; the
      // content script falls back to a static icon when it is absent.
      fetchAsset('assets/fox-sprite-sheet.png', 'base64').catch(() => null),
      fetchAsset('icons/icon-16.png', 'base64'),
      fetchAsset('fonts/Silkscreen-Regular.ttf', 'base64'),
      fetchAsset('fonts/Silkscreen-Bold.ttf', 'base64'),
    ])
      .then(([css, lines, sprite, icon, fontRegular, fontBold]) => ({ css, lines, sprite, icon, fontRegular, fontBold }))
      .catch((err) => {
        assetsPromise = null;
        throw err;
      });
  }
  return assetsPromise;
}

// ---------------------------------------------------------------------------
// Public (key-free) state for a site.

// The site a content-script message comes from. An added website is known by
// the sender's own address, not by anything the page's script claims.
function siteFor(msg, sender) {
  if (msg.site === 'web') {
    let host = '';
    try {
      host = new URL(sender.url).hostname;
    } catch {
      // no usable sender address
    }
    if (!R.isWebHost(host)) throw new Error('Unknown site');
    return R.webSite(host);
  }
  const site = R.own(R.SITES, msg.site);
  if (!site) throw new Error('Unknown site');
  return site;
}

async function publicState(site) {
  const s = await loadSettings();
  const key = site.key || site.id;
  const on = site.generic ? s.otherSites.includes(site.name) && (await hasOrigins(site.origins)) : s.sites[site.id] !== false;
  const provider = R.PROVIDERS[s.provider] || R.PROVIDERS.anthropic;
  const local = provider.id === 'local' ? R.own(R.LOCAL_MODELS, s.localModel.key) || R.LOCAL_MODELS['gemma-3-1b'] : null;
  const model = local || s.models[provider.id];
  return {
    site: site.id,
    spawned: s.spawned !== false,
    enabled: s.spawned !== false && on,
    provider: provider.id,
    providerName: provider.name,
    // For the built-in provider, "has a key" means the model is downloaded.
    hasKey: local ? Boolean(R.localReady(s.localModel, local)) : Boolean(s.apiKeys[provider.id]),
    modelName: model ? model.name : null,
    apiPermission: await hasOrigins(provider.origins),
    prefs: s.prefs,
    bubble: s.bubble,
    position: s.positions[key] || null,
    shortcuts: await shortcutStrings(),
  };
}

// Current bindings ("Alt+Shift+F"), which the user may have changed, so the
// page can recognize them when a focused text field swallows the key.
async function shortcutStrings() {
  const out = {};
  try {
    for (const c of await ext.commands.getAll()) out[c.name] = c.shortcut || '';
  } catch {
    // commands API unavailable
  }
  return out;
}

const HEX = /^[0-9a-f]{16,64}$/;

// Bubble channel keys, kept in session storage (which content scripts can't
// read) so they survive the background script being suspended in between.
const bubbleKeys = {
  memory: new Map(),
  async set(id, key) {
    if (ext.storage.session) await ext.storage.session.set({ [`bubble:${id}`]: key });
    else this.memory.set(id, key);
  },
  async get(id) {
    if (!ext.storage.session) return this.memory.get(id);
    const name = `bubble:${id}`;
    return (await ext.storage.session.get(name))[name];
  },
  async drop(id) {
    if (ext.storage.session) await ext.storage.session.remove(`bubble:${id}`);
    else this.memory.delete(id);
  },
};

// Keys for a closed tab are no longer needed.
ext.tabs.onRemoved.addListener(async (tabId) => {
  if (!ext.storage.session) return;
  const all = await ext.storage.session.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith(`bubble:${tabId}:`));
  if (stale.length) await ext.storage.session.remove(stale);
});

// Read-modify-write of a stored setting, one at a time. Two quick actions
// (two tabs saving a position, a site added then removed) each start from the
// other's result instead of overwriting it.
let writes = Promise.resolve();
const ENTRY_SETTINGS = new Set(['sites', 'prefs', 'apiKeys', 'models', 'localModel']);
function update(key, change) {
  const run = writes.then(async () => {
    const value = (await loadSettings([key]))[key];
    const next = await change(value);
    if (next !== undefined) await saveSettings({ [key]: next });
    return next;
  });
  writes = run.catch(() => {});
  return run;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const handlers = {
  'renard:getState': (msg, sender) => publicState(siteFor(msg, sender)),

  'renard:getAssets': () => loadAssets(),

  'renard:savePosition': async (msg, sender) => {
    const site = siteFor(msg, sender);
    const p = msg.position || {};
    if (p.edge !== 'left' && p.edge !== 'right') throw new Error('Bad position');
    await update('positions', (positions) => ({ ...positions, [site.key || site.id]: { edge: p.edge, y: clamp(Number(p.y) || 0, 0, 1) } }));
    return { ok: true };
  },

  'renard:savePrefs': async (msg) => {
    // Content scripts may only change the "Read chat" toggle.
    if (typeof msg.prefs?.readChat === 'boolean') await update('prefs', (prefs) => ({ ...prefs, readChat: msg.prefs.readChat }));
    return { ok: true };
  },

  'renard:saveBubble': async (msg) => {
    const b = msg.bubble || {};
    const bubble = {
      width: clamp(Math.round(Number(b.width) || 520), 280, 4000),
      height: clamp(Math.round(Number(b.height) || 0), 0, 4000),
      expanded: Boolean(b.expanded),
    };
    await saveSettings({ bubble });
    return { ok: true };
  },

  // The bubble's channel key: the content script registers it, and the frame
  // (Renard's own page, in the same tab) collects it each time it loads. The
  // key lasts as long as the bubble; it is dropped on unmount or tab close.
  'renard:bubbleKey': async (msg, sender) => {
    if (fromExtensionPage(sender) || !sender.tab || !HEX.test(msg.instance) || !HEX.test(msg.key)) throw new Error('Not allowed');
    await bubbleKeys.set(`${sender.tab.id}:${msg.instance}`, msg.key);
    return { ok: true };
  },

  'renard:frameKey': async (msg, sender) => {
    if (!(sender.url || '').startsWith(ext.runtime.getURL('bubble/bubble.html')) || !sender.tab || !HEX.test(msg.instance)) {
      throw new Error('Not allowed');
    }
    const key = await bubbleKeys.get(`${sender.tab.id}:${msg.instance}`);
    if (!key) throw new Error('No key for this bubble');
    return { key };
  },

  'renard:bubbleKeyDrop': async (msg, sender) => {
    if (fromExtensionPage(sender) || !sender.tab || !HEX.test(msg.instance)) throw new Error('Not allowed');
    await bubbleKeys.drop(`${sender.tab.id}:${msg.instance}`);
    return { ok: true };
  },

  // From the toolbar popup or settings only, never from a page.
  'renard:addSite': async (msg, sender) => {
    if (!fromExtensionPage(sender)) throw new Error('Not allowed');
    return addSite(msg.host);
  },

  // One entry of a nested setting, from the settings page, applied on top of
  // the stored value in the same queue as every other write.
  'renard:setEntry': async (msg, sender) => {
    if (!fromSettings(sender) || !ENTRY_SETTINGS.has(msg.key) || typeof msg.entry !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(msg.entry)) {
      throw new Error('Not allowed');
    }
    await update(msg.key, (value) => ({ ...value, [msg.entry]: msg.value }));
    return { ok: true };
  },

  // claude.ai or ChatGPT switched on or off from the popup.
  'renard:setSite': async (msg, sender) => {
    if (!fromExtensionPage(sender) || !R.own(R.SITES, msg.id)) throw new Error('Not allowed');
    await update('sites', (sites) => ({ ...sites, [msg.id]: Boolean(msg.on) }));
    return { ok: true };
  },

  'renard:removeSite': async (msg, sender) => {
    if (!fromExtensionPage(sender)) throw new Error('Not allowed');
    return removeSite(msg.host);
  },

  'renard:openOptions': async () => {
    await ext.runtime.openOptionsPage();
    return { ok: true };
  },

  // Built-in model, from the settings page.
  'renard:localRemove': async (msg, sender) => {
    if (!fromSettings(sender)) throw new Error('Not allowed');
    if (!R.own(R.LOCAL_MODELS, msg.key)) throw new Error('Unknown model');
    await engineRequest({ type: 'remove', key: msg.key });
    await forgetLocal(msg.key);
    return { ok: true };
  },

  // Whether a downloaded model is still whole in the cache, in the dtype this
  // GPU loads, so settings says "ready" only for a model that can load.
  // Browser data can be cleared, and another GPU may need other weights. A
  // download that is gone is forgotten, and settings and the fox offer it
  // again.
  'renard:localCheck': async (msg, sender) => {
    if (!fromSettings(sender)) throw new Error('Not allowed');
    const model = R.own(R.LOCAL_MODELS, msg.key);
    if (!model || !R.own(model.sizes, msg.dtype)) throw new Error('Unknown model');
    const cache = await caches.open(CACHE_NAME);
    const ready = hasModelFiles((await cache.keys()).map((req) => req.url), model, msg.dtype);
    if (!ready) await forgetLocal(model.id);
    return { ready };
  },
};

// Drops a built-in model's download record, so it no longer counts as ready.
function forgetLocal(key) {
  return update('localModel', (localModel) => {
    if (!R.own(localModel.ready, key)) return undefined;
    const ready = { ...localModel.ready };
    delete ready[key];
    return { ...localModel, ready };
  });
}

// ---------------------------------------------------------------------------
// Built-in model engine. Firefox's background page runs it directly (it has a
// DOM and WebGPU); Chrome's service worker hosts it in an offscreen document
// and talks to it over a port.

const ENGINE_IN_PAGE = typeof document !== 'undefined';
let creatingOffscreen = null;
const engineCalls = new Map(); // request id -> receives the request's port

async function ensureOffscreen() {
  const url = ext.runtime.getURL('engine/offscreen.html');
  const existing = await ext.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  creatingOffscreen =
    creatingOffscreen ||
    ext.offscreen
      .createDocument({ url: 'engine/offscreen.html', reasons: ['WORKERS'], justification: 'Runs the built-in Gemma model on the GPU.' })
      .finally(() => {
        creatingOffscreen = null;
      });
  await creatingOffscreen;
}

// Sends one request to the engine. onEvent receives progress and text;
// aborting the signal cancels the request.
async function engineRequest(msg, { onEvent = () => {}, signal } = {}) {
  if (ENGINE_IN_PAGE) {
    const engine = await import('../engine/engine.js');
    try {
      return await engine.handle(msg.type, msg, onEvent, signal);
    } catch (err) {
      throw new ProviderError(err.kind || 'unknown', String((err && err.message) || err));
    }
  }
  if (!ext.offscreen) {
    // src/ is the Firefox manifest; Chrome's build adds the offscreen permission.
    throw new ProviderError('unknown', 'In Chrome, load the dist/chrome build (npm run build:chrome) to use the built-in model.');
  }
  await ensureOffscreen();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let port = null;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      engineCalls.delete(id);
      if (port) port.disconnect();
      fn(value);
    };
    engineCalls.set(id, (p) => {
      port = p;
      port.onMessage.addListener((m) => {
        if (m.type === 'result') finish(resolve, m.result);
        else if (m.type === 'error') finish(reject, new ProviderError(m.kind || 'unknown', m.message));
        else onEvent(m);
      });
      port.onDisconnect.addListener(() => finish(reject, new ProviderError('network', 'The built-in model stopped unexpectedly.')));
      port.postMessage(msg);
    });
    if (signal) {
      if (signal.aborted) finish(reject, new ProviderError('aborted', 'Request cancelled'));
      signal.addEventListener('abort', () => finish(reject, new ProviderError('aborted', 'Request cancelled')));
    }
    // The offscreen document answers by opening this request's port (see
    // engine/host.js for why it doesn't accept one).
    ext.runtime.sendMessage({ type: 'renard:engineCall', id }).catch(() => finish(reject, new ProviderError('network', 'The built-in model is not running.')));
  });
}

// A port the offscreen document opened for one engine request.
ext.runtime.onConnect.addListener((port) => {
  const prefix = 'renard:engine:';
  if (!port.name.startsWith(prefix) || port.sender?.id !== ext.runtime.id || port.sender.url !== ext.runtime.getURL('engine/offscreen.html')) return;
  const start = engineCalls.get(port.name.slice(prefix.length));
  if (start) start(port);
  else port.disconnect(); // a request that was cancelled meanwhile
});

// The chat or page text sent with a question, trimmed to the budget. Tells
// the page how much was included.
function context(msg, post, limits = R.LIMITS) {
  let chat = null;
  let page = null;
  if (msg.page) {
    page = trimPage(msg.page, limits.pageChars);
    if (page) post({ type: 'context', page: true, included: page.text.length, total: page.total, partial: page.partial });
  } else if (msg.chat && Array.isArray(msg.chat.turns)) {
    chat = { ...trimChat(msg.chat.turns, limits), siteName: String(msg.chat.siteName || '').slice(0, 100) };
    post({ type: 'context', included: chat.turns.length, total: chat.total, partial: chat.partial });
  }
  return { chat, page };
}

async function answerLocally(s, msg, post, signal) {
  const model = R.own(R.LOCAL_MODELS, s.localModel.key) || R.LOCAL_MODELS['gemma-3-1b'];
  if (!R.localReady(s.localModel, model)) throw new ProviderError('localMissing', `Download ${model.name} in settings first.`);
  const { chat, page } = context(msg, post, { chatChars: R.LIMITS.localChatChars, turnChars: R.LIMITS.localTurnChars, pageChars: R.LIMITS.localPageChars });
  const question = String(msg.question || '').slice(0, 20000);
  try {
    await engineRequest(
      { type: 'generate', key: model.id, system: SYSTEM_PROMPT, user: buildUserMessage(question, chat, page), maxNewTokens: 1024 },
      {
        signal,
        onEvent: (e) => {
          if (e.type === 'delta') post({ type: 'delta', text: e.text });
          else if (e.type === 'loading') post({ type: 'loading' });
        },
      },
    );
  } catch (err) {
    // The engine found the download missing from the cache, so it isn't
    // ready any more.
    if (err.kind === 'localMissing') await forgetLocal(model.id);
    throw err;
  }
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== ext.runtime.id) return false;
  const handler = msg && R.own(handlers, msg.type);
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
    );
  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// Asking: one port per question. Disconnecting the port cancels the request.

async function answer(msg, post, signal) {
  const s = await loadSettings();
  const provider = R.own(R.PROVIDERS, s.provider) || R.PROVIDERS.anthropic;
  if (provider.id === 'local') return answerLocally(s, msg, post, signal);
  const apiKey = s.apiKeys[provider.id];
  if (!apiKey) throw new ProviderError('keyMissing', 'No API key set');
  if (!R.isApiKey(apiKey)) throw new ProviderError('keyInvalid', 'That API key has characters a key never has.');
  if (!(await hasOrigins(provider.origins))) {
    throw new ProviderError('permission', `Renard does not have access to ${provider.origins[0]}`);
  }

  let model = s.models[provider.id];
  if (!model) {
    const list = await listModels(provider.id, apiKey, { signal });
    if (!list.length) throw new ProviderError('modelUnavailable', 'No models are available for this key.');
    model = list[0];
    await update('models', (models) => ({ ...models, [provider.id]: models[provider.id] || model }));
  }

  const { chat, page } = context(msg, post);

  const question = String(msg.question || '').slice(0, 20000);
  await streamAnswer(provider.id, {
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    user: buildUserMessage(question, chat, page),
    signal,
    onDelta: (text) => post({ type: 'delta', text }),
  });
}

// Settings page: downloads (and loads) a built-in model, reporting progress.
// The page pings over the port, which keeps Firefox's background page awake
// through a long download.
ext.runtime.onConnect.addListener((port) => {
  if (port.name !== 'renard:local' || port.sender?.id !== ext.runtime.id || !fromSettings(port.sender)) return;
  // A download can't be cancelled midway, so it isn't tied to the page: if
  // settings closes, it carries on and is recorded as ready when it finishes,
  // unless the browser suspends the idle background first (then Download
  // again reuses the files already fetched). Messages to a page that has gone
  // are dropped.
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
  });
  const post = (m) => {
    if (!open) return;
    try {
      port.postMessage(m);
    } catch {
      open = false;
    }
  };
  port.onMessage.addListener(async (msg) => {
    const model = msg && msg.type === 'prepare' && R.own(R.LOCAL_MODELS, msg.key);
    if (!model) return;
    try {
      const result = await engineRequest({ type: 'prepare', key: model.id }, { onEvent: post });
      const record = {
        dtype: result.dtype,
        bytes: result.bytes || model.sizes[result.dtype] || 0,
        revision: model.revision,
        at: Date.now(),
      };
      await update('localModel', (localModel) => ({ ...localModel, ready: { ...localModel.ready, [model.id]: record } }));
      post({ type: 'ready', ...record });
    } catch (err) {
      if (err.kind !== 'aborted') post({ type: 'error', kind: err.kind || 'unknown', message: String((err && err.message) || err) });
    }
  });
});

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== 'renard:ask' || port.sender?.id !== ext.runtime.id) return;
  const controller = new AbortController();
  let open = true;
  const post = (m) => {
    if (open) port.postMessage(m);
  };
  port.onDisconnect.addListener(() => {
    open = false;
    controller.abort();
  });
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'ask') return;
    answer(msg, post, controller.signal).then(
      () => post({ type: 'done' }),
      (err) => {
        const e = err instanceof ProviderError ? err : new ProviderError('unknown', String(err?.message || err));
        if (e.kind !== 'aborted') post({ type: 'error', kind: e.kind, message: e.message, status: e.status });
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Keep open tabs in sync with settings, and flag missing site access.

// Every tab, not just Renard's sites: a site that was just removed is no
// longer in the list (and its access may be gone), but its fox still needs
// to hear that it should leave. Tabs without Renard ignore the message.
async function broadcastRefresh() {
  let tabs = [];
  try {
    tabs = await ext.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    ext.tabs.sendMessage(tab.id, { type: 'renard:refresh' }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Added websites get the same content scripts, registered for their hosts.
// Registrations are rebuilt at startup because Firefox drops them when the
// extension updates.

const SITE_SCRIPTS = 'renard-other-sites';
let siteScripts = Promise.resolve();

async function grantedOtherSites() {
  const { otherSites } = await loadSettings(['otherSites']);
  const out = [];
  for (const host of otherSites) {
    if (R.isWebHost(host) && (await hasOrigins([R.originFor(host)]))) out.push(host);
  }
  return out;
}

function syncSiteScripts() {
  siteScripts = siteScripts
    .then(async () => {
      const matches = (await grantedOtherSites()).map(R.originFor).sort();
      const [existing] = await ext.scripting.getRegisteredContentScripts({ ids: [SITE_SCRIPTS] });
      if (existing && [...existing.matches].sort().join() === matches.join()) return;
      if (existing) await ext.scripting.unregisterContentScripts({ ids: [SITE_SCRIPTS] });
      if (!matches.length) return;
      await ext.scripting.registerContentScripts([
        { id: SITE_SCRIPTS, matches, js: ext.runtime.getManifest().content_scripts[0].js, runAt: 'document_idle' },
      ]);
    })
    .catch((err) => console.warn('[Renard] site scripts:', err));
  return siteScripts;
}

// Content scripts report the page's address; extension pages their own.
function fromExtensionPage(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(ext.runtime.getURL(''));
}

function fromSettings(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(ext.runtime.getURL('options/'));
}

// Adds a website the user granted access to and brings Renard to its open
// tabs right away (the registered script covers pages loaded later).
const adding = new Map(); // host -> promise, so the popup and onAdded don't both inject

function addSite(host) {
  if (!adding.has(host)) adding.set(host, addSiteOnce(host).finally(() => adding.delete(host)));
  return adding.get(host);
}

async function addSiteOnce(host) {
  if (!R.isWebHost(host)) throw new Error('Renard cannot visit that site.');
  const origin = R.originFor(host);
  if (!(await hasOrigins([origin]))) throw new Error(`Renard needs access to ${host} first.`);
  await update('otherSites', (otherSites) => (otherSites.includes(host) ? undefined : [...otherSites, host]));
  await syncSiteScripts();
  let tabs = [];
  try {
    tabs = await ext.tabs.query({ url: origin });
  } catch {
    // no matching tabs
  }
  const files = ext.runtime.getManifest().content_scripts[0].js;
  let blocked = 0;
  for (const t of tabs) {
    // A page that already has Renard's script ignores a second copy.
    await ext.scripting.executeScript({ target: { tabId: t.id }, files }).catch(() => blocked++);
  }
  return { added: host, tabs: tabs.length, blocked };
}

async function removeSite(host) {
  await update('otherSites', (otherSites) => (otherSites.includes(host) ? otherSites.filter((h) => h !== host) : undefined));
  if (R.isWebHost(host)) await ext.permissions.remove({ origins: [R.originFor(host)] }).catch(() => {});
  return { removed: host };
}

// A single website granted from the popup's switch (or the browser's own
// site-access controls) means "Renard here", so add it.
function grantedWebHosts(permissions) {
  const out = [];
  for (const origin of (permissions && permissions.origins) || []) {
    const m = /^https:\/\/([^/*]+)\/\*$/.exec(origin);
    if (m && R.isWebHost(m[1])) out.push(m[1]);
  }
  return out;
}

// Access to an added site was revoked (in the browser's own settings, say):
// forget the site, so the list only ever holds sites Renard can reach.
async function pruneOtherSites() {
  await update('otherSites', async (otherSites) => {
    const keep = [];
    for (const host of otherSites) {
      if (R.isWebHost(host) && (await hasOrigins([R.originFor(host)]))) keep.push(host);
    }
    return keep.length === otherSites.length ? undefined : keep;
  });
}

async function updateBadge() {
  const s = await loadSettings();
  const ok = await hasOrigins(requiredOrigins(s));
  const action = ext.action;
  await action.setBadgeText({ text: ok ? '' : '!' });
  if (!ok) await action.setBadgeBackgroundColor({ color: '#d67941' });
  await action.setTitle({ title: ok ? 'Renard' : 'Renard needs site access' });
}

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['spawned', 'provider', 'apiKeys', 'models', 'sites', 'otherSites', 'prefs', 'localModel'].some((k) => k in changes)) {
    broadcastRefresh();
    updateBadge().catch(() => {});
  }
  if ('otherSites' in changes) syncSiteScripts();
});

ext.permissions.onAdded.addListener((permissions) => {
  updateBadge().catch(() => {});
  broadcastRefresh();
  for (const host of grantedWebHosts(permissions)) addSite(host).catch(() => {});
});
ext.permissions.onRemoved.addListener(() => {
  updateBadge().catch(() => {});
  broadcastRefresh();
  pruneOtherSites()
    .then(() => syncSiteScripts())
    .catch(() => {});
});

ext.commands.onCommand.addListener(async (command, tab) => {
  let tabId = tab && tab.id;
  if (tabId == null) {
    const [active] = await ext.tabs.query({ active: true, currentWindow: true });
    tabId = active && active.id;
  }
  if (tabId != null) ext.tabs.sendMessage(tabId, { type: 'renard:command', command }).catch(() => {});
});

ext.runtime.onInstalled.addListener(async (details) => {
  updateBadge().catch(() => {});
  syncSiteScripts();
  if (details.reason !== 'install') return;
  // First run only: open settings when no key is saved yet, so reinstalling
  // during development doesn't open another settings tab each time.
  const s = await loadSettings();
  if (!Object.values(s.apiKeys).some(Boolean)) ext.runtime.openOptionsPage();
});

updateBadge().catch(() => {});
syncSiteScripts();

// No content script reads storage (they get key-free state by message).
// Where the browser supports it, lock storage to extension pages so a
// compromised site process can't ask for the keys either.
try {
  Promise.resolve(ext.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })).catch(() => {});
} catch {
  // not supported for this storage area
}
