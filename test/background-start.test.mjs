// What the background script does when it starts: moves stored keys,
// rebuilds the added sites' registration, brings Renard to open tabs once,
// and opens settings on a first install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBrowser, installFakeBrowser, settle, BASE } from './helpers/fake-browser.mjs';

const fake = createFakeBrowser();
installFakeBrowser(fake);
fake.grant(...fake.ext.runtime.getManifest().host_permissions, 'https://example.com/*');

fake.ext.storage.local._load({
  apiKeys: { anthropic: 'sk-ant-test-0000', openai: '', gemini: '' },
  otherSites: ['example.com', 'gone.example'],
  skippedSites: [],
});
// An earlier version's registration, with other files.
fake.registered.push({ id: 'renard-other-sites', matches: ['https://example.com/*'], js: ['content/old.js'], runAt: 'document_idle' });
fake.addTab({ id: 1, url: 'https://claude.ai/new' });
fake.addTab({ id: 2, url: 'https://chatgpt.com/', booted: true });
fake.addTab({ id: 3, url: 'https://claude.ai/chat/9', discarded: true });
fake.addTab({ id: 4, url: 'https://example.com/x' });
fake.addTab({ id: 5, url: 'https://gone.example/x' });
fake.addTab({ id: 6, url: 'https://unrelated.example/' });

await import('../src/background/background.js');
await settle(80);

const CONTENT_JS = fake.ext.runtime.getManifest().content_scripts[0].js.map((f) => f.slice(BASE.length));

test('locks storage to extension pages', () => {
  assert.deepEqual(fake.areaAccess, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
});

test('moves keys out of storage.local into the database', () => {
  assert.equal(fake.ext.storage.local._dump().apiKeys, undefined);
  assert.equal(fake.indexedDB._dbs.get('renard-secrets').get('secrets').get('apiKeys').anthropic, 'sk-ant-test-0000');
});

test('replaces an outdated registration with the allowed added sites', () => {
  assert.deepEqual(fake.registered, [
    { id: 'renard-other-sites', matches: ['https://example.com/*'], js: CONTENT_JS, css: ['content/host.css'], runAt: 'document_idle' },
  ]);
});

test('brings Renard to open tabs on its sites, once', async () => {
  const probed = fake.callsNamed('scripting.executeScript').filter(([c]) => c.probe).map(([c]) => c.target.tabId);
  const injected = fake.callsNamed('scripting.executeScript').filter(([c]) => c.files).map(([c]) => c.target.tabId);
  assert.deepEqual(probed.sort(), [1, 2, 4]);
  assert.deepEqual(injected.sort(), [1, 4]);
  assert.equal(fake.ext.storage.session._dump().started, true);
});

test('badge is clear when every needed origin is allowed', () => {
  assert.deepEqual(fake.callsNamed('action.setBadgeText').at(-1), [{ text: '' }]);
  assert.deepEqual(fake.callsNamed('action.setTitle').at(-1), [{ title: 'Renard' }]);
});

test('install opens settings for the tour; an update never does, and one from before the tour skips it', async () => {
  const opened = () => fake.callsNamed('runtime.openOptionsPage').length;
  const tourDone = () => fake.ext.storage.local._dump().tourDone;
  fake.clearCalls();
  fake.ext.runtime.onInstalled.dispatch({ reason: 'update', previousVersion: '0.1.4' });
  await settle(40);
  assert.equal(opened(), 0);
  assert.equal(tourDone(), undefined, 'an update from a version with the tour leaves it to run');
  fake.ext.runtime.onInstalled.dispatch({ reason: 'install' });
  await settle(40);
  assert.equal(opened(), 1, 'a key is saved, but the tour has not run');
  fake.ext.runtime.onInstalled.dispatch({ reason: 'update', previousVersion: '0.1.3' });
  await settle(40);
  assert.equal(opened(), 1);
  assert.equal(tourDone(), true, 'someone updating from 0.1.3 skips the tour');
  fake.ext.runtime.onInstalled.dispatch({ reason: 'install' });
  await settle(40);
  assert.equal(opened(), 1, 'a key is saved and the tour is done');
  await fake.ext.storage.local.set({ apiKeys: { anthropic: '', openai: '', gemini: '' } });
  await settle(40);
  fake.ext.runtime.onInstalled.dispatch({ reason: 'install' });
  await settle(40);
  assert.equal(opened(), 2, 'no key saved');
});

test('versions compare part by part', async () => {
  const { versionBefore } = await import('../src/background/install.js');
  assert.equal(versionBefore('0.1.3', '0.1.4'), true);
  assert.equal(versionBefore('0.1.4', '0.1.4'), false);
  assert.equal(versionBefore('0.1.10', '0.1.4'), false);
  assert.equal(versionBefore('0.2', '0.1.4'), false);
  assert.equal(versionBefore('0.1', '0.1.4'), true);
});
