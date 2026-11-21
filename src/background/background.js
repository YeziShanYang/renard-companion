// Background script: the only extension context (besides the options page)
// that reads API keys. Content scripts reach it through messages and a
// streaming port, and only ever receive non-secret state.
//
// This file connects the browser's events to the modules that handle them:
//   messages.js       one-off messages from pages, the popup and settings
//   ask.js            the port each question streams its answer over
//   local-models.js   built-in model downloads (settings) and records
//   engine-client.js  requests to the built-in model's engine
//   sites.js          added sites and Every website: script registration
//                     and injection into open tabs
//   badge.js          the toolbar badge for missing access
//   session.js        per-tab records (bubble keys, which fox is out)
import '../shared/constants.js';
import { ext, loadSettings, changedSettings, moveKeysHere } from '../shared/settings.js';
import { handleMessage } from './messages.js';
import { serveAsk } from './ask.js';
import { serveDownloads } from './local-models.js';
import { isEnginePort, acceptEnginePort } from './engine-client.js';
import { accessGranted, pruneSites, startOnce, syncSiteScripts } from './sites.js';
import { updateBadge } from './badge.js';
import { forgetTab } from './session.js';
import { fromSettings } from './senders.js';

// This script moves API keys out of storage.local when it finds them there
// (see settings.js).
moveKeysHere();

// Settings whose change open tabs need to hear about (and that can change
// what access Renard needs), and those that change where it runs.
const PAGE_SETTINGS = ['spawned', 'provider', 'apiKeys', 'models', 'sites', 'otherSites', 'allSites', 'skippedSites', 'prefs', 'localModel'];
const SITE_SETTINGS = ['otherSites', 'allSites', 'skippedSites'];

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

// ---- events ---------------------------------------------------------------------

ext.runtime.onMessage.addListener(handleMessage);

ext.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== ext.runtime.id) return;
  if (isEnginePort(port)) acceptEnginePort(port);
  else if (port.name === 'renard:ask') serveAsk(port);
  else if (port.name === 'renard:local' && fromSettings(port.sender)) serveDownloads(port);
});

ext.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const changed = changedSettings(changes);
  if (PAGE_SETTINGS.some((k) => changed.includes(k))) {
    broadcastRefresh();
    updateBadge().catch(() => {});
  }
  if (SITE_SETTINGS.some((k) => changed.includes(k))) syncSiteScripts();
});

// Access granted or taken back, from settings, the popup, or the browser's
// own extension settings.
ext.permissions.onAdded.addListener((permissions) => {
  updateBadge().catch(() => {});
  broadcastRefresh();
  accessGranted(permissions).catch(() => {});
});

ext.permissions.onRemoved.addListener((permissions) => {
  updateBadge().catch(() => {});
  broadcastRefresh();
  pruneSites(permissions).catch(() => {});
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

// ---- startup --------------------------------------------------------------------

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
