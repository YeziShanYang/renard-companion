import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/shared/image.js');
const R = globalThis.Renard;

test('fitImage keeps small images at their own size', () => {
  assert.deepEqual(R.fitImage(800, 600), { width: 800, height: 600 });
  assert.deepEqual(R.fitImage(1, 1), { width: 1, height: 1 });
});

test('fitImage scales a wide capture to the 1568 px edge and a large one to 1.15 megapixels', () => {
  // A narrow strip only hits the edge limit.
  assert.deepEqual(R.fitImage(3136, 200), { width: 1568, height: 100 });
  // A 2x Retina capture of a 1440 × 900 window hits the pixel limit.
  const big = R.fitImage(2880, 1800);
  assert.ok(big.width * big.height <= 1150000, `${big.width}x${big.height}`);
  assert.ok(Math.max(big.width, big.height) <= 1568);
  assert.ok(Math.abs(big.width / big.height - 1.6) < 0.01);
});

test('isAttachedImage accepts what prepareImage makes and nothing else', () => {
  const ok = { mediaType: 'image/png', data: 'iVBORw0KGgo=', width: 10, height: 10 };
  assert.ok(R.isAttachedImage(ok));
  assert.ok(R.isAttachedImage({ ...ok, mediaType: 'image/jpeg' }));
  assert.ok(!R.isAttachedImage(null));
  assert.ok(!R.isAttachedImage({ ...ok, mediaType: 'image/svg+xml' }));
  assert.ok(!R.isAttachedImage({ ...ok, data: 'not base64!' }));
  assert.ok(!R.isAttachedImage({ ...ok, data: '' }));
  assert.ok(!R.isAttachedImage({ ...ok, data: 'A'.repeat(5e6) }));
  assert.ok(!R.isAttachedImage({ ...ok, width: 0 }));
  assert.ok(!R.isAttachedImage({ ...ok, width: 4000 }));
  assert.ok(!R.isAttachedImage({ ...ok, height: 1.5 }));
});
