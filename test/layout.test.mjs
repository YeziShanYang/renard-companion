import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/content/layout.js');
const { margins, placement, resized, freePlacement } = globalThis.Renard.layout;

const fox = (left, top) => ({ left, right: left + 64, top, bottom: top + 64, width: 64, height: 64 });
const viewport = { width: 1280, height: 800 };

test('the fox rests in the margin beside the content column', () => {
  // No message box: a fifth of the window, at most.
  assert.deepEqual(margins('left', { viewportWidth: 1280, composer: null, bodyWidth: 40 }), { min: 28, max: 200 });
  // Beside the message box, up to 260 px out.
  assert.deepEqual(margins('left', { viewportWidth: 1280, composer: { left: 300, right: 980, width: 680 }, bodyWidth: 40 }), { min: 28, max: 244 });
  assert.deepEqual(margins('right', { viewportWidth: 1280, composer: { left: 200, right: 1100, width: 900 }, bodyWidth: 40 }), { min: 28, max: 124 });
  // A narrow window still leaves the edge gap.
  assert.deepEqual(margins('right', { viewportWidth: 400, composer: null, bodyWidth: 40 }), { min: 28, max: 28 });
});

test('a fox low on the screen gets a bubble growing up from beside it', () => {
  const { crowded, place } = placement({ fox: fox(1180, 600), edge: 'right', viewport, size: { width: 520, height: 0, expanded: false }, answering: false, minHeight: 150, composer: null });
  assert.equal(crowded, false);
  assert.deepEqual({ ...place, tailOffset: Math.round(place.tailOffset) }, {
    side: 'left',
    left: 666,
    width: 520,
    expanded: false,
    pressed: false,
    anchor: 'bottom',
    offset: 124,
    height: 0,
    maxHeight: 664,
    tailOffset: 49,
    expandedHeight: 640,
  });
});

test('a fox high on the screen gets a bubble hanging down, at its dragged height once answering', () => {
  const { place } = placement({ fox: fox(30, 100), edge: 'left', viewport, size: { width: 520, height: 500, expanded: false }, answering: true, minHeight: 300, composer: null });
  assert.equal(place.side, 'right');
  assert.equal(place.anchor, 'top');
  assert.equal(place.left, 88);
  assert.equal(place.offset, 76);
  assert.equal(place.height, 500);
  assert.equal(place.maxHeight, 712);
});

test('the reading view is wider, and fills its height only with an answer', () => {
  const composer = { left: 300, right: 980, top: 700, bottom: 780, width: 680 };
  const asked = placement({ fox: fox(1180, 600), edge: 'right', viewport, size: { width: 420, height: 0, expanded: true }, answering: true, minHeight: 150, composer });
  assert.equal(asked.place.width, 720);
  assert.equal(asked.place.left, 466);
  assert.equal(asked.place.expanded, true);
  assert.equal(asked.place.pressed, true);
  const before = placement({ fox: fox(1180, 600), edge: 'right', viewport, size: { width: 420, height: 0, expanded: true }, answering: false, minHeight: 150, composer });
  assert.equal(before.place.expanded, false, 'before a question it only widens');
  assert.equal(before.place.pressed, true);
});

test('the earlier 420 px default width counts as the current default', () => {
  const { place } = placement({ fox: fox(1180, 600), edge: 'right', viewport, size: { width: 420, height: 0, expanded: false }, answering: false, minHeight: 150, composer: null });
  assert.equal(place.width, 520);
});

test('in a narrow window the bubble fits the room beside the fox', () => {
  const { crowded, place } = placement({ fox: fox(300, 600), edge: 'right', viewport: { width: 360, height: 700 }, size: { width: 520, height: 0, expanded: false }, answering: false, minHeight: 150, composer: null });
  assert.equal(place.width, 294);
  assert.equal(place.left, 12);
  assert.equal(crowded, false);
  const tight = placement({ fox: fox(100, 600), edge: 'right', viewport: { width: 360, height: 700 }, size: { width: 520, height: 0, expanded: false }, answering: false, minHeight: 150, composer: null });
  assert.equal(tight.crowded, true, 'the bubble covers the fox and is drawn above it');
});

test('a corner drag moves that corner and keeps the opposite one', () => {
  const rect = { left: 600, top: 200, right: 1120, bottom: 600 };
  assert.deepEqual(resized({ corner: 'nw', rect, dx: -100, dy: -50, viewport, minHeight: 150 }), { left: 500, top: 150, width: 620, height: 450 });
  // Held inside the viewport, and no shorter than the content needs.
  assert.deepEqual(resized({ corner: 'se', rect, dx: 900, dy: -900, viewport, minHeight: 150 }), { left: 600, top: 200, width: 668, height: 150 });
});

test('a resized bubble stays where it was dragged', () => {
  const { crowded, place } = freePlacement({ box: { left: 500, top: 150, width: 620, height: 450 }, fox: fox(1180, 600), edge: 'right', viewport });
  assert.equal(crowded, false);
  assert.deepEqual({ ...place, tailOffset: Math.round(place.tailOffset) }, {
    side: 'left',
    anchor: 'top',
    offset: 150,
    left: 500,
    width: 620,
    height: 450,
    maxHeight: 638,
    tailOffset: 465,
    expanded: false,
    expandedHeight: 0,
  });
});
