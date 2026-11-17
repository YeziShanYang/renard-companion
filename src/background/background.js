// Background script: the only extension context (besides the options page)
// that reads API keys. Content scripts reach it through messages and a
// streaming port, and only ever receive non-secret state.
import '../shared/constants.js';
import '../shared/image.js';
import { ext, loadSettings, saveSettings, hasOrigins, requiredOrigins, siteIsOn } from '../shared/settings.js';
import { listModels, streamAnswer, ProviderError } from '../shared/providers.js';
import { SYSTEM_PROMPT, localSystemPrompt, trimChat, trimPage, buildUserMessage, turnFilter, clipStart, aimedAtModels } from '../shared/prompt.js';
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

// The site a content-script message comes from. The sender's own address
// decides it: an added website is known by that address, and claude.ai or
// ChatGPT only from a page on that site.
function siteFor(msg, sender) {
  let host = '';
  try {
    host = new URL(sender.url).hostname;
  } catch {
    // no usable sender address
  }
  if (msg.site === 'web') {
    if (!R.isWebHost(host)) throw new Error('Unknown site');
    return R.webSite(host);
  }
  const site = R.own(R.SITES, msg.site);
  if (!site || R.siteForHost(host) !== site) throw new Error('Unknown site');
  return site;
}

// mount: the page is about to show the fox. tabId: the tab asking.
async function publicState(site, { tabId, mount = false } = {}) {
  const s = await loadSettings();
  const key = site.key || site.id;
  const on = await siteIsOn(s, site);
  const provider = R.PROVIDERS[s.provider] || R.PROVIDERS.anthropic;
  const local = provider.id === 'local' ? R.own(R.LOCAL_MODELS, s.localModel.key) || R.LOCAL_MODELS['gemma-3-1b'] : null;
  const model = local || s.models[provider.id];
  // A fox already out in this tab on this site (the user opened another page
  // of it) comes back in place instead of running in again. Sending it home
  // or turning the site off forgets that.
  let returning = false;
  if (tabId != null && ext.storage.session) {
    const name = `fox:${tabId}`;
    if (!(s.spawned !== false && on)) await ext.storage.session.remove(name);
    else if (mount) {
      returning = (await ext.storage.session.get(name))[name] === key;
      await ext.storage.session.set({ [name]: key });
    }
  }
  return {
    site: site.id,
    returning,
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
  const stale = Object.keys(all).filter((k) => k.startsWith(`bubble:${tabId}:`) || k === `fox:${tabId}`);
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

// A data: URL from captureVisibleTab as a Blob. fetch() would need data: in
// the extension's connect-src.
function dataUrlBlob(url) {
  const comma = url.indexOf(',');
  return R.base64Blob(url.slice(comma + 1), url.slice(5, comma).split(';')[0]);
}

// The visible part of a tab, as a PNG data: URL. Both browsers require
// access to all websites (or a fresh toolbar or shortcut use) for this; the
// bubble asks for that access when the camera is clicked.
async function captureTab(tab) {
  try {
    return await ext.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    if (/activeTab|all_urls|permission/i.test(String((err && err.message) || err))) {
      throw new Error('Renard needs access to all websites to take screenshots. Allow it under Screenshots in settings.');
    }
    throw err;
  }
}

let capturing = false;

const handlers = {
  'renard:getState': (msg, sender) => publicState(siteFor(msg, sender), { tabId: sender.tab && sender.tab.id, mount: msg.mount === true }),

  'renard:getAssets': () => loadAssets(),

  // Whether screenshots are allowed (access to all websites), asked before
  // the bubble shows the picker.
  'renard:captureAccess': async (msg, sender) => {
    if (fromExtensionPage(sender) || !sender.tab) throw new Error('Not allowed');
    return { granted: await hasOrigins(['<all_urls>']) };
  },

  // A region of the visible tab, to attach to a question. The content script
  // hides Renard first. The region is in CSS pixels, and the viewport's size
  // in CSS pixels gives the capture's scale (device pixels and zoom).
  'renard:capture': async (msg, sender) => {
    if (fromExtensionPage(sender) || !sender.tab) throw new Error('Not allowed');
    siteFor(msg, sender);
    const r = msg.rect || {};
    const vw = Number(msg.viewport && msg.viewport.w);
    const vh = Number(msg.viewport && msg.viewport.h);
    if (![r.x, r.y, r.w, r.h, vw, vh].every(Number.isFinite) || vw < 1 || vh < 1) throw new Error('Bad region');
    // captureVisibleTab takes whichever tab is showing in the window.
    const [shown] = await ext.tabs.query({ active: true, windowId: sender.tab.windowId });
    if (!shown || shown.id !== sender.tab.id) throw new Error('The tab is no longer showing.');
    if (capturing) throw new Error('A screenshot is already being taken.');
    capturing = true;
    try {
      const bitmap = await createImageBitmap(dataUrlBlob(await captureTab(sender.tab)));
      try {
        const sx = bitmap.width / vw;
        const sy = bitmap.height / vh;
        const x = clamp(r.x, 0, vw - 1);
        const y = clamp(r.y, 0, vh - 1);
        const w = clamp(r.w, 1, vw - x);
        const h = clamp(r.h, 1, vh - y);
        return await R.prepareImage(bitmap, { x: x * sx, y: y * sy, width: w * sx, height: h * sy });
      } finally {
        bitmap.close();
      }
    } finally {
      capturing = false;
    }
  },

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
    if (!fromPopupOrSettings(sender)) throw new Error('Not allowed');
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
    if (!fromPopupOrSettings(sender) || !R.own(R.SITES, msg.id)) throw new Error('Not allowed');
    await update('sites', (sites) => ({ ...sites, [msg.id]: Boolean(msg.on) }));
    return { ok: true };
  },

  'renard:removeSite': async (msg, sender) => {
    if (!fromPopupOrSettings(sender)) throw new Error('Not allowed');
    return removeSite(msg.host);
  },

  // Every website on or off, from settings, which asks the browser for
  // access to all secure websites first.
  'renard:setAllSites': async (msg, sender) => {
    if (!fromSettings(sender)) throw new Error('Not allowed');
    return setAllSites(msg.on === true);
  },

  // A website turned off, or back on, from the toolbar popup while Renard
  // is on every website. A skipped site stays off in either mode, also if
  // it was added on its own, until it's turned back on or added again.
  'renard:skipSite': async (msg, sender) => {
    if (!fromPopupOrSettings(sender) || !R.isWebHost(msg.host)) throw new Error('Not allowed');
    const skip = msg.skip === true;
    await update('skippedSites', (list) => {
      if (list.includes(msg.host) === skip) return undefined;
      return skip ? [...list, msg.host] : list.filter((h) => h !== msg.host);
    });
    // Tabs opened while the site was off have no copy of Renard's script.
    if (!skip) {
      await syncSiteScripts();
      const s = await loadSettings(['sites', 'otherSites', 'allSites', 'skippedSites']);
      if (await siteIsOn(s, R.webSite(msg.host))) await injectHost(msg.host);
    }
    return { host: msg.host, skipped: skip };
  },

  'renard:openOptions': async () => {
    await ext.runtime.openOptionsPage();
    return { ok: true };
  },

  // Chrome's offscreen document has no model loaded and nothing to do.
  // Closing it frees the memory WebGPU and ONNX Runtime keep after a model
  // is disposed (gigabytes after a long prompt). The next question opens it
  // again.
  'renard:engineIdle': async (msg, sender) => {
    if (sender.url !== ext.runtime.getURL('engine/offscreen.html') || sender.tab) throw new Error('Not allowed');
    if (engineBusy) engineIdle = true;
    else await closeOffscreen();
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

// An engine failure as a ProviderError, keeping the token counts of a
// prompt that was too long.
function engineError(e) {
  const err = new ProviderError(e.kind || 'unknown', String(e.message || e));
  if (Number.isFinite(e.tokens)) err.tokens = e.tokens;
  if (Number.isFinite(e.limit)) err.limit = e.limit;
  return err;
}

// Engine requests in progress in Chrome, counted from before the offscreen
// document is ensured, so an idle report never closes it under a new one.
// The engine reports idle just before it sends a request's result, so a
// report that arrives while busy is kept until the last request ends.
let engineBusy = 0;
let engineIdle = false;

function closeOffscreen() {
  engineIdle = false;
  if (ext.offscreen) return ext.offscreen.closeDocument().catch(() => {});
  return undefined;
}

// Sends one request to the engine. onEvent receives progress and text;
// aborting the signal cancels the request.
async function engineRequest(msg, opts = {}) {
  if (ENGINE_IN_PAGE) return engineCall(msg, opts);
  engineBusy++;
  engineIdle = false;
  try {
    return await engineCall(msg, opts);
  } finally {
    engineBusy--;
    if (!engineBusy && engineIdle) closeOffscreen();
  }
}

async function engineCall(msg, { onEvent = () => {}, signal } = {}) {
  if (ENGINE_IN_PAGE) {
    const engine = await import('../engine/engine.js');
    try {
      return await engine.handle(msg.type, msg, onEvent, signal);
    } catch (err) {
      throw engineError(err || {});
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
        else if (m.type === 'error') finish(reject, engineError(m));
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
// the page how much was included, and whether the text addresses AI models
// (aimed), which the bubble warns about.
function context(msg, post, limits = R.LIMITS) {
  let chat = null;
  let page = null;
  if (msg.page) {
    page = trimPage(msg.page, limits.pageChars);
    if (page) {
      const aimed = aimedAtModels(`${page.title}\n${page.text}`);
      post({ type: 'context', page: true, included: page.text.length, total: page.total, partial: page.partial, aimed });
    }
  } else if (msg.chat && Array.isArray(msg.chat.turns)) {
    chat = { ...trimChat(msg.chat.turns, limits), siteName: String(msg.chat.siteName || '').slice(0, 100) };
    const aimed = chat.turns.some((t) => aimedAtModels(t.text));
    post({ type: 'context', included: chat.turns.length, total: chat.total, partial: chat.partial, aimed });
  }
  return { chat, page };
}

async function answerLocally(s, msg, post, signal) {
  // The bubble turns screenshots off for the built-in model.
  if (msg.image) throw new ProviderError('unknown', "The built-in model can't read images. Ask without the screenshot, or pick an API-key provider in settings.");
  const model = R.own(R.LOCAL_MODELS, s.localModel.key) || R.LOCAL_MODELS['gemma-3-1b'];
  if (!R.localReady(s.localModel, model)) throw new ProviderError('localMissing', `Download ${model.name} in settings first.`);
  // The question and the chat or page share one budget: past it, Firefox's
  // WebGPU run fails (see R.LIMITS).
  const question = clipStart(String(msg.question || ''), 20000);
  const room = R.LIMITS.localChatChars - question.length;
  if (room < 0) {
    throw new ProviderError(
      'unknown',
      `That question is too long for the built-in model, which reads about ${R.LIMITS.localChatChars.toLocaleString('en-US')} characters at a time. Shorten it, or pick an API-key provider in settings.`,
    );
  }
  const ask = async (chars) => {
    const { chat, page } = context(msg, post, {
      chatChars: chars,
      turnChars: Math.min(R.LIMITS.localTurnChars, chars),
      pageChars: Math.min(R.LIMITS.localPageChars, chars),
    });
    // Stops generation when the model starts writing a made-up next turn,
    // except in answers about an attached chat (see turnFilter).
    const done = new AbortController();
    const filter = turnFilter((text) => post({ type: 'delta', text }), () => done.abort(), { cut: !chat });
    try {
      const result = await engineRequest(
        { type: 'generate', key: model.id, system: localSystemPrompt(chat, page), user: buildUserMessage(question, chat, page), maxNewTokens: 1024 },
        {
          signal: AbortSignal.any([signal, done.signal]),
          onEvent: (e) => {
            if (e.type === 'delta') filter.push(e.text);
            else if (e.type === 'loading') post({ type: 'loading' });
          },
        },
      );
      filter.end();
      return { stopReason: result && result.limited ? 'max_tokens' : 'end_turn' };
    } catch (err) {
      // The answer ended where the made-up turn began.
      if (filter.stopped && !signal.aborted) return { stopReason: 'end_turn' };
      throw err;
    }
  };
  try {
    try {
      return await ask(room);
    } catch (err) {
      // Characters only estimate tokens (code has more per character than
      // prose), so a prompt can still be too long for this GPU. The engine
      // refuses it before it runs, and the chat or page is cut to fit.
      if (err.kind !== 'tooLong' || !(msg.chat || msg.page) || !(err.tokens > 0)) throw err;
      return await ask(Math.floor(room * (err.limit / err.tokens) * 0.85));
    }
  } catch (err) {
    // The engine found the download missing from the cache, so it isn't
    // ready any more.
    if (err.kind === 'localMissing') await forgetLocal(model.id);
    if (err.kind === 'tooLong') {
      const reading = msg.page ? 'Read page' : 'Read chat';
      throw new ProviderError('unknown', `That's more than the built-in model can read at once. Shorten the question, or turn ${reading} off.`);
    }
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

  const question = clipStart(String(msg.question || ''), 20000);
  if (msg.image && !R.isAttachedImage(msg.image)) throw new ProviderError('unknown', "The attached image couldn't be read. Remove it and try again.");
  const images = msg.image ? [{ mediaType: msg.image.mediaType, data: msg.image.data }] : [];
  return streamAnswer(provider.id, {
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    user: buildUserMessage(question, chat, page, { screenshot: images.length > 0 }),
    images,
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
  let asked = false;
  port.onMessage.addListener((msg) => {
    // One question per port: a second would stream into the same answer.
    if (!msg || msg.type !== 'ask' || asked) return;
    asked = true;
    answer(msg, post, controller.signal).then(
      (result) => post({ type: 'done', limited: Boolean(result && result.stopReason === 'max_tokens') }),
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

// The content script's files, as paths within the extension. Firefox's
// getManifest() returns them as full moz-extension:// URLs, which
// registerContentScripts and executeScript refuse.
function extensionPath(f) {
  const base = ext.runtime.getURL('');
  return f.startsWith(base) ? f.slice(base.length) : f;
}
function contentScriptFiles() {
  return ext.runtime.getManifest().content_scripts[0].js.map(extensionPath);
}
// The stylesheet that lets Renard's element show (content/host.css). Every
// way the script reaches a page brings it along.
function contentScriptCss() {
  return (ext.runtime.getManifest().content_scripts[0].css || []).map(extensionPath);
}

// Puts Renard on an open tab now, unless this copy of Renard already runs
// there: a second copy of the files would start over the state some of
// them keep.
async function injectRenard(tabId) {
  const target = { tabId };
  const [probe] = await ext.scripting.executeScript({ target, func: () => Boolean(globalThis.Renard && globalThis.Renard.booted) });
  if (probe && probe.result === true) return;
  await ext.scripting.insertCSS({ target, files: contentScriptCss() });
  await ext.scripting.executeScript({ target, files: contentScriptFiles() });
}
let siteScripts = Promise.resolve();

// Added sites Renard runs on: allowed by the browser and not turned off.
async function grantedOtherSites() {
  const { otherSites, skippedSites } = await loadSettings(['otherSites', 'skippedSites']);
  const out = [];
  for (const host of otherSites) {
    if (R.isWebHost(host) && !skippedSites.includes(host) && (await hasOrigins([R.originFor(host)]))) out.push(host);
  }
  return out;
}

// Every website is on, and the browser lets Renard into all of them.
async function everywhere() {
  const { allSites } = await loadSettings(['allSites']);
  return allSites && (await hasOrigins([R.ALL_WEB]));
}

function syncSiteScripts() {
  siteScripts = siteScripts
    .then(async () => {
      const all = await everywhere();
      const matches = all ? [R.ALL_WEB] : (await grantedOtherSites()).map(R.originFor).sort();
      // claude.ai and ChatGPT have the manifest's content script.
      const excludeMatches = all ? Object.values(R.SITES).flatMap((site) => site.origins).sort() : [];
      const js = contentScriptFiles();
      const css = contentScriptCss();
      const same = (a, b) => [...(a || [])].map(extensionPath).sort().join() === [...b].sort().join();
      const [existing] = await ext.scripting.getRegisteredContentScripts({ ids: [SITE_SCRIPTS] });
      // An earlier version's registration (other files, or none of the
      // stylesheet) is replaced too.
      if (existing && same(existing.matches, matches) && same(existing.excludeMatches, excludeMatches) && same(existing.js, js) && same(existing.css, css)) return;
      if (existing) await ext.scripting.unregisterContentScripts({ ids: [SITE_SCRIPTS] });
      if (!matches.length) return;
      const script = { id: SITE_SCRIPTS, matches, js, css, runAt: 'document_idle' };
      if (excludeMatches.length) script.excludeMatches = excludeMatches;
      await ext.scripting.registerContentScripts([script]);
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

// The toolbar popup or the settings page. The bubble frame is an extension
// page too, but any website can embed it, so it can do only what a content
// script can.
function fromPopupOrSettings(sender) {
  return fromSettings(sender) || (typeof sender.url === 'string' && sender.url.startsWith(ext.runtime.getURL('popup/')));
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
  // Added again after being left out of Every website: no longer left out.
  await update('skippedSites', (list) => (list.includes(host) ? list.filter((h) => h !== host) : undefined));
  await syncSiteScripts();
  return { added: host, ...(await injectHost(host)) };
}

// Brings Renard to a site's open tabs now (the registered script covers
// pages loaded later). Returns how many tabs there were and how many
// refused the script.
async function injectHost(host) {
  let tabs = [];
  try {
    tabs = await ext.tabs.query({ url: R.originFor(host) });
  } catch {
    // no matching tabs
  }
  let blocked = 0;
  for (const t of tabs) await injectRenard(t.id).catch(() => blocked++);
  return { tabs: tabs.length, blocked };
}

async function removeSite(host) {
  await update('otherSites', (otherSites) => (otherSites.includes(host) ? otherSites.filter((h) => h !== host) : undefined));
  if (R.isWebHost(host)) await ext.permissions.remove({ origins: [R.originFor(host)] }).catch(() => {});
  return { removed: host };
}

// Every website on: Renard's script goes on every secure page, including
// the tabs already open. Off: it's back to the sites added one at a time.
// Firefox also gets the access to all websites back. Chrome would take
// removing it as withholding every https site inside it, claude.ai,
// ChatGPT, the AI providers' APIs and each added site included, so there
// the access stays until the user removes it and the setting alone decides.
const GIVES_BACK_ALL_WEB = typeof ext.runtime.getBrowserInfo === 'function';
async function setAllSites(on) {
  if (on && !(await hasOrigins([R.ALL_WEB]))) throw new Error('Renard needs access to all websites first.');
  await update('allSites', (was) => (was === on ? undefined : on));
  await syncSiteScripts();
  if (on) await injectWebTabs();
  else if (GIVES_BACK_ALL_WEB) await ext.permissions.remove({ origins: [R.ALL_WEB] }).catch(() => {});
  return { allSites: on };
}

async function injectWebTabs() {
  let tabs = [];
  try {
    tabs = await ext.tabs.query({ url: R.ALL_WEB });
  } catch {
    return;
  }
  const { skippedSites } = await loadSettings(['skippedSites']);
  for (const t of tabs) {
    let host = '';
    try {
      host = new URL(t.url).hostname;
    } catch {
      continue;
    }
    if (R.isWebHost(host) && !skippedSites.includes(host)) await injectRenard(t.id).catch(() => {});
  }
}

// The browser took back the access to all websites (from its own
// extension settings, say): Every website turns off, as the settings page
// then shows.
async function pruneAllSites() {
  if ((await loadSettings(['allSites'])).allSites && !(await hasOrigins([R.ALL_WEB]))) {
    await update('allSites', () => false);
  }
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
  if (['spawned', 'provider', 'apiKeys', 'models', 'sites', 'otherSites', 'allSites', 'skippedSites', 'prefs', 'localModel'].some((k) => k in changes)) {
    broadcastRefresh();
    updateBadge().catch(() => {});
  }
  if (['otherSites', 'allSites', 'skippedSites'].some((k) => k in changes)) syncSiteScripts();
});

ext.permissions.onAdded.addListener((permissions) => {
  updateBadge().catch(() => {});
  broadcastRefresh();
  for (const host of grantedWebHosts(permissions)) addSite(host).catch(() => {});
  // Access to claude.ai or ChatGPT granted later (from settings, the popup,
  // or the browser's extensions panel): bring Renard to their open tabs now.
  if (Object.values(R.SITES).some((site) => site.origins.some((o) => permissions.origins?.includes(o)))) injectOpenTabs();
});
ext.permissions.onRemoved.addListener(() => {
  updateBadge().catch(() => {});
  broadcastRefresh();
  pruneOtherSites()
    .then(() => pruneAllSites())
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

// When Renard starts after an install, update or reload, or after being
// turned back on, tabs already open on its sites have the old copy of the
// content script (which removes its fox once it notices) or no copy at all:
// Chrome doesn't inject into open tabs, and Firefox doesn't for added
// sites. Each such tab gets the current copy (injectRenard skips a tab that
// has it). Everything is injected into each tab once (an added site is also
// an https site).
async function injectOpenTabs() {
  const all = await everywhere();
  const matches = [...ext.runtime.getManifest().content_scripts[0].matches, ...(all ? [] : (await grantedOtherSites()).map(R.originFor))];
  let tabs = [];
  try {
    tabs = await ext.tabs.query({ url: matches });
  } catch {
    return;
  }
  for (const t of tabs) await injectRenard(t.id).catch(() => {});
  if (all) await injectWebTabs();
}

// Runs injectOpenTabs once per start of Renard. Session storage is empty
// whenever Renard has just started (installed, updated, turned back on, or
// the browser opened); Chrome runs onInstalled only for the first two, and
// the service worker's own restarts keep the flag.
async function startOnce() {
  if (!ext.storage.session) return;
  if ((await ext.storage.session.get('started')).started) return;
  await ext.storage.session.set({ started: true });
  await injectOpenTabs();
}

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
startOnce().catch(() => {});
// API keys still in storage.local (from an earlier version, say) move to
// the database now, out of content scripts' reach.
loadSettings(['apiKeys']).catch(() => {});

// No content script reads storage (they get key-free state by message).
// Where the browser supports it, lock storage to extension pages so a
// compromised site process can't ask for the keys either.
try {
  Promise.resolve(ext.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })).catch(() => {});
} catch {
  // not supported for this storage area
}
