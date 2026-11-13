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

  function luminance([r, g, b]) {
    const lin = (c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  R.adapterUtils = {
    // Theme from explicit page hints first, then the page background.
    themeFromPage() {
      const html = document.documentElement;
      if (html.classList.contains('dark')) return 'dark';
      if (html.classList.contains('light')) return 'light';
      for (const attr of ['data-mode', 'data-theme', 'data-color-mode']) {
        const v = (html.getAttribute(attr) || '').toLowerCase();
        if (v.includes('dark')) return 'dark';
        if (v.includes('light')) return 'light';
      }
      const scheme = (html.style.colorScheme || '').trim();
      if (scheme === 'dark' || scheme === 'light') return scheme;
      for (const el of [document.body, html]) {
        if (!el) continue;
        const c = parseColor(getComputedStyle(el).backgroundColor);
        if (c && c[3] > 0.5) return luminance(c) < 0.35 ? 'dark' : 'light';
      }
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    },

    // Drops nodes nested inside another matched node.
    outermost(nodes) {
      const list = Array.from(nodes);
      return list.filter((n) => !list.some((other) => other !== n && other.contains(n)));
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

    visibleRect(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    },
  };
})();
