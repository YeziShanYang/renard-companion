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

test('imageDimensions reads the size from PNG, GIF, WebP and JPEG headers', async () => {
  const blob = (bytes) => new Blob([new Uint8Array(bytes)]);
  const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(20000), ...be32(15000), 8, 6, 0, 0, 0];
  assert.deepEqual(await R.imageDimensions(blob(png)), { width: 20000, height: 15000 });
  const gif = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xff, 0xff, 0x10, 0x00];
  assert.deepEqual(await R.imageDimensions(blob(gif)), { width: 65535, height: 16 });
  const riff = (chunk, rest) => [...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0)), [...chunk].map((c) => c.charCodeAt(0)), rest);
  // VP8X: 24-bit width-1 and height-1 at offsets 24 and 27.
  const vp8x = riff('VP8X', [10, 0, 0, 0, 0, 0, 0, 0, 0x1f, 0x4e, 0, 0x0f, 0x27, 0]);
  assert.deepEqual(await R.imageDimensions(blob(vp8x)), { width: 0x4e1f + 1, height: 0x270f + 1 });
  // JPEG: an APP0 segment, then SOF0 with height 300 and width 400.
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x2c, 0x01, 0x90, 3, 0, 0, 0];
  assert.deepEqual(await R.imageDimensions(blob(jpeg)), { width: 400, height: 300 });
  assert.equal(await R.imageDimensions(blob([1, 2, 3, 4])), null);
});

test('prepareImage refuses a file whose header declares a huge image, before decoding it', async () => {
  const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const bomb = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(20000), ...be32(20000), 8, 6, 0, 0, 0])], { type: 'image/png' });
  await assert.rejects(R.prepareImage(bomb), { code: 'tooLarge' });
  await assert.rejects(R.prepareImage(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })), { code: 'unreadable' });
});
