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

const R = globalThis.Renard;
const ext = globalThis.browser ?? globalThis.chrome;
const IS_FIREFOX = typeof ext.runtime.getBrowserInfo === 'function';

export const CACHE_NAME = 'transformers-cache';
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
let loading = null; // { key, promise }
let unloadTimer = 0;
let active = null; // stopper of the generation in progress

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
    emit({ type: 'progress', loaded, total: Math.max(total, expected) });
  };
}

async function load(key, emit) {
  clearTimeout(unloadTimer);
  if (current && current.key === key) return current;
  if (loading && loading.key === key) return loading.promise;
  const model = R.LOCAL_MODELS[key];
  if (!model) throw new EngineError('modelUnavailable', `Unknown built-in model: ${key}`);
  await unload();

  const promise = (async () => {
    const gpu = await gpuStatus();
    if (!gpu.ok) throw new EngineError('noGpu', gpu.reason);
    const dtype = gpu.dtype;
    const progress_callback = progressReporter(model, dtype, emit);
    let run;
    let dispose;

    if (model.kind === 'gemma4') {
      // Gemma 4 is multimodal; Renard sends text only.
      const processor = await AutoProcessor.from_pretrained(model.repo, { progress_callback });
      const lm = await Gemma4ForConditionalGeneration.from_pretrained(model.repo, { dtype, device: 'webgpu', progress_callback });
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
      const generator = await pipeline('text-generation', model.repo, { dtype, device: 'webgpu', progress_callback });
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
  })();

  loading = { key, promise };
  try {
    return await promise;
  } finally {
    if (loading && loading.promise === promise) loading = null;
  }
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
  unloadTimer = setTimeout(() => unload(), UNLOAD_AFTER_MS);
}

// Cached files for a model: their URLs contain the model's repository path.
async function cachedEntries(model) {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  return { cache, keys: keys.filter((req) => req.url.includes(`/${model.repo}/`)) };
}

async function cachedBytes(model) {
  const { cache, keys } = await cachedEntries(model);
  let bytes = 0;
  for (const req of keys) {
    const res = await cache.match(req);
    bytes += Number(res && res.headers.get('content-length')) || 0;
  }
  return bytes;
}

// Requests from the background script. emit() sends progress and text;
// the returned value is the final result.
export async function handle(type, msg, emit, signal) {
  switch (type) {
    case 'status':
      return gpuStatus();

    case 'prepare': {
      const c = await load(msg.key, emit);
      scheduleUnload();
      return { dtype: c.dtype, bytes: await cachedBytes(R.LOCAL_MODELS[msg.key]) };
    }

    case 'generate': {
      emit({ type: 'loading' });
      const c = await load(msg.key, emit);
      if (signal && signal.aborted) return { stopped: true };
      emit({ type: 'thinking' });
      if (active) active.interrupt();
      const stopper = new InterruptableStoppingCriteria();
      active = stopper;
      const onAbort = () => stopper.interrupt();
      if (signal) signal.addEventListener('abort', onAbort);
      try {
        await c.run({
          system: msg.system,
          user: msg.user,
          maxNewTokens: msg.maxNewTokens || 1024,
          stopper,
          onDelta: (text) => {
            if (text) emit({ type: 'delta', text });
          },
        });
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (active === stopper) active = null;
        scheduleUnload();
      }
      return { stopped: Boolean(signal && signal.aborted) };
    }

    case 'remove': {
      const model = R.LOCAL_MODELS[msg.key];
      if (current && current.key === msg.key) await unload();
      const { cache, keys } = await cachedEntries(model);
      for (const req of keys) await cache.delete(req);
      return { removed: keys.length };
    }

    case 'unload':
      await unload();
      return { ok: true };

    default:
      throw new EngineError('unknown', `Unknown engine request: ${type}`);
  }
}
