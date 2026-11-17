// Helpers shared by the site adapters. An adapter provides:
//   readChat()     -> [{ role: 'user' | 'assistant', text }]; throws when the
//                     page looks like a chat but its messages can't be found
//   composerRect() -> DOMRect of the site's message input, or null
//   theme()        -> 'light' | 'dark'
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});
  R.adapters = R.adapters || {};

  function parseColor(value) {
    const m = String(value).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
    if (!m) return null;
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith('%')) a /= 100;
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }

  // Any CSS color (rgb, hsl, oklch, lab, color(), color-mix() …) as
  // [r, g, b, a] in sRGB. Plain rgb() is read directly; anything else is
  // painted on a 1×1 canvas and read back.
  let probe = null;
  function toRgba(value) {
    const direct = parseColor(value);
    if (direct) return direct;
    try {
      probe = probe || new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      probe.fillStyle = '#010203';
      probe.fillStyle = value;
      if (probe.fillStyle === '#010203' && !/#010203/i.test(value)) return null; // not a color
      probe.clearRect(0, 0, 1, 1);
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    } catch {
      return null;
    }
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

  R.adapterUtils = {
    // Theme from explicit page hints first, then the page background, then
    // the page's color-scheme (which picks the browser's canvas color when
    // nothing paints a background).
    themeFromPage() {
      const html = document.documentElement;
      if (html.classList.contains('dark')) return 'dark';
      if (html.classList.contains('light')) return 'light';
      for (const attr of ['data-mode', 'data-theme', 'data-color-mode']) {
        const v = (html.getAttribute(attr) || '').toLowerCase();
        // Whole words, so "highlight" isn't read as light.
        if (/\bdark\b/.test(v)) return 'dark';
        if (/\blight\b/.test(v)) return 'light';
      }
      const scheme = (html.style.colorScheme || '').trim();
      if (scheme === 'dark' || scheme === 'light') return scheme;
      const shade = (c) => (luminance(c) < 0.35 ? 'dark' : 'light');
      const edges = edgeBackgrounds().map(shade);
      if (edges.length === 2 && edges[0] === edges[1]) return edges[0];
      for (const el of [document.body, html]) {
        if (!el) continue;
        const c = backgroundOf(el);
        if (c) return shade(c);
      }
      if (edges.length) return edges[0];
      // <meta name="color-scheme"> sets the canvas too, without showing in
      // the computed style.
      let used = getComputedStyle(html).colorScheme || '';
      if (!used || used === 'normal') {
        const meta = document.querySelector('meta[name="color-scheme"]');
        used = (meta && meta.getAttribute('content')) || '';
      }
      const dark = /\bdark\b/.test(used);
      const light = /\blight\b/.test(used);
      if (dark && !light) return 'dark';
      if (dark && light) return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      return 'light';
    },

    // Drops nodes nested inside another matched node. Each node's
    // ancestors are checked against the set, so a long chat stays fast.
    outermost(nodes) {
      const list = Array.from(nodes);
      const set = new Set(list);
      return list.filter((n) => {
        for (let p = n.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
        return true;
      });
    },

    textOf(el) {
      return (el.innerText || el.textContent || '')
        .replace(/ /g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },

    // Joins consecutive pieces from the same speaker into one turn.
    mergeTurns(turns) {
      const out = [];
      for (const t of turns) {
        if (!t.text) continue;
        const prev = out[out.length - 1];
        if (prev && prev.role === t.role) prev.text += `\n\n${t.text}`;
        else out.push({ role: t.role, text: t.text });
      }
      return out;
    },

    // The most recent turns within a generous budget, so a huge chat never
    // makes a huge message (the background trims to its real limit).
    capTurns(turns, maxChars = 200000) {
      const out = [];
      let used = 0;
      for (let i = turns.length - 1; i >= 0 && used < maxChars; i--) {
        const text = turns[i].text.slice(-(maxChars - used));
        used += text.length;
        out.unshift({ role: turns[i].role, text });
      }
      return out;
    },

    visibleRect(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    },
  };
})();
