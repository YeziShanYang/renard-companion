// Colors as the page paints them: any CSS color as [r, g, b, a], what an
// element's background is, and how light a color is. Used to tell the
// page's theme (common.js) and to find text drawn in its background's color
// (visibility.js).
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  function parseColor(value) {
    const m = String(value).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
    if (!m) return null;
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith('%')) a /= 100;
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }

  // Any CSS color (rgb, hsl, oklch, lab, color(), color-mix() …) as
  // [r, g, b, a] in sRGB. Plain rgb() is read directly; anything else is
  // painted on a 1×1 canvas and read back, once per color (a page reading
  // every element of a Tailwind v4 site meets the same few oklch() colors
  // thousands of times).
  let probe = null;
  const painted = new Map();
  function toRgba(value) {
    const direct = parseColor(value);
    if (direct) return direct;
    if (painted.has(value)) return painted.get(value);
    let out = null;
    try {
      probe = probe || new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      probe.fillStyle = '#010203';
      probe.fillStyle = value;
      if (probe.fillStyle !== '#010203' || /#010203/i.test(value)) {
        probe.clearRect(0, 0, 1, 1);
        probe.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
        out = [r, g, b, a / 255];
      }
    } catch {
      out = null;
    }
    if (painted.size > 500) painted.clear();
    painted.set(value, out);
    return out;
  }

  const COLOR_FN = /(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^()]*\)|#[0-9a-f]{3,8}\b/gi;

  // A gradient's opaque color stops, averaged.
  function gradientColor(image) {
    if (!/gradient\(/.test(image)) return null;
    const stops = (image.match(COLOR_FN) || []).map(toRgba).filter((c) => c && c[3] > 0.5);
    if (!stops.length) return null;
    const avg = [0, 1, 2].map((i) => stops.reduce((sum, c) => sum + c[i], 0) / stops.length);
    return [...avg, 1];
  }

  function backgroundOf(node) {
    const cs = getComputedStyle(node);
    const c = toRgba(cs.backgroundColor);
    if (c && c[3] > 0.5) return c;
    return gradientColor(cs.backgroundImage || '');
  }

  function opaqueBackground(el) {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const c = backgroundOf(node);
      if (c) return c;
    }
    return null;
  }

  // What shows behind the fox and bubble: the page near each side, which a
  // full-page wrapper often paints rather than <body>. Renard's own element
  // is skipped.
  function edgeBackgrounds() {
    const out = [];
    for (const x of [8, innerWidth - 8]) {
      const el = document.elementsFromPoint(x, innerHeight / 2).find((e) => !e.closest(R.HOST_SELECTOR || 'renard-companion'));
      const c = el && opaqueBackground(el);
      if (c) out.push(c);
    }
    return out;
  }

  function luminance([r, g, b]) {
    const lin = (c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  R.colors = { toRgba, backgroundOf, edgeBackgrounds, luminance };
})();
