// Generates src/icons/icon-{16,32,48,96,128}.png from an original 16x16 fox
// head drawn below in the sprite sheet's palette. The art is Renard's own
// (not from the licensed sprite sheet), so the icons are committed.
//
// Each size uses a whole-number scale so the pixels stay crisp: 16, 32, and 48
// fill the icon; 96 and 128 keep the transparent margin the Chrome Web Store
// asks for (the art covers about three quarters of the icon).
// Run after editing the art: npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');

const PALETTE = {
  '.': [0, 0, 0, 0],
  K: [47, 47, 46, 255], // outline
  O: [214, 121, 65, 255], // orange
  R: [157, 80, 33, 255], // rust shading
  C: [255, 255, 255, 255], // cheeks and inner ears
};

const HEAD = [
  '.KK..........KK.',
  '.KOK........KOK.',
  '.KCOK......KOCK.',
  '.KCOOKKKKKKOOCK.',
  '.KOOOOOOOOOOOOK.',
  'KOOOOOOOOOOOOOOK',
  'KOOKKOOOOOOKKOOK',
  'KOOKKOOOOOOKKOOK',
  'KROOOOOOOOOOOORK',
  '.KCCCOOOOOOCCCK.',
  '.KCCCCCKKCCCCCK.',
  '..KCCCCCCCCCCK..',
  '...KKCCCCCCKK...',
  '.....KKKKKK.....',
];

const SIZES = [16, 32, 48, 96, 128];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writePng(file, px) {
  const h = px.length;
  const w = px[0].length;
  const raw = Buffer.alloc(h * (1 + w * 4));
  px.forEach((row, y) => row.forEach((p, x) => raw.set(p, y * (1 + w * 4) + 1 + x * 4)));
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(typed));
    return Buffer.concat([len, typed, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fs.writeFileSync(file, Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

// Centers the art in a size x size icon at the largest whole-number scale
// that fits its area.
function render(art, size) {
  const area = size <= 48 ? size : Math.round(size * 0.75);
  const scale = Math.max(1, Math.floor(Math.min(area / art[0].length, area / art.length)));
  const out = Array.from({ length: size }, () => Array.from({ length: size }, () => PALETTE['.']));
  const ox = Math.floor((size - art[0].length * scale) / 2);
  const oy = Math.floor((size - art.length * scale) / 2);
  art.forEach((row, y) =>
    row.forEach((p, x) => {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) out[oy + y * scale + dy][ox + x * scale + dx] = p;
    }),
  );
  return out;
}

const art = HEAD.map((line) => [...line].map((ch) => PALETTE[ch]));
fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) writePng(path.join(OUT, `icon-${size}.png`), render(art, size));
console.log(`wrote ${SIZES.map((s) => `icon-${s}.png`).join(', ')}`);
