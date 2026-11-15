import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSetting } from '../src/shared/settings.js';

const R = globalThis.Renard;

test('stored settings with the wrong shape fall back to defaults', () => {
  assert.equal(cleanSetting('provider', 'nonsense'), 'anthropic');
  assert.equal(cleanSetting('provider', 'constructor'), 'anthropic', 'no prototype names');
  assert.equal(cleanSetting('provider', 'local'), 'local');
  assert.deepEqual(cleanSetting('sites', 'yes'), R.DEFAULTS.sites);
  assert.deepEqual(cleanSetting('prefs', null), R.DEFAULTS.prefs);
  assert.deepEqual(cleanSetting('apiKeys', []), R.DEFAULTS.apiKeys);
  assert.deepEqual(cleanSetting('models', 5), R.DEFAULTS.models);
  assert.deepEqual(cleanSetting('otherSites', 'abc'), []);
  assert.equal(cleanSetting('spawned', 'no'), true);
});

test('entries of the wrong type are dropped, the rest are kept', () => {
  assert.deepEqual(cleanSetting('sites', { claude: 'maybe', chatgpt: false }), { claude: true, chatgpt: false });
  assert.deepEqual(cleanSetting('prefs', { readChat: 'yes', sound: true }).sound, true);
  assert.equal(cleanSetting('apiKeys', { anthropic: 42, openai: 'sk-x' }).anthropic, '');
  assert.equal(cleanSetting('models', { openai: 7 }).openai, null);
  assert.deepEqual(cleanSetting('positions', { claude: { edge: 'left', y: 0.5 }, x: 3 }), { claude: { edge: 'left', y: 0.5 } });
  assert.deepEqual(cleanSetting('otherSites', [1, null, '<b>x</b>', 'a.example', 'a.example', 'claude.ai']), ['a.example']);
});

test('built-in model settings only name real models', () => {
  assert.deepEqual(cleanSetting('localModel', { key: '__proto__', ready: 'x' }), { key: 'gemma-3-1b', ready: {} });
  const lm = cleanSetting('localModel', { key: 'gemma-4-e2b', ready: { 'gemma-3-1b': { dtype: 'q4' }, bogus: {} } });
  assert.deepEqual(lm, { key: 'gemma-4-e2b', ready: { 'gemma-3-1b': { dtype: 'q4' } } });
});

test('cleaning never hands out or changes the defaults themselves', () => {
  const lm = cleanSetting('localModel', undefined);
  lm.ready.x = 1;
  assert.deepEqual(R.DEFAULTS.localModel.ready, {});
});

test('API keys are one line of printable ASCII', () => {
  assert.ok(R.isApiKey('sk-ant-api03-abcDEF_123'));
  assert.ok(R.isApiKey('AIza' + 'q'.repeat(35)));
  assert.ok(!R.isApiKey(''));
  assert.ok(!R.isApiKey('sk with space'));
  assert.ok(!R.isApiKey('sk-\u200b-hidden'), 'zero-width character');
  assert.ok(!R.isApiKey('ключ'));
  assert.ok(!R.isApiKey('x'.repeat(513)));
  assert.ok(!R.isApiKey(42));
});

test('settings saved by Renard load back unchanged after a restart', () => {
  const gemma = R.LOCAL_MODELS['gemma-3-1b'];
  const saved = {
    spawned: false,
    provider: 'local',
    apiKeys: { anthropic: '', openai: 'sk-test-0000', gemini: '' },
    models: { anthropic: null, openai: { id: 'gpt-test', name: 'GPT Test', maxTokens: 1000, effortLow: true }, gemini: null },
    sites: { claude: false, chatgpt: true },
    otherSites: ['en.wikipedia.org'],
    prefs: { readChat: false, readableText: true, sound: true },
    bubble: { width: 640, height: 400, expanded: true },
    // The other model selected, with Gemma 3 1B downloaded (what a finished
    // download records).
    localModel: { key: 'gemma-4-e2b', ready: { 'gemma-3-1b': { dtype: 'q4f16', bytes: 783856804, revision: gemma.revision, at: 1 } } },
    positions: { claude: { edge: 'left', y: 0.2 }, 'web:en.wikipedia.org': { edge: 'right', y: 0.9 } },
  };
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(R.DEFAULTS).sort(), 'every setting is covered');
  for (const [key, value] of Object.entries(saved)) assert.deepEqual(cleanSetting(key, value), value, key);
  const lm = cleanSetting('localModel', saved.localModel);
  assert.ok(R.localReady(lm, gemma));
  assert.equal(R.localReady(lm, R.LOCAL_MODELS['gemma-4-e2b']), null);
  assert.equal(R.localReady({ ready: { 'gemma-3-1b': { ...lm.ready['gemma-3-1b'], revision: 'older' } } }, gemma), null, 'an older download');
});
