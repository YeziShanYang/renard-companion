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
  const model = s.models[provider.id];
  return {
    site: siteId,
    enabled: s.sites[siteId] !== false,
    provider: provider.id,
    providerName: provider.name,
    hasKey: Boolean(s.apiKeys[provider.id]),
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
};

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
  if (['provider', 'apiKeys', 'models', 'sites', 'prefs'].some((k) => k in changes)) {
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
