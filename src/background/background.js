// Background script: the only extension context (besides the options page)
// that reads API keys. Content scripts reach it through messages and a
// streaming port, and only ever receive non-secret state.
import '../shared/constants.js';
import { ext, loadSettings, saveSettings, hasOrigins, requiredOrigins } from '../shared/settings.js';
import { listModels, streamAnswer, ProviderError } from '../shared/providers.js';
import { SYSTEM_PROMPT, trimChat, buildUserMessage } from '../shared/prompt.js';

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

async function publicState(siteId) {
  const s = await loadSettings();
  const provider = R.PROVIDERS[s.provider] || R.PROVIDERS.anthropic;
  const local = provider.id === 'local' ? R.LOCAL_MODELS[s.localModel.key] || R.LOCAL_MODELS['gemma-3-1b'] : null;
  const model = local || s.models[provider.id];
  return {
    site: siteId,
    enabled: s.sites[siteId] !== false,
    provider: provider.id,
    providerName: provider.name,
    // For the built-in provider, "has a key" means the model is downloaded.
    hasKey: local ? Boolean(s.localModel.ready[local.id]) : Boolean(s.apiKeys[provider.id]),
    modelName: model ? model.name : null,
    apiPermission: await hasOrigins(provider.origins),
    prefs: s.prefs,
    bubble: s.bubble,
    position: s.positions[siteId] || null,
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

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const handlers = {
  'renard:getState': (msg) => {
    if (!R.SITES[msg.site]) throw new Error('Unknown site');
    return publicState(msg.site);
  },

  'renard:getAssets': () => loadAssets(),

  'renard:savePosition': async (msg) => {
    const p = msg.position || {};
    if (!R.SITES[msg.site] || (p.edge !== 'left' && p.edge !== 'right')) throw new Error('Bad position');
    const { positions } = await loadSettings();
    positions[msg.site] = { edge: p.edge, y: clamp(Number(p.y) || 0, 0, 1) };
    await saveSettings({ positions });
    return { ok: true };
  },

  'renard:savePrefs': async (msg) => {
    // Content scripts may only change the "Read chat" toggle.
    const { prefs } = await loadSettings();
    if (typeof msg.prefs?.readChat === 'boolean') prefs.readChat = msg.prefs.readChat;
    await saveSettings({ prefs });
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

  'renard:openOptions': async () => {
    await ext.runtime.openOptionsPage();
    return { ok: true };
  },

  // Built-in model, from the settings page.
  'renard:localRemove': async (msg) => {
    if (!R.LOCAL_MODELS[msg.key]) throw new Error('Unknown model');
    await engineRequest({ type: 'remove', key: msg.key });
    const { localModel } = await loadSettings();
    delete localModel.ready[msg.key];
    await saveSettings({ localModel });
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// Built-in model engine. Firefox's background page runs it directly (it has a
// DOM and WebGPU); Chrome's service worker hosts it in an offscreen document
// and talks to it over a port.

const ENGINE_IN_PAGE = typeof document !== 'undefined';
let creatingOffscreen = null;

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
  return new Promise((resolve, reject) => {
    const port = ext.runtime.connect({ name: 'renard:engine' });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      port.disconnect();
      fn(value);
    };
    port.onMessage.addListener((m) => {
      if (m.type === 'result') finish(resolve, m.result);
      else if (m.type === 'error') finish(reject, new ProviderError(m.kind || 'unknown', m.message));
      else onEvent(m);
    });
    port.onDisconnect.addListener(() => finish(reject, new ProviderError('network', 'The built-in model stopped unexpectedly.')));
    if (signal) {
      if (signal.aborted) finish(reject, new ProviderError('aborted', 'Request cancelled'));
      signal.addEventListener('abort', () => finish(reject, new ProviderError('aborted', 'Request cancelled')));
    }
    port.postMessage(msg);
  });
}

async function answerLocally(s, msg, post, signal) {
  const model = R.LOCAL_MODELS[s.localModel.key] || R.LOCAL_MODELS['gemma-3-1b'];
  if (!s.localModel.ready[model.id]) throw new ProviderError('localMissing', `Download ${model.name} in settings first.`);
  let chat = null;
  if (msg.chat && Array.isArray(msg.chat.turns)) {
    chat = { ...trimChat(msg.chat.turns, { chatChars: R.LIMITS.localChatChars, turnChars: R.LIMITS.localTurnChars }), siteName: msg.chat.siteName };
    post({ type: 'context', included: chat.turns.length, total: chat.total, partial: chat.partial });
  }
  const question = String(msg.question || '').slice(0, 20000);
  await engineRequest(
    { type: 'generate', key: model.id, system: SYSTEM_PROMPT, user: buildUserMessage(question, chat), maxNewTokens: 1024 },
    {
      signal,
      onEvent: (e) => {
        if (e.type === 'delta') post({ type: 'delta', text: e.text });
        else if (e.type === 'loading') post({ type: 'loading' });
      },
    },
  );
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== ext.runtime.id) return false;
  const handler = msg && handlers[msg.type];
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
  const provider = R.PROVIDERS[s.provider] || R.PROVIDERS.anthropic;
  if (provider.id === 'local') return answerLocally(s, msg, post, signal);
  const apiKey = s.apiKeys[provider.id];
  if (!apiKey) throw new ProviderError('keyMissing', 'No API key set');
  if (!(await hasOrigins(provider.origins))) {
    throw new ProviderError('permission', `Renard does not have access to ${provider.origins[0]}`);
  }

  let model = s.models[provider.id];
  if (!model) {
    const list = await listModels(provider.id, apiKey, { signal });
    if (!list.length) throw new ProviderError('modelUnavailable', 'No models are available for this key.');
    model = list[0];
    await saveSettings({ models: { ...s.models, [provider.id]: model } });
  }

  let chat = null;
  if (msg.chat && Array.isArray(msg.chat.turns)) {
    chat = { ...trimChat(msg.chat.turns), siteName: msg.chat.siteName };
    post({ type: 'context', included: chat.turns.length, total: chat.total, partial: chat.partial });
  }

  const question = String(msg.question || '').slice(0, 20000);
  await streamAnswer(provider.id, {
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    user: buildUserMessage(question, chat),
    signal,
    onDelta: (text) => post({ type: 'delta', text }),
  });
}

// Settings page: downloads (and loads) a built-in model, reporting progress.
// The page pings over the port, which keeps Firefox's background page awake
// through a long download.
ext.runtime.onConnect.addListener((port) => {
  if (port.name !== 'renard:local' || port.sender?.id !== ext.runtime.id) return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'prepare' || !R.LOCAL_MODELS[msg.key]) return;
    const model = R.LOCAL_MODELS[msg.key];
    try {
      const result = await engineRequest({ type: 'prepare', key: model.id }, { signal: controller.signal, onEvent: (e) => port.postMessage(e) });
      const { localModel } = await loadSettings();
      localModel.ready[model.id] = { dtype: result.dtype, bytes: result.bytes || model.sizes[result.dtype] || 0, at: Date.now() };
      await saveSettings({ localModel });
      port.postMessage({ type: 'ready', ...localModel.ready[model.id] });
    } catch (err) {
      if (err.kind !== 'aborted') port.postMessage({ type: 'error', kind: err.kind || 'unknown', message: String((err && err.message) || err) });
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

async function broadcastRefresh() {
  const urls = Object.values(R.SITES).flatMap((s) => s.origins);
  let tabs = [];
  try {
    tabs = await ext.tabs.query({ url: urls });
  } catch {
    return;
  }
  for (const tab of tabs) {
    ext.tabs.sendMessage(tab.id, { type: 'renard:refresh' }).catch(() => {});
  }
}

async function updateBadge() {
  const s = await loadSettings();
  const ok = await hasOrigins(requiredOrigins(s));
  const action = ext.action;
  await action.setBadgeText({ text: ok ? '' : '!' });
  if (!ok) await action.setBadgeBackgroundColor({ color: '#d67941' });
  await action.setTitle({ title: ok ? 'Renard settings' : 'Renard needs site access. Click to open settings.' });
}

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['provider', 'apiKeys', 'models', 'sites', 'prefs', 'localModel'].some((k) => k in changes)) {
    broadcastRefresh();
    updateBadge().catch(() => {});
  }
});

ext.permissions.onAdded.addListener(() => {
  updateBadge().catch(() => {});
  broadcastRefresh();
});
ext.permissions.onRemoved.addListener(() => {
  updateBadge().catch(() => {});
  broadcastRefresh();
});

ext.action.onClicked.addListener(() => {
  ext.runtime.openOptionsPage();
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
  if (details.reason !== 'install') return;
  // First run only: open settings when no key is saved yet, so reinstalling
  // during development doesn't open another settings tab each time.
  const s = await loadSettings();
  if (!Object.values(s.apiKeys).some(Boolean)) ext.runtime.openOptionsPage();
});

updateBadge().catch(() => {});
