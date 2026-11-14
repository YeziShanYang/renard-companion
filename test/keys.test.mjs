import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/content/keys.js');
const { parseShortcut, matchesShortcut } = globalThis.Renard;

const key = (code, mods = {}) => ({ code, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });

test('parses Firefox and Chrome shortcut strings', () => {
  assert.deepEqual(parseShortcut('Alt+Shift+F', false), { alt: true, shift: true, ctrl: false, meta: false, code: 'KeyF' });
  assert.deepEqual(parseShortcut('⌥⇧F', true), { alt: true, shift: true, ctrl: false, meta: false, code: 'KeyF' });
  assert.deepEqual(parseShortcut('Ctrl+Shift+1', true), { alt: false, shift: true, ctrl: false, meta: true, code: 'Digit1' });
  assert.deepEqual(parseShortcut('Ctrl+Shift+1', false), { alt: false, shift: true, ctrl: true, meta: false, code: 'Digit1' });
  assert.deepEqual(parseShortcut('MacCtrl+Comma', true), { alt: false, shift: false, ctrl: true, meta: false, code: 'Comma' });
  assert.equal(parseShortcut('', true), null);
  assert.equal(parseShortcut('Alt+MediaPlayPause', true), null);
});

test('matches by physical key, so macOS Option does not break it', () => {
  const sc = parseShortcut('Alt+Shift+F', true);
  // On macOS, Option+Shift+F reports key "Ï" but code "KeyF".
  assert.ok(matchesShortcut({ ...key('KeyF', { altKey: true, shiftKey: true }), key: 'Ï' }, sc));
  assert.ok(!matchesShortcut(key('KeyF', { altKey: true }), sc));
  assert.ok(!matchesShortcut(key('KeyF', { altKey: true, shiftKey: true, metaKey: true }), sc));
  assert.ok(!matchesShortcut(key('KeyG', { altKey: true, shiftKey: true }), sc));
  assert.ok(!matchesShortcut(key('KeyF', { altKey: true, shiftKey: true }), null));
});
