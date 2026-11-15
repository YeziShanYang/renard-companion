import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// Transformers.js's Node build has the same file loading code as the browser
// build Renard ships, so it shows what the engine's settings do.
import { env, AutoConfig, AutoTokenizer } from '@huggingface/transformers';
import { hubSettings, hasModelFiles, fileBase } from '../src/engine/hub.js';
import '../src/shared/constants.js';

const R = globalThis.Renard;

// A stand-in model whose files are small enough to write here.
const model = { repo: 'renard-test/tiny-ONNX', revision: '0123456789abcdef0123456789abcdef01234567' };
const FILES = {
  'config.json': { model_type: 'gemma3_text' },
  'tokenizer_config.json': { tokenizer_class: 'PreTrainedTokenizer' },
  'tokenizer.json': {
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: [],
    normalizer: null,
    pre_tokenizer: { type: 'Whitespace' },
    post_processor: null,
    decoder: null,
    model: { type: 'WordLevel', vocab: { hello: 0, fox: 1, '[UNK]': 2 }, unk_token: '[UNK]' },
  },
};

// The browser cache after a download, and a network that is down.
const cached = new Map();
const fetched = [];
env.useCustomCache = true;
env.customCache = {
  async match(url) {
    const body = cached.get(String(url));
    return body === undefined ? undefined : new Response(body, { headers: { 'content-length': String(body.length) } });
  },
  async put() {},
};
env.fetch = async (url) => {
  fetched.push(String(url));
  throw new TypeError('offline');
};
const defaults = { remotePathTemplate: env.remotePathTemplate, allowRemoteModels: true, allowLocalModels: false };

beforeEach(() => {
  cached.clear();
  for (const [name, value] of Object.entries(FILES)) cached.set(fileBase(model) + name, JSON.stringify(value));
  fetched.length = 0;
  Object.assign(env, defaults);
});

test('a downloaded model loads from the cache with no network', async () => {
  Object.assign(env, hubSettings(model, { cacheOnly: true }));
  const config = await AutoConfig.from_pretrained(model.repo, { revision: model.revision });
  assert.equal(config.model_type, 'gemma3_text');
  // The tokenizer also looks for its files without a revision.
  const tokenizer = await AutoTokenizer.from_pretrained(model.repo, { revision: model.revision });
  assert.deepEqual(tokenizer.encode('hello fox'), [0, 1]);
  assert.deepEqual(fetched, []);
});

test('a file missing from the cache is reported as missing, never fetched', async () => {
  cached.delete(fileBase(model) + 'config.json');
  Object.assign(env, hubSettings(model, { cacheOnly: true }));
  await assert.rejects(AutoConfig.from_pretrained(model.repo, { revision: model.revision }), { name: 'ModelFileNotFoundError' });
  assert.deepEqual(fetched, []);
});

test('turning off remote files alone is refused, so cache-only keeps local files on', async () => {
  Object.assign(env, { allowRemoteModels: false });
  await assert.rejects(AutoConfig.from_pretrained(model.repo, { revision: model.revision }), /both local and remote models are disabled/);
  assert.deepEqual(hubSettings(model, { cacheOnly: true }), {
    remotePathTemplate: `{model}/resolve/${model.revision}/`,
    allowRemoteModels: false,
    allowLocalModels: true,
  });
});

test('a download fetches the pinned commit, not the latest one', async () => {
  Object.assign(env, hubSettings(model));
  cached.clear();
  await assert.rejects(AutoConfig.from_pretrained(model.repo));
  assert.deepEqual(fetched, [`${fileBase(model)}config.json`]);
});

test('a download counts as cached only when it is whole, for this dtype and revision', () => {
  const gemma = R.LOCAL_MODELS['gemma-3-1b'];
  const base = fileBase(gemma);
  const all = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'].map((f) => base + f);
  assert.ok(hasModelFiles(all, gemma, 'q4f16'));
  assert.ok(!hasModelFiles(all, gemma, 'q4'), 'weights in another dtype');
  assert.ok(!hasModelFiles(all.filter((u) => !u.endsWith('/tokenizer.json')), gemma, 'q4f16'), 'no tokenizer');
  assert.ok(!hasModelFiles(all.filter((u) => !u.includes('/onnx/')), gemma, 'q4f16'), 'no weights');
  const older = all.map((u) => u.replace(gemma.revision, 'f'.repeat(40)));
  assert.ok(!hasModelFiles(older, gemma, 'q4f16'), 'an older revision');
  assert.ok(!hasModelFiles([], gemma, 'q4f16'));
});
