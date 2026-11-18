// Requests to the built-in model engine (engine/engine.js). Firefox's
// background page runs it directly (it has a DOM and WebGPU); Chrome's
// service worker hosts it in an offscreen document and talks to it over a
// port per request.
import { ext } from '../shared/settings.js';
import { ProviderError } from '../shared/providers.js';

const ENGINE_IN_PAGE = typeof document !== 'undefined';
const OFFSCREEN_PATH = 'engine/offscreen.html';
const PORT_PREFIX = 'renard:engine:';

let creatingOffscreen = null;
const engineCalls = new Map(); // request id -> receives the request's port

// Engine requests in progress in Chrome, counted from before the offscreen
// document is ensured, so an idle report never closes it under a new one.
// The engine reports idle just before it sends a request's result, so a
// report that arrives while busy is kept until the last request ends.
let engineBusy = 0;
let engineIdle = false;

async function ensureOffscreen() {
  const url = ext.runtime.getURL(OFFSCREEN_PATH);
  const existing = await ext.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  creatingOffscreen =
    creatingOffscreen ||
    ext.offscreen
      .createDocument({ url: OFFSCREEN_PATH, reasons: ['WORKERS'], justification: 'Runs the built-in Gemma model on the GPU.' })
      .finally(() => {
        creatingOffscreen = null;
      });
  await creatingOffscreen;
}

function closeOffscreen() {
  engineIdle = false;
  if (ext.offscreen) return ext.offscreen.closeDocument().catch(() => {});
  return undefined;
}

// Chrome's offscreen document has no model loaded and nothing to do.
// Closing it frees the memory WebGPU and ONNX Runtime keep after a model is
// disposed (gigabytes after a long prompt). The next request opens it again.
export async function onEngineIdle() {
  if (engineBusy) engineIdle = true;
  else await closeOffscreen();
}

// An engine failure as a ProviderError, keeping the token counts of a
// prompt that was too long.
function engineError(e) {
  const err = new ProviderError(e.kind || 'unknown', String(e.message || e));
  if (Number.isFinite(e.tokens)) err.tokens = e.tokens;
  if (Number.isFinite(e.limit)) err.limit = e.limit;
  return err;
}

// Sends one request to the engine. onEvent receives progress and text;
// aborting the signal cancels the request.
export async function engineRequest(msg, opts = {}) {
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

export function isEnginePort(port) {
  return port.name.startsWith(PORT_PREFIX);
}

// A port the offscreen document opened for one engine request (the caller
// has checked it's from this extension).
export function acceptEnginePort(port) {
  if (port.sender.url !== ext.runtime.getURL(OFFSCREEN_PATH)) return;
  const start = engineCalls.get(port.name.slice(PORT_PREFIX.length));
  if (start) start(port);
  else port.disconnect(); // a request that was cancelled meanwhile
}
