// Generates src/icons/icon-{16,32,48,96,128}.png.
//
// With the licensed sprite sheet present (src/assets/fox-sprite-sheet.png),
// the icon is Renard standing: the first idle frame, cropped and scaled by
// whole numbers. The generated files are git-ignored because they are cut
// from that art. Without the sheet, it falls back to an original 16x16 fox
// head drawn below, so a fresh clone still loads.
//
// Runs on npm install, start, and build; run it by hand with `npm run icons`.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHEET = path.join(ROOT, 'src/assets/fox-sprite-sheet.png');
const OUT = path.join(ROOT, 'src/icons');
const FRAME = 32;

// Integer scale of the standing fox per icon size (the art is about 20x15).
// 128 and 96 leave the transparent margin the Chrome Web Store asks for. At
// 16 the art cannot shrink without smearing, so it is shown at 1x, cropped
// to the 16 columns on the head side (the fox faces right).
const SPRITE_SCALE = { 16: 1, 32: 1, 48: 2, 96: 4, 128: 4 };

// ---- PNG read/write (8-bit, non-interlaced) ---------------------------------

function readPng(file) {
  const data = fs.readFileSync(file);
  let pos = 8;
  let ihdr;
  let palette = null;
  let alpha = null;
  const idat = [];
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString('latin1', pos + 4, pos + 8);
    const body = data.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') ihdr = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') alpha = body;
    else if (type === 'IDAT') idat.push(body);
  }
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) throw new Error('Only 8-bit, non-interlaced PNGs are supported');
  const channels = { 6: 4, 2: 3, 3: 1, 0: 1, 4: 2 }[ihdr.color];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * channels;
  const px = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0, i = 0; y < ihdr.h; y++) {
    const filter = raw[i];
    const line = Buffer.from(raw.subarray(i + 1, i + 1 + stride));
    i += 1 + stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 255;
    }
    const row = [];
    for (let x = 0; x < ihdr.w; x++) {
      const o = x * channels;
      if (ihdr.color === 6) row.push([line[o], line[o + 1], line[o + 2], line[o + 3]]);
      else if (ihdr.color === 2) row.push([line[o], line[o + 1], line[o + 2], 255]);
      else if (ihdr.color === 3) {
        const k = line[o];
        row.push([palette[k * 3], palette[k * 3 + 1], palette[k * 3 + 2], alpha && k < alpha.length ? alpha[k] : 255]);
      } else if (ihdr.color === 0) row.push([line[o], line[o], line[o], 255]);
      else row.push([line[o], line[o], line[o], line[o + 1]]);
    }
    px.push(row);
    prev = line;
  }
  return px;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function writePng(file, px) {
  const h = px.length;
  const w = px[0].length;
  const raw = Buffer.alloc(h * (1 + w * 4));
  px.forEach((row, y) => {
    raw[y * (1 + w * 4)] = 0;
    row.forEach((p, x) => raw.set(p, y * (1 + w * 4) + 1 + x * 4));
  });
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(CRC(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]),
  );
}

// ---- art ------------------------------------------------------------------

const CLEAR = [0, 0, 0, 0];

function blank(size) {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => CLEAR));
}

// Crops a frame to its visible pixels.
function crop(px) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  px.forEach((row, y) =>
    row.forEach((p, x) => {
      if (p[3] === 0) return;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }),
  );
  return px.slice(minY, maxY + 1).map((row) => row.slice(minX, maxX + 1));
}

// Centers art in a size x size canvas at an integer scale.
function place(art, size, scale) {
  const out = blank(size);
  const w = art[0].length * scale;
  const h = art.length * scale;
  const ox = Math.floor((size - w) / 2);
  const oy = Math.floor((size - h) / 2);
  art.forEach((row, y) =>
    row.forEach((p, x) => {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) out[oy + y * scale + dy][ox + x * scale + dx] = p;
    }),
  );
  return out;
}

// Original fallback art (not from the sprite sheet).
const PALETTE = { '.': CLEAR, K: [47, 47, 46, 255], O: [214, 121, 65, 255], R: [157, 80, 33, 255], C: [255, 255, 255, 255] };
const HEAD = [
  '................',
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
  '................',
].map((line) => [...line].map((ch) => PALETTE[ch]));

// ---- main -------------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });
if (fs.existsSync(SHEET)) {
  const sheet = readPng(SHEET);
  const standing = crop(sheet.slice(0, FRAME).map((row) => row.slice(0, FRAME)));
  for (const [size, scale] of Object.entries(SPRITE_SCALE)) {
    const n = Number(size);
    const art = standing[0].length > n ? standing.map((row) => row.slice(row.length - n)) : standing;
    writePng(path.join(OUT, `icon-${n}.png`), place(art, n, scale));
  }
  console.log(`icons: Renard standing (${standing[0].length}x${standing.length} from the sprite sheet)`);
} else {
  for (const n of [16, 32, 48, 96, 128]) writePng(path.join(OUT, `icon-${n}.png`), place(HEAD, n, Math.floor(n / 16)));
  console.log('icons: sprite sheet not found, used the fallback fox head');
}
