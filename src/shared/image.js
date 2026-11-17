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
