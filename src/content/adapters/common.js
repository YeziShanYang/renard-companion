// Helpers shared by the site adapters. An adapter provides:
//   readChat()     -> [{ role: 'user' | 'assistant', text }]; throws when the
//                     page looks like a chat but its messages can't be found
//   composerRect() -> DOMRect of the site's message input, or null
//   theme()        -> 'light' | 'dark'
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});
  R.adapters = R.adapters || {};

  const { backgroundOf, edgeBackgrounds, luminance } = R.colors;

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

    // The text of a message or page, minus interface and hidden text. Stops
    // reading once there are limit characters.
    // options.page: reading a web page rather than a chat (see unread in
    // visibility.js).
    messageText(el, limit, options) {
      return R.readText(el, limit, options);
    },

    // Chat turns from message nodes, read newest first until there is more
    // than enough text, so a very long chat doesn't read every old message.
    // read(node) returns { role, text } or null.
    readTurns(nodes, read, maxChars = 200000) {
      const turns = [];
      let used = 0;
      for (let i = nodes.length - 1; i >= 0 && used < maxChars; i--) {
        const t = read(nodes[i]);
        if (!t || !t.text) continue;
        turns.push(t);
        used += t.text.length;
      }
      return this.mergeTurns(turns.reverse());
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
