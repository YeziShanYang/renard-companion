// One-off messages to the background script. Each entry says who may send
// it (from) and what it does (run). A message from anyone else is refused
// with "Not allowed" before it runs.
import '../shared/constants.js';
import { ext, loadSettings, saveSettings, hasOrigins } from '../shared/settings.js';
import { fromPage, fromSettings, fromPopupOrSettings, fromBubbleFrame, fromOffscreen, siteFor } from './senders.js';
import { loadAssets } from './assets.js';
import { publicState } from './page-state.js';
import { HEX, bubbleKeys } from './session.js';
import { captureRegion } from './capture.js';
import { onEngineIdle } from './engine-client.js';
import { removeLocal, checkLocal } from './local-models.js';
import { addSite, removeSite, setAllSites, skipSite } from './sites.js';
import { update } from './store.js';

const R = globalThis.Renard;

const anyone = () => true;

// Settings the settings page may change one entry of (renard:setEntry).
const ENTRY_SETTINGS = new Set(['sites', 'prefs', 'apiKeys', 'models', 'localModel']);
const RESERVED = ['__proto__', 'constructor', 'prototype'];

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function notAllowed() {
  throw new Error('Not allowed');
}

const handlers = {
  // ---- from content scripts (any page, checked by its address) ----

  'renard:getState': {
    from: anyone,
    run: (msg, sender) => publicState(siteFor(msg, sender), { tabId: sender.tab && sender.tab.id, mount: msg.mount === true }),
  },

  'renard:getAssets': { from: anyone, run: () => loadAssets() },

  'renard:savePosition': {
    from: anyone,
    run: async (msg, sender) => {
      const site = siteFor(msg, sender);
      const p = msg.position || {};
      if (p.edge !== 'left' && p.edge !== 'right') throw new Error('Bad position');
      await update('positions', (positions) => ({ ...positions, [site.key || site.id]: { edge: p.edge, y: clamp(Number(p.y) || 0, 0, 1) } }));
      return { ok: true };
    },
  },

  // A page may only change the "Read chat" switch.
  'renard:savePrefs': {
    from: anyone,
    run: async (msg) => {
      if (typeof msg.prefs?.readChat === 'boolean') await update('prefs', (prefs) => ({ ...prefs, readChat: msg.prefs.readChat }));
      return { ok: true };
    },
  },

  'renard:saveBubble': {
    from: anyone,
    run: async (msg) => {
      const b = msg.bubble || {};
      const bubble = {
        width: clamp(Math.round(Number(b.width) || 520), 280, 4000),
        height: clamp(Math.round(Number(b.height) || 0), 0, 4000),
        expanded: Boolean(b.expanded),
      };
      await saveSettings({ bubble });
      return { ok: true };
    },
  },

  'renard:openOptions': {
    from: anyone,
    run: async () => {
      await ext.runtime.openOptionsPage();
      return { ok: true };
    },
  },

  // Whether screenshots are allowed (access to all websites), asked before
  // the bubble shows the picker.
  'renard:captureAccess': { from: fromPage, run: async () => ({ granted: await hasOrigins(['<all_urls>']) }) },

  // A region of the visible tab, to attach to a question.
  'renard:capture': {
    from: fromPage,
    run: (msg, sender) => {
      siteFor(msg, sender);
      return captureRegion(sender.tab, msg.rect, msg.viewport);
    },
  },

  // ---- the bubble's channel key ----
  // The content script registers it, and the frame (Renard's own page, in
  // the same tab) collects it each time it loads. The key lasts as long as
  // the bubble; it is dropped on unmount or tab close.

  'renard:bubbleKey': {
    from: fromPage,
    run: async (msg, sender) => {
      if (!HEX.test(msg.instance) || !HEX.test(msg.key)) notAllowed();
      await bubbleKeys.set(`${sender.tab.id}:${msg.instance}`, msg.key);
      return { ok: true };
    },
  },

  'renard:frameKey': {
    from: fromBubbleFrame,
    run: async (msg, sender) => {
      if (!HEX.test(msg.instance)) notAllowed();
      const key = await bubbleKeys.get(`${sender.tab.id}:${msg.instance}`);
      if (!key) throw new Error('No key for this bubble');
      return { key };
    },
  },

  'renard:bubbleKeyDrop': {
    from: fromPage,
    run: async (msg, sender) => {
      if (!HEX.test(msg.instance)) notAllowed();
      await bubbleKeys.drop(`${sender.tab.id}:${msg.instance}`);
      return { ok: true };
    },
  },

  // ---- from the toolbar popup or settings, never from a page ----

  'renard:addSite': { from: fromPopupOrSettings, run: (msg) => addSite(msg.host) },

  'renard:removeSite': { from: fromPopupOrSettings, run: (msg) => removeSite(msg.host) },

  // claude.ai or ChatGPT switched on or off.
  'renard:setSite': {
    from: fromPopupOrSettings,
    run: async (msg) => {
      if (!R.own(R.SITES, msg.id)) notAllowed();
      await update('sites', (sites) => ({ ...sites, [msg.id]: Boolean(msg.on) }));
      return { ok: true };
    },
  },

  // A website turned off (or back on) while Renard is on every website.
  'renard:skipSite': {
    from: fromPopupOrSettings,
    run: (msg) => {
      if (!R.isWebHost(msg.host)) notAllowed();
      return skipSite(msg.host, msg.skip === true);
    },
  },

  // ---- from the settings page only ----

  // One entry of a nested setting, applied on top of the stored value in
  // the same queue as every other write.
  'renard:setEntry': {
    from: fromSettings,
    run: async (msg) => {
      if (!ENTRY_SETTINGS.has(msg.key) || typeof msg.entry !== 'string' || RESERVED.includes(msg.entry)) notAllowed();
      await update(msg.key, (value) => ({ ...value, [msg.entry]: msg.value }));
      return { ok: true };
    },
  },

  // Every website on or off. Settings asks the browser for access to all
  // secure websites first.
  'renard:setAllSites': { from: fromSettings, run: (msg) => setAllSites(msg.on === true) },

  // The API keys (see settings.js).
  'renard:apiKeys': { from: fromSettings, run: async () => (await loadSettings(['apiKeys'])).apiKeys },

  'renard:localRemove': { from: fromSettings, run: (msg) => removeLocal(msg.key) },

  'renard:localCheck': { from: fromSettings, run: (msg) => checkLocal(msg.key, msg.dtype) },

  // ---- from Chrome's offscreen document ----

  'renard:engineIdle': {
    from: fromOffscreen,
    run: async () => {
      await onEngineIdle();
      return { ok: true };
    },
  },
};

// runtime.onMessage listener. Answers { ok: true, result } or
// { ok: false, error } for Renard's own messages, and leaves others alone.
export function handleMessage(msg, sender, sendResponse) {
  if (sender.id !== ext.runtime.id) return false;
  const handler = msg && R.own(handlers, msg.type);
  if (!handler) return false;
  Promise.resolve()
    .then(() => {
      if (!handler.from(sender)) notAllowed();
      return handler.run(msg, sender);
    })
    .then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
    );
  return true; // keep the channel open for the async response
}
