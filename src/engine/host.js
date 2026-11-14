// Chrome: hosts the built-in model in an offscreen document, since the
// extension's service worker can't keep a GPU model loaded. The service
// worker connects with a port per request; disconnecting cancels it.
import { handle } from './engine.js';

const ext = globalThis.browser ?? globalThis.chrome;

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== 'renard:engine') return;
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
    if (!msg || !msg.type) return;
    handle(msg.type, msg, post, controller.signal).then(
      (result) => post({ type: 'result', result }),
      (err) => post({ type: 'error', kind: err.kind || 'unknown', message: String((err && err.message) || err) }),
    );
  });
});
