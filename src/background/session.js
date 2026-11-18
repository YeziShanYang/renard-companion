// Records per tab, kept in session storage: content scripts can't read it,
// and it survives the background script being suspended. Each bubble's
// channel key is kept here, and which site's fox is out in each tab.
import { ext } from '../shared/settings.js';

export const HEX = /^[0-9a-f]{16,64}$/;

// Bubble channel keys, by "tabId:instance". Without session storage (an
// older browser) they're kept in memory.
export const bubbleKeys = {
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

// Whether a fox mounting in this tab finds one already out there for the
// same site (key), on the page before: it comes back in place then, instead
// of running in again. out: the fox shows on this page at all. Sending it
// home or turning the site off forgets it.
export async function foxReturning(tabId, key, { out, mount }) {
  if (tabId == null || !ext.storage.session) return false;
  const name = `fox:${tabId}`;
  if (!out) {
    await ext.storage.session.remove(name);
    return false;
  }
  if (!mount) return false;
  const returning = (await ext.storage.session.get(name))[name] === key;
  await ext.storage.session.set({ [name]: key });
  return returning;
}

// A closed tab's keys and fox are no longer needed.
export async function forgetTab(tabId) {
  if (!ext.storage.session) return;
  const all = await ext.storage.session.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith(`bubble:${tabId}:`) || k === `fox:${tabId}`);
  if (stale.length) await ext.storage.session.remove(stale);
}
