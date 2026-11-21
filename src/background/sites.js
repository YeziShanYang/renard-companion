// Where Renard runs besides claude.ai and ChatGPT (which have the manifest's
// content script): websites added one at a time, or every https website.
// Each gets the same content scripts, registered for its hosts and injected
// into tabs already open. Registrations are rebuilt at startup because
// Firefox drops them when the extension updates.
import '../shared/constants.js';
import { ext, loadSettings, hasOrigins, siteIsOn } from '../shared/settings.js';
import { update } from './store.js';

const R = globalThis.Renard;

const SITE_SCRIPTS = 'renard-other-sites';

// Every website off: Firefox gets the access to all websites back. Chrome
// would take removing it as withholding every https site inside it,
// claude.ai, ChatGPT, the AI providers' APIs and each added site included,
// so there the access stays until the user removes it and the setting alone
// decides.
const GIVES_BACK_ALL_WEB = typeof ext.runtime.getBrowserInfo === 'function';

// ---- the content script --------------------------------------------------------

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
//
// tab: a tabs.query() result. A discarded tab (unloaded to save memory) is
// skipped: the registered scripts reach it when it loads, and Firefox can
// leave a script injected into one waiting forever. Each tab gets ten
// seconds, so one stuck tab can't hold up the rest.
async function injectRenard(tab) {
  if (tab.discarded) return;
  const target = { tabId: tab.id };
  const inject = async () => {
    const [probe] = await ext.scripting.executeScript({ target, func: () => Boolean(globalThis.Renard && globalThis.Renard.booted) });
    if (probe && probe.result === true) return;
    await ext.scripting.insertCSS({ target, files: contentScriptCss() });
    await ext.scripting.executeScript({ target, files: contentScriptFiles() });
  };
  let timer = 0;
  try {
    await Promise.race([inject(), new Promise((resolve, reject) => (timer = setTimeout(() => reject(new Error('Timed out')), 10000)))]);
  } finally {
    clearTimeout(timer);
  }
}

// Open tabs matching a match pattern (or several), or none if the query
// fails.
async function tabsMatching(url) {
  try {
    return await ext.tabs.query({ url });
  } catch {
    return null;
  }
}

// ---- which sites ----------------------------------------------------------------

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

// ---- registration -----------------------------------------------------------------

let siteScripts = Promise.resolve();

// Brings the registered content script in line with the settings. Runs one
// at a time.
export function syncSiteScripts() {
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

// ---- added sites -------------------------------------------------------------------

const adding = new Map(); // host -> promise, so the popup and onAdded don't both inject

// Adds a website the user granted access to and brings Renard to its open
// tabs right away (the registered script covers pages loaded later).
export function addSite(host) {
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
  const tabs = (await tabsMatching(R.originFor(host))) || [];
  let blocked = 0;
  for (const t of tabs) await injectRenard(t).catch(() => blocked++);
  return { tabs: tabs.length, blocked };
}

export async function removeSite(host) {
  await update('otherSites', (otherSites) => (otherSites.includes(host) ? otherSites.filter((h) => h !== host) : undefined));
  if (R.isWebHost(host)) await ext.permissions.remove({ origins: [R.originFor(host)] }).catch(() => {});
  return { removed: host };
}

// The single websites in a grant, from the popup's switch or the browser's
// own site-access controls.
function grantedWebHosts(permissions) {
  const out = [];
  for (const origin of (permissions && permissions.origins) || []) {
    const m = /^https:\/\/([^/*]+)\/\*$/.exec(origin);
    if (m && R.isWebHost(m[1])) out.push(m[1]);
  }
  return out;
}

// Access to added sites was taken back (in the browser's own settings,
// say): forget each site whose own access went and that Renard can no
// longer reach. A site reached only through access to every website stays
// listed when that access goes: Firefox stores no access of its own for a
// site added while that access covers it, and its "all websites" switch
// isn't a choice about the site. The site comes back with the access.
async function pruneOtherSites(removedOrigins) {
  await update('otherSites', async (otherSites) => {
    const keep = [];
    for (const host of otherSites) {
      const origin = R.originFor(host);
      if (R.isWebHost(host) && (!removedOrigins.includes(origin) || (await hasOrigins([origin])))) keep.push(host);
    }
    return keep.length === otherSites.length ? undefined : keep;
  });
}

// ---- Every website and skipped sites ---------------------------------------------------

// Every website on: Renard's script goes on every secure page, including
// the tabs already open. Off: it's back to the sites added one at a time.
export async function setAllSites(on) {
  if (on && !(await hasOrigins([R.ALL_WEB]))) throw new Error('Renard needs access to all websites first.');
  await update('allSites', (was) => (was === on ? undefined : on));
  await syncSiteScripts();
  if (on) await injectWebTabs();
  else if (GIVES_BACK_ALL_WEB) await ext.permissions.remove({ origins: [R.ALL_WEB] }).catch(() => {});
  return { allSites: on };
}

async function injectWebTabs() {
  const tabs = await tabsMatching(R.ALL_WEB);
  if (!tabs) return;
  const { skippedSites } = await loadSettings(['skippedSites']);
  for (const t of tabs) {
    let host = '';
    try {
      host = new URL(t.url).hostname;
    } catch {
      continue;
    }
    if (R.isWebHost(host) && !skippedSites.includes(host)) await injectRenard(t).catch(() => {});
  }
}

// A website turned off, or back on, from the toolbar popup while Renard is
// on every website. A skipped site stays off in either mode, also if it was
// added on its own, until it's turned back on or added again.
export async function skipSite(host, skip) {
  await update('skippedSites', (list) => {
    if (list.includes(host) === skip) return undefined;
    return skip ? [...list, host] : list.filter((h) => h !== host);
  });
  // Tabs opened while the site was off have no copy of Renard's script.
  if (!skip) {
    await syncSiteScripts();
    const s = await loadSettings(['sites', 'otherSites', 'allSites', 'skippedSites']);
    if (await siteIsOn(s, R.webSite(host))) await injectHost(host);
  }
  return { host, skipped: skip };
}

// ---- access granted or taken back ------------------------------------------------

// The patterns that cover every website: Every website asks for the first
// and screenshots for the second. Firefox's "all websites" switch in its
// add-on settings grants or takes back both at once.
const ALL_SITES_ORIGINS = [R.ALL_WEB, '<all_urls>'];

// Access was taken back (permissions: what went): forget added sites that
// lost their own access, and register the script for what's left. Every
// website stays on, though it only runs while Renard has access to every
// website (see everywhere), so it comes back with that access.
export function pruneSites(permissions) {
  return pruneOtherSites((permissions && permissions.origins) || []).then(() => syncSiteScripts());
}

// Access was granted, from a prompt or the browser's own extension
// settings. A single website granted means "Renard here", so it's added.
// Access to claude.ai, ChatGPT or every website brings Renard to the open
// tabs it now reaches, Every website included if it's on.
export async function accessGranted(permissions) {
  const origins = (permissions && permissions.origins) || [];
  for (const host of grantedWebHosts(permissions)) addSite(host).catch(() => {});
  const allWeb = origins.some((o) => ALL_SITES_ORIGINS.includes(o));
  const chatSite = Object.values(R.SITES).some((site) => site.origins.some((o) => origins.includes(o)));
  if (allWeb) await syncSiteScripts();
  if (allWeb || chatSite) await injectOpenTabs();
}

// ---- open tabs at startup ---------------------------------------------------------

// When Renard starts after an install, update or reload, or after being
// turned back on, tabs already open on its sites have the old copy of the
// content script (which removes its fox once it notices) or no copy at all:
// Chrome doesn't inject into open tabs, and Firefox doesn't for added
// sites. Each such tab gets the current copy (injectRenard skips a tab that
// has it). Everything is injected into each tab once (an added site is also
// an https site).
export async function injectOpenTabs() {
  const all = await everywhere();
  const matches = [...ext.runtime.getManifest().content_scripts[0].matches, ...(all ? [] : (await grantedOtherSites()).map(R.originFor))];
  const tabs = await tabsMatching(matches);
  if (!tabs) return;
  for (const t of tabs) await injectRenard(t).catch(() => {});
  if (all) await injectWebTabs();
}

// Runs injectOpenTabs once per start of Renard. Session storage is empty
// whenever Renard has just started (installed, updated, turned back on, or
// the browser opened); Chrome runs onInstalled only for the first two, and
// the service worker's own restarts keep the flag.
export async function startOnce() {
  if (!ext.storage.session) return;
  if ((await ext.storage.session.get('started')).started) return;
  await ext.storage.session.set({ started: true });
  await injectOpenTabs();
}
