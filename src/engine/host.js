// Chrome: hosts the built-in model in an offscreen document, since the
// extension's service worker can't keep a GPU model loaded. For each request
// the service worker sends a message, and this document opens a port back to
// it for the request; disconnecting cancels it.
//
// This document has no runtime.onConnect listener on purpose. Chrome hands
// each port opened in the extension to every document that listens, and a
// port held here would keep a page's question or a settings download
// connected after the service worker stopped, so the page would never hear
// that its answer was lost.
import { handle, onIdle } from './engine.js';

const ext = globalThis.browser ?? globalThis.chrome;

// With nothing loaded and nothing to do, the service worker closes this
// document to free its memory.
onIdle(() => ext.runtime.sendMessage({ type: 'renard:engineIdle' }).catch(() => {}));

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only the background service worker: content scripts and the settings tab
  // have a sender tab.
  if (!msg || msg.type !== 'renard:engineCall' || typeof msg.id !== 'string' || sender.id !== ext.runtime.id || sender.tab) return false;
  const port = ext.runtime.connect({ name: `renard:engine:${msg.id}` });
  const controller = new AbortController();
  let open = true;
  const post = (m) => {
    if (open) port.postMessage(m);
  };
  port.onDisconnect.addListener(() => {
    open = false;
    controller.abort();
  });
  port.onMessage.addListener((req) => {
    if (!req || !req.type) return;
    handle(req.type, req, post, controller.signal).then(
      (result) => post({ type: 'result', result }),
      (err) => post({ type: 'error', kind: err.kind || 'unknown', message: String((err && err.message) || err), tokens: err.tokens, limit: err.limit }),
    );
  });
  sendResponse({ ok: true });
  return false;
});
