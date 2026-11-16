// The built-in model: Gemma running on this computer's GPU through
// Transformers.js and WebGPU. Loaded directly by Firefox's background page,
// and by the offscreen document in Chrome (engine/host.js), whose service
// worker cannot use the GPU for this.
//
// Model files are fetched from Hugging Face the first time and kept in the
// extension's Cache Storage; after that everything runs offline.
import '../shared/constants.js';
import {
  env,
  pipeline,
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  TextStreamer,
  InterruptableStoppingCriteria,
} from '../vendor/transformers/transformers.min.js';
import { CACHE_NAME, hubSettings, hasModelFiles } from './hub.js';

const R = globalThis.Renard;
const ext = globalThis.browser ?? globalThis.chrome;
const IS_FIREFOX = typeof ext.runtime.getBrowserInfo === 'function';

const UNLOAD_AFTER_MS = 10 * 60 * 1000;

env.allowLocalModels = false;
env.useBrowserCache = true;
// The WebAssembly runtime ships inside the extension (never from a CDN).
env.backends.onnx.wasm.wasmPaths = ext.runtime.getURL('vendor/transformers/');

class EngineError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

let current = null; // { key, dtype, run, dispose }
let unloadTimer = 0;
let active = null; // stopper of the generation in progress

// Everything that loads, uses or frees a model runs one at a time, in
// arrival order: a second tab's question waits for the first answer, and a
// download, delete or idle unload waits for an answer in progress (and the
// other way round), so none of them can cut another off or load twice.
let turn = Promise.resolve();
function serial(fn) {
  const run = turn.then(fn, fn);
  turn = run.catch(() => {});
  return run;
}

export async function gpuStatus() {
  if (!globalThis.navigator || !navigator.gpu) return { ok: false, reason: 'This browser has no WebGPU here.' };
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch {
    // treated as unavailable
  }
  if (!adapter) return { ok: false, reason: 'The browser cannot use a graphics card on this computer.' };
  const f16 = adapter.features.has('shader-f16');
  return { ok: true, f16, dtype: R.localDtype(IS_FIREFOX, f16) };
}

// Sums download progress across all of a model's files.
function progressReporter(model, dtype, emit) {
  const files = new Map();
  let last = 0;
  const expected = model.sizes[dtype] || 0;
  return (p) => {
    if (!p || !p.file) return;
    if (p.status === 'progress' || p.status === 'download') {
      files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
    } else if (p.status === 'done') {
      const f = files.get(p.file);
      if (f) f.loaded = f.total;
    } else {
      return;
    }
    const now = Date.now();
    if (now - last < 200 && p.status !== 'done') return;
    last = now;
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    // Whoever asked may have gone (settings closed); the download goes on.
    try {
      emit({ type: 'progress', loaded, total: Math.max(total, expected) });
    } catch {
      // listener gone
    }
  };
}

// Loads a model (always inside serial()). With cacheOnly, files come only
// from what was downloaded: an answer never starts a download of its own.
async function load(key, emit, { cacheOnly = false } = {}) {
  clearTimeout(unloadTimer);
  if (current && current.key === key) return current;
  const model = R.own(R.LOCAL_MODELS, key);
  if (!model) throw new EngineError('modelUnavailable', `Unknown built-in model: ${key}`);
  await unload();
  const gpu = await gpuStatus();
  if (!gpu.ok) throw new EngineError('noGpu', gpu.reason);
  const missing = new EngineError('localMissing', `Download ${model.name} in settings first.`);
  if (cacheOnly) {
    const { keys } = await cachedEntries(model, { current: true });
    if (!hasModelFiles(keys.map((req) => req.url), model, gpu.dtype)) throw missing;
  }
  const settings = hubSettings(model, { cacheOnly });
  const before = Object.fromEntries(Object.keys(settings).map((k) => [k, env[k]]));
  Object.assign(env, settings);
  try {
    // Loading from the cache reports no progress; nobody shows it.
    return await loadModel(key, model, gpu.dtype, cacheOnly ? null : progressReporter(model, gpu.dtype, emit));
  } catch (err) {
    if (err instanceof EngineError || !cacheOnly) throw err;
    // Only a file missing from the cache means the download is gone. Any
    // other failure (the GPU, say) is reported as itself.
    if (err && err.name === 'ModelFileNotFoundError') throw missing;
    throw new EngineError('unknown', `Couldn't start ${model.name}: ${(err && err.message) || err}`);
  } finally {
    Object.assign(env, before);
  }
}

async function loadModel(key, model, dtype, progress_callback) {
  const revision = model.revision;
  let run;
  let dispose;

  if (model.kind === 'gemma4') {
    // Gemma 4 is multimodal; Renard sends text only.
    const processor = await AutoProcessor.from_pretrained(model.repo, { revision, progress_callback });
    const lm = await Gemma4ForConditionalGeneration.from_pretrained(model.repo, { revision, dtype, device: 'webgpu', progress_callback });
    run = async ({ system, user, maxNewTokens, onDelta, stopper }) => {
      const messages = [
        { role: 'system', content: [{ type: 'text', text: system }] },
        { role: 'user', content: [{ type: 'text', text: user }] },
      ];
      const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true, enable_thinking: false });
      const inputs = await processor(prompt);
      const streamer = new TextStreamer(processor.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: onDelta });
      await lm.generate({ ...inputs, max_new_tokens: maxNewTokens, streamer, stopping_criteria: stopper });
    };
    dispose = () => lm.dispose();
  } else {
    const generator = await pipeline('text-generation', model.repo, { revision, dtype, device: 'webgpu', progress_callback });
    run = async ({ system, user, maxNewTokens, onDelta, stopper }) => {
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      const streamer = new TextStreamer(generator.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: onDelta });
      await generator(messages, { max_new_tokens: maxNewTokens, streamer, stopping_criteria: stopper });
    };
    dispose = () => generator.dispose();
  }
  current = { key, dtype, run, dispose };
  return current;
}

export async function unload() {
  clearTimeout(unloadTimer);
  if (active) active.interrupt();
  const c = current;
  current = null;
  if (c) {
    try {
      await c.dispose();
    } catch {
      // already released
    }
  }
}

function scheduleUnload() {
  clearTimeout(unloadTimer);
  unloadTimer = setTimeout(() => serial(unload), UNLOAD_AFTER_MS);
}

// Cached files for a model: their URLs contain the repository path and, for
// the pinned download, /resolve/<revision>/.
async function cachedEntries(model, { current = false } = {}) {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const mark = current ? `/${model.repo}/resolve/${model.revision}/` : `/${model.repo}/`;
  return { cache, keys: keys.filter((req) => req.url.includes(mark)) };
}

// Deletes files from other revisions (an older download) once the pinned
// one is in place.
async function pruneOtherRevisions(model) {
  const { cache, keys } = await cachedEntries(model);
  const mark = `/resolve/${model.revision}/`;
  for (const req of keys) if (!req.url.includes(mark)) await cache.delete(req);
}

async function cachedBytes(model) {
  const { cache, keys } = await cachedEntries(model, { current: true });
  let bytes = 0;
  for (const req of keys) {
    const res = await cache.match(req);
    bytes += Number(res && res.headers.get('content-length')) || 0;
  }
  return bytes;
}

// Answers one question (inside serial()), loading the model from the cache
// first if needed.
async function generate(msg, emit, signal) {
  const c = await load(msg.key, emit, { cacheOnly: true });
  if (signal && signal.aborted) return { stopped: true };
  emit({ type: 'thinking' });
  const stopper = new InterruptableStoppingCriteria();
  active = stopper;
  const onAbort = () => stopper.interrupt();
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    await c.run({
      system: String(msg.system || '').slice(0, 4000),
      user: String(msg.user || '').slice(0, 200000),
      maxNewTokens: Math.min(2048, Math.max(1, Math.round(Number(msg.maxNewTokens) || 1024))),
      stopper,
      onDelta: (text) => {
        if (text) emit({ type: 'delta', text });
      },
    });
  } catch (err) {
    // A failed run (WebGPU failing to map a buffer, or losing the device)
    // leaves ONNX Runtime's GPU device unusable for the rest of this page,
    // so every later question would fail too. The page hosting the engine
    // (Firefox's background page, Chrome's offscreen document) reloads
    // once this error has been sent, and the next question starts on a
    // fresh device.
    await unload();
    setTimeout(() => location.reload(), 1000);
    const name = (R.own(R.LOCAL_MODELS, msg.key) || {}).name || 'The built-in model';
    throw new EngineError('unknown', `${name} ran into a GPU error and is restarting. Ask again in a moment, or try a shorter question or Read page off.`);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (active === stopper) active = null;
  }
  return { stopped: Boolean(signal && signal.aborted) };
}

// Requests from the background script. emit() sends progress and text;
// the returned value is the final result.
export async function handle(type, msg, emit, signal) {
  switch (type) {
    case 'status':
      return gpuStatus();

    case 'prepare':
      return serial(async () => {
        const c = await load(msg.key, emit);
        scheduleUnload();
        const model = R.LOCAL_MODELS[c.key];
        await pruneOtherRevisions(model).catch(() => {});
        return { dtype: c.dtype, bytes: await cachedBytes(model) };
      });

    case 'generate':
      emit({ type: 'loading' });
      return serial(async () => {
        if (signal && signal.aborted) return { stopped: true };
        try {
          return await generate(msg, emit, signal);
        } finally {
          // A loaded model always goes back on its idle timer, also when the
          // page that asked closed while the model was loading.
          if (current) scheduleUnload();
        }
      });

    case 'remove':
      return serial(async () => {
        const model = R.own(R.LOCAL_MODELS, msg.key);
        if (!model) throw new EngineError('modelUnavailable', 'Unknown built-in model');
        if (current && current.key === msg.key) await unload();
        const { cache, keys } = await cachedEntries(model);
        for (const req of keys) await cache.delete(req);
        return { removed: keys.length };
      });

    case 'unload':
      return serial(async () => {
        await unload();
        return { ok: true };
      });

    default:
      throw new EngineError('unknown', `Unknown engine request: ${type}`);
  }
}
