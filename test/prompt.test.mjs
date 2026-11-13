import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimChat, buildUserMessage } from '../src/shared/prompt.js';

test('trimChat keeps everything that fits and drops non-chat roles', () => {
  const r = trimChat([
    { role: 'user', text: ' hi ' },
    { role: 'system', text: 'x' },
    { role: 'assistant', text: 'hello' },
    { role: 'assistant', text: '   ' },
  ]);
  assert.deepEqual(r, {
    turns: [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ],
    total: 2,
    partial: false,
  });
});

test('trimChat keeps the most recent turns within the budget', () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: String(i).repeat(30) }));
  const r = trimChat(turns, { chatChars: 100, turnChars: 1000 });
  assert.equal(r.total, 10);
  assert.equal(r.partial, true);
  assert.deepEqual(
    r.turns.map((t) => t.text[0]),
    ['7', '8', '9'],
  );
});

test('trimChat shortens a very long message from the middle', () => {
  const long = `${'a'.repeat(500)}${'b'.repeat(500)}`;
  const r = trimChat([{ role: 'assistant', text: long }], { chatChars: 1000, turnChars: 100 });
  assert.equal(r.partial, true);
  assert.ok(r.turns[0].text.startsWith('a'.repeat(60)));
  assert.ok(r.turns[0].text.endsWith('b'.repeat(40)));
  assert.ok(r.turns[0].text.includes('[…]'));
});

test('buildUserMessage without chat is just the question', () => {
  assert.equal(buildUserMessage('what?', null), 'what?');
});

test('buildUserMessage wraps the chat and notes partial context', () => {
  const msg = buildUserMessage('summarize', {
    siteName: 'ChatGPT',
    turns: [{ role: 'user', text: 'hello' }],
    total: 5,
    partial: true,
  });
  assert.match(msg, /conversation on ChatGPT/);
  assert.match(msg, /1 of 5 messages/);
  assert.match(msg, /<message role="user">\nhello\n<\/message>/);
  assert.ok(msg.endsWith('Question: summarize'));
});
