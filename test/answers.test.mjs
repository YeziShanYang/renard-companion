import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/content/ask.js');
const { answers, readContext } = globalThis.Renard;

test('notes say how much of the page or chat was read, and warn about text aimed at models', () => {
  assert.equal(answers.contextNote({ page: true, partial: false, aimed: false }), '');
  assert.equal(answers.contextNote({ page: true, partial: true, included: 40000, total: 90000 }), 'Read the first part of this page (40000 of 90000 characters).');
  assert.equal(answers.contextNote({ partial: true, included: 12, total: 30 }), 'Read the latest part of this chat (12 of 30 messages).');
  assert.match(answers.contextNote({ aimed: true, page: true }), /^This page has text aimed at AI assistants/);
  assert.match(answers.contextNote({ aimed: true, partial: true, included: 1, total: 2 }), /^This chat has text aimed at AI assistants.*\. Read the latest part of this chat \(1 of 2 messages\)\.$/);
  assert.equal(answers.unreadNote('page'), "Couldn't find any text on this page, so this answer doesn't use it.");
  assert.equal(answers.unreadNote('chat'), "Couldn't read the chat on this page, so this answer doesn't use it.");
  assert.equal(answers.endNote('', false), 'Hmm, the answer came back empty. Try asking again?');
  assert.equal(answers.endNote('Hi', true), "This answer reached the model's length limit, so it ends early.");
  assert.equal(answers.endNote('Hi', false), '');
});

test('errors are worded per kind, without anything shaped like a key', () => {
  assert.equal(answers.errorDetail({ kind: 'keyInvalid', message: 'bad key sk-ant-abcdef' }, 'Anthropic'), "Anthropic didn't accept the API key. Check it in settings.");
  assert.equal(answers.errorDetail({ kind: 'rateLimited' }, 'OpenAI'), 'OpenAI is rate limiting requests right now.');
  assert.equal(answers.errorDetail({ kind: 'refused', message: 'no' }, 'Gemini'), '');
  assert.equal(answers.errorDetail({ kind: 'noGpu', message: 'No WebGPU here.' }, 'Built-in Gemma'), 'No WebGPU here.');
  assert.equal(answers.errorDetail({ kind: 'network', message: 'Key AIzaSyA1234567890 failed' }, 'Gemini'), 'Gemini: Key [hidden] failed');
  assert.equal(answers.errorDetail({ kind: 'unknown', message: '' }, 'Gemini'), '');
  assert.equal(answers.scrubError('word '.repeat(100)).length, 300);
  assert.equal(answers.scrubError('x'.repeat(400)), '[hidden]');
  assert.deepEqual(answers.errorStyle('refused'), { line: 'refused', discard: true });
  assert.deepEqual(answers.errorStyle('keyMissing'), { line: 'noKey', settings: true });
  assert.deepEqual(answers.errorStyle('something new'), { line: 'networkError' });
});

test('the chat or page goes along with a question, or a note that it could not be read', () => {
  globalThis.Renard.adapterUtils = { capTurns: (turns) => turns };
  const chat = { kind: 'chat', readChat: () => [{ role: 'user', text: 'hi' }] };
  assert.deepEqual(readContext(chat, 'Claude'), { chat: { siteName: 'Claude', turns: [{ role: 'user', text: 'hi' }] }, page: null, failed: false });
  assert.deepEqual(readContext({ kind: 'chat', readChat: () => [] }, 'Claude'), { chat: null, page: null, failed: false });
  assert.deepEqual(readContext({ kind: 'chat', readChat: () => { throw new Error('no messages'); } }, 'Claude'), { chat: null, page: null, failed: true });
  const page = { title: 'T', url: 'https://example.com/', text: 'Body' };
  assert.deepEqual(readContext({ kind: 'page', readPage: () => page }, 'example.com'), { chat: null, page, failed: false });
  assert.deepEqual(readContext({ kind: 'page', readPage: () => ({ ...page, text: '' }) }, 'example.com'), { chat: null, page: null, failed: true });
});
