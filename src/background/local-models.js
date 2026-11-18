// Downloads of the built-in models, and the record of which are ready.
import '../shared/constants.js';
import { CACHE_NAME, hasModelFiles } from '../engine/hub.js';
import { engineRequest } from './engine-client.js';
import { update } from './store.js';

const R = globalThis.Renard;

// Drops a built-in model's download record, so it no longer counts as ready.
export function forgetLocal(key) {
  return update('localModel', (localModel) => {
    if (!R.own(localModel.ready, key)) return undefined;
    const ready = { ...localModel.ready };
    delete ready[key];
    return { ...localModel, ready };
  });
}

export async function removeLocal(key) {
  if (!R.own(R.LOCAL_MODELS, key)) throw new Error('Unknown model');
  await engineRequest({ type: 'remove', key });
  await forgetLocal(key);
  return { ok: true };
}

// Whether a downloaded model is still whole in the cache, in the dtype this
// GPU loads, so settings says "ready" only for a model that can load.
// Browser data can be cleared, and another GPU may need other weights. A
// download that is gone is forgotten, and settings and the fox offer it
// again.
export async function checkLocal(key, dtype) {
  const model = R.own(R.LOCAL_MODELS, key);
  if (!model || !R.own(model.sizes, dtype)) throw new Error('Unknown model');
  const cache = await caches.open(CACHE_NAME);
  const ready = hasModelFiles((await cache.keys()).map((req) => req.url), model, dtype);
  if (!ready) await forgetLocal(model.id);
  return { ready };
}

// The settings page's download port: downloads (and loads) a built-in
// model, reporting progress. The page pings over the port, which keeps
// Firefox's background page awake through a long download.
//
// A download can't be cancelled midway, so it isn't tied to the page: if
// settings closes, it carries on and is recorded as ready when it finishes,
// unless the browser suspends the idle background first (then Download
// again reuses the files already fetched). Messages to a page that has gone
// are dropped.
export function serveDownloads(port) {
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
  });
  const post = (m) => {
    if (!open) return;
    try {
      port.postMessage(m);
    } catch {
      open = false;
    }
  };
  port.onMessage.addListener(async (msg) => {
    const model = msg && msg.type === 'prepare' && R.own(R.LOCAL_MODELS, msg.key);
    if (!model) return;
    try {
      const result = await engineRequest({ type: 'prepare', key: model.id }, { onEvent: post });
      const record = {
        dtype: result.dtype,
        bytes: result.bytes || model.sizes[result.dtype] || 0,
        revision: model.revision,
        at: Date.now(),
      };
      await update('localModel', (localModel) => ({ ...localModel, ready: { ...localModel.ready, [model.id]: record } }));
      post({ type: 'ready', ...record });
    } catch (err) {
      if (err.kind !== 'aborted') post({ type: 'error', kind: err.kind || 'unknown', message: String((err && err.message) || err) });
    }
  });
}
