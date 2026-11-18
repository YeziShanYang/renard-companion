import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/content/keys.js');
const { parseShortcut, parseShortcuts, matchesShortcut } = globalThis.Renard;

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

const ev = (code, key, mods = {}) => ({ ...key_(code, mods), key });
function key_(code, mods) {
  return { code, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods };
}

test('matches the letter a key types, so Dvorak and AZERTY get the labelled key', () => {
  const { setKeyboardLayout } = globalThis.Renard;
  setKeyboardLayout(null);
  const sc = parseShortcut('Alt+Shift+F', false);
  const mods = { altKey: true, shiftKey: true };
  // Dvorak: the key labelled F sits where QWERTY has Y; QWERTY's F types U.
  assert.ok(matchesShortcut(ev('KeyY', 'F', mods), sc));
  assert.ok(!matchesShortcut(ev('KeyF', 'U', mods), sc));
  // AZERTY: Ctrl+Shift+A is the key QWERTY calls Q.
  const ctrlA = parseShortcut('Ctrl+Shift+A', false);
  assert.ok(matchesShortcut(ev('KeyQ', 'A', { ctrlKey: true, shiftKey: true }), ctrlA));
  assert.ok(!matchesShortcut(ev('KeyA', 'Q', { ctrlKey: true, shiftKey: true }), ctrlA));
  // Lower-case keys (Command on macOS reports them) match too.
  const cmdY = parseShortcut('Ctrl+Shift+Y', true);
  assert.ok(matchesShortcut(ev('KeyY', 'y', { metaKey: true, shiftKey: true }), cmdY));
});

test('falls back to the physical key when the typed character is not a plain letter', () => {
  const { setKeyboardLayout } = globalThis.Renard;
  const sc = parseShortcut('Alt+Shift+F', true);
  const mods = { altKey: true, shiftKey: true };
  setKeyboardLayout(null);
  // Option changes the character; without a layout, the US position counts.
  assert.ok(matchesShortcut(ev('KeyF', 'Ï', mods), sc));
  // A Cyrillic layout types А on that key.
  assert.ok(matchesShortcut(ev('KeyF', 'А', mods), sc));
  assert.ok(!matchesShortcut(ev('KeyY', 'Ï', mods), sc));
  // With Dvorak's layout known, Option+Shift on the key labelled F matches.
  setKeyboardLayout([
    ['KeyY', 'f'],
    ['KeyF', 'u'],
    ['Digit1', '1'],
  ]);
  assert.ok(matchesShortcut(ev('KeyY', '·', mods), sc));
  assert.ok(!matchesShortcut(ev('KeyF', 'ˆ', mods), sc));
  // Shift+1 types "!", so the digit's key is used.
  const digit = parseShortcut('Ctrl+Shift+1', false);
  assert.ok(matchesShortcut(ev('Digit1', '!', { ctrlKey: true, shiftKey: true }), digit));
  // Keys that aren't letters or digits always match by position.
  const comma = parseShortcut('Alt+Comma', false);
  assert.ok(matchesShortcut(ev('Comma', '≤', { altKey: true }), comma));
  setKeyboardLayout(null);
});

test("parses Chrome's macOS arrow and navigation symbols", () => {
  assert.deepEqual(parseShortcut('⌥⇧↑', true), { alt: true, shift: true, ctrl: false, meta: false, code: 'ArrowUp' });
  assert.equal(parseShortcut('⌥⇧←', true).code, 'ArrowLeft');
  assert.equal(parseShortcut('⌥⇧⇞', true).code, 'PageUp');
  assert.equal(parseShortcut('⌥⇧↖', true).code, 'Home');
  assert.equal(parseShortcut('Alt+Shift+Up', false).code, 'ArrowUp');
});

test('parses a map of shortcuts, leaving out unrecognized ones', () => {
  assert.deepEqual(parseShortcuts({ 'toggle-bubble': 'Alt+Shift+F', 'toggle-visibility': '', other: 'Alt+MediaPlayPause' }, true), {
    'toggle-bubble': parseShortcut('Alt+Shift+F'),
  });
  assert.deepEqual(parseShortcuts(undefined), {});
});
