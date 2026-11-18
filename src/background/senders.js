// Who sent a message or opened a port. Content scripts report the page's
// address as sender.url, and extension pages their own.
import '../shared/constants.js';
import { ext } from '../shared/settings.js';

const R = globalThis.Renard;

export function fromExtensionPage(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(ext.runtime.getURL(''));
}

// A content script on a web page in a tab.
export function fromPage(sender) {
  return !fromExtensionPage(sender) && Boolean(sender.tab);
}

export function fromSettings(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(ext.runtime.getURL('options/'));
}

// The toolbar popup or the settings page. The bubble frame is an extension
// page too, but any website can embed it, so it can do only what a content
// script can.
export function fromPopupOrSettings(sender) {
  return fromSettings(sender) || (typeof sender.url === 'string' && sender.url.startsWith(ext.runtime.getURL('popup/')));
}

// Renard's bubble frame, in a tab.
export function fromBubbleFrame(sender) {
  return (sender.url || '').startsWith(ext.runtime.getURL('bubble/bubble.html')) && Boolean(sender.tab);
}

// Chrome's offscreen document, which runs the built-in model.
export function fromOffscreen(sender) {
  return sender.url === ext.runtime.getURL('engine/offscreen.html') && !sender.tab;
}

// The site a content-script message comes from. The sender's own address
// decides it: an added website is known by that address, and claude.ai or
// ChatGPT only from a page on that site.
export function siteFor(msg, sender) {
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
