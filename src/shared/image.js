// Images attached to a question: a region of the screen, or a picture pasted
// or dropped into the bubble. Each is scaled to a size the providers read
// well and encoded as base64. Shared by the background script (screen
// captures) and the bubble frame (pasted and dropped images).
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  // Anthropic reads images up to 1568 px on the long edge and about 1.15
  // megapixels without scaling them down first, which costs about 1,600
  // tokens. The other providers accept at least that much.
  const MAX_EDGE = 1568;
  const MAX_PIXELS = 1150000;
  // PNG keeps text sharp. A PNG larger than this is sent as JPEG instead,
  // which keeps its base64 under Anthropic's 5 MB limit per image.
  const MAX_PNG_BYTES = 3.5e6;
  const MAX_DATA_CHARS = Math.ceil((MAX_PNG_BYTES * 4) / 3) + 4;
  const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

  // A pasted or dropped image larger than this, by its header, is refused
  // before it is decoded: a 400 KB PNG can declare 20000 × 20000 pixels and
  // take gigabytes to unpack.
  R.MAX_DECODE_PIXELS = 50e6;

  // An image's size from its header: PNG, GIF, WebP or JPEG. null when the
  // header can't be read.
  R.imageDimensions = async function (blob) {
    const b = new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer());
    const at = (i) => (i < b.length ? b[i] : 0);
    const u16be = (i) => (at(i) << 8) | at(i + 1);
    const u32be = (i) => at(i) * 2 ** 24 + (at(i + 1) << 16) + (at(i + 2) << 8) + at(i + 3);
    const u16le = (i) => at(i) | (at(i + 1) << 8);
    const u24le = (i) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
    const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
    if (ascii(1, 3) === 'PNG') return { width: u32be(16), height: u32be(20) };
    if (ascii(0, 3) === 'GIF') return { width: u16le(6), height: u16le(8) };
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
      const chunk = ascii(12, 4);
      if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = (at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24)) >>> 0;
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1 };
      return null;
    }
    if (at(0) === 0xff && at(1) === 0xd8) {
      // The first start-of-frame marker holds the size.
      let i = 2;
      while (i + 8 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        if (marker === 0xff) {
          i++;
          continue;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: u16be(i + 7), height: u16be(i + 5) };
        }
        i += 2 + u16be(i + 2);
      }
    }
    return null;
  };

  // Types a pasted or dropped file may have. Every image is re-encoded, so
  // providers only ever receive PNG or JPEG.
  R.IMAGE_INPUT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  // The size an image of w × h pixels is sent at: scaled down to fit both
  // limits, never up.
  R.fitImage = function (w, h) {
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  };

  // An attached image as the content script and background script accept it.
  R.isAttachedImage = function (img) {
    return (
      Boolean(img) &&
      typeof img === 'object' &&
      (img.mediaType === 'image/png' || img.mediaType === 'image/jpeg') &&
      typeof img.data === 'string' &&
      img.data.length <= MAX_DATA_CHARS &&
      BASE64.test(img.data) &&
      Number.isInteger(img.width) &&
      Number.isInteger(img.height) &&
      img.width > 0 &&
      img.height > 0 &&
      img.width <= MAX_EDGE &&
      img.height <= MAX_EDGE
    );
  };

  // base64 data as a Blob of the given type.
  R.base64Blob = function (data, type) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  };

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  // source: a Blob or an ImageBitmap. crop: { x, y, width, height } in the
  // source's pixels, or the whole image when left out. Resolves to
  // { mediaType, data, width, height }.
  R.prepareImage = async function (source, crop) {
    if (source instanceof Blob) {
      const size = await R.imageDimensions(source);
      if (!size || !(size.width > 0 && size.height > 0)) throw Object.assign(new Error("Couldn't read that image."), { code: 'unreadable' });
      if (size.width * size.height > R.MAX_DECODE_PIXELS) throw Object.assign(new Error('That image is too large to attach.'), { code: 'tooLarge' });
    }
    const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
    try {
      const c = crop || { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
      const x = Math.min(Math.max(0, Math.round(c.x)), bitmap.width - 1);
      const y = Math.min(Math.max(0, Math.round(c.y)), bitmap.height - 1);
      const w = Math.min(Math.max(1, Math.round(c.width)), bitmap.width - x);
      const h = Math.min(Math.max(1, Math.round(c.height)), bitmap.height - y);
      const size = R.fitImage(w, h);
      const canvas = new OffscreenCanvas(size.width, size.height);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, x, y, w, h, 0, 0, size.width, size.height);
      let blob = await canvas.convertToBlob({ type: 'image/png' });
      if (blob.size > MAX_PNG_BYTES) {
        // JPEG has no transparency, so transparent parts go white, not black.
        const flat = new OffscreenCanvas(size.width, size.height);
        const fctx = flat.getContext('2d');
        fctx.fillStyle = '#fff';
        fctx.fillRect(0, 0, size.width, size.height);
        fctx.drawImage(canvas, 0, 0);
        blob = await flat.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      }
      return { mediaType: blob.type, data: toBase64(await blob.arrayBuffer()), width: size.width, height: size.height };
    } finally {
      if (source instanceof Blob) bitmap.close();
    }
  };
})();
