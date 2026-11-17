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

  // ---- message text ------------------------------------------------------

  // Elements whose text is part of the interface, not the message: buttons
  // ("Copy", "Edit", "Thought for 12s"), form controls, media and scripts.
  const NOT_TEXT = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'svg']);

  function unread(el, cs) {
    if (NOT_TEXT.has(el.tagName) || el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.contentVisibility === 'hidden') return true;
    // Screen-reader-only text ("ChatGPT said:"): a box of a pixel or less.
    if ((cs.position === 'absolute' || cs.position === 'fixed') && parseFloat(cs.width) <= 1 && parseFloat(cs.height) <= 1) return true;
    // Collapsed: no height, and nothing shown past it (a closed thinking block).
    return parseFloat(cs.height) === 0 && /hidden|clip/.test(cs.overflowY);
  }

  const keepsSpace = (cs) => /^(pre|break-spaces)/.test(cs.whiteSpace);
  const FENCE = '```';

  // The text of one chat message as the reader sees it, like innerText
  // without the interface inside the message. Code blocks come out fenced,
  // without their header, KaTeX math as its TeX source, and list items with
  // their markers, indented by nesting.
  //
  // The text is kept in pieces, with the last few characters copied aside
  // for the checks, so each check costs the same however long the message
  // already is.
  function messageText(root) {
    const parts = [];
    let tail = ''; // the last characters written
    let afterMarker = false; // a list marker was the last thing written
    const TAIL = 64;
    const write = (s) => {
      if (!s) return;
      parts.push(s);
      tail = s.length >= TAIL ? s.slice(-TAIL) : (tail + s).slice(-TAIL);
      afterMarker = false;
    };
    const refreshTail = () => {
      tail = '';
      for (let i = parts.length - 1; i >= 0 && tail.length < TAIL; i--) tail = parts[i].slice(-(TAIL - tail.length)) + tail;
    };
    // Drops the last n characters, or trailing spaces and tabs (n = null).
    const dropEnd = (n) => {
      while (parts.length) {
        const last = parts[parts.length - 1];
        const kept = n === null ? last.replace(/[ \t]+$/, '') : last.slice(0, Math.max(0, last.length - n));
        if (n !== null) n -= last.length - kept.length;
        if (kept) parts[parts.length - 1] = kept;
        else parts.pop();
        if (kept || n === 0) break;
      }
      refreshTail();
    };
    const endLines = (n) => {
      // Nothing between a list marker and its item's first paragraph.
      if (!parts.length || afterMarker) return;
      if (/[ \t]$/.test(tail)) dropEnd(null);
      const have = /\n*$/.exec(tail)[0].length;
      if (have < n) write('\n'.repeat(n - have));
    };
    const counts = new Map(); // ordered list -> number of its last item
    const walk = (node, pre, depth) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          let t = child.data;
          if (!pre) {
            t = t.replace(/[ \t\n\r\f]+/g, ' ');
            if (!parts.length || /[ \n\t]$/.test(tail)) t = t.replace(/^ /, '');
          }
          if (t) {
            const marker = afterMarker;
            write(t);
            afterMarker = marker && t === ' ';
          }
          continue;
        }
        if (child.nodeType !== 1) continue;
        const el = child;
        if (el.tagName === 'BR') {
          write('\n');
          continue;
        }
        const cs = getComputedStyle(el);
        if (unread(el, cs)) continue;
        if (el.classList.contains('katex')) {
          const tex = el.querySelector('annotation[encoding="application/x-tex"]');
          if (tex) {
            const source = tex.textContent.trim();
            if (el.parentElement && el.parentElement.classList.contains('katex-display')) {
              endLines(1);
              write('$$' + source + '$$');
              endLines(1);
            } else {
              write('$' + source + '$');
            }
            continue;
          }
        }
        if (el.tagName === 'PRE') {
          const code = el.querySelector('code');
          if (code) {
            const lang = (/(?:^|\s)language-([\w+#.-]+)/.exec(code.className) || [])[1] || '';
            endLines(1);
            // A language label shown above the block (claude.ai puts it
            // outside the <pre>) is already in the fence.
            const label = lang.toLowerCase() + '\n';
            // The tail holds more than the label unless the label is all
            // there is, so the label is on a line of its own when what
            // comes before it ends a line or is nothing.
            if (lang && label.length < TAIL && tail.toLowerCase().endsWith(label)) {
              const before = tail.slice(0, -label.length);
              if (!before || before.endsWith('\n')) dropEnd(label.length);
            }
            write(FENCE + lang + '\n' + code.textContent.replace(/\n$/, '') + '\n' + FENCE);
            endLines(1);
            continue;
          }
        }
        const display = cs.display;
        const block = !display.startsWith('inline') && display !== 'contents' && display !== 'table-cell' && !display.startsWith('ruby');
        // innerText puts a blank line around paragraphs and headings.
        const lines = /^(P|H[1-6])$/.test(el.tagName) ? 2 : 1;
        if (block) endLines(lines);
        else if (display === 'table-cell' && parts.length && !tail.endsWith('\n')) write('\t');
        // List markers, which innerText leaves out.
        const list = el.tagName === 'LI' ? el.parentElement : null;
        if (list && (list.tagName === 'UL' || list.tagName === 'OL')) {
          const indent = '  '.repeat(Math.max(0, depth - 1));
          if (list.tagName === 'UL') {
            write(indent + '- ');
          } else {
            const n = counts.has(list) ? counts.get(list) + 1 : Number.isFinite(list.start) ? list.start : 1;
            counts.set(list, n);
            write(`${indent}${n}. `);
          }
          afterMarker = true;
        }
        walk(el, pre || keepsSpace(cs), depth + (el.tagName === 'UL' || el.tagName === 'OL' ? 1 : 0));
        if (block) endLines(lines);
      }
    };
    walk(root, keepsSpace(getComputedStyle(root)), 0);
    return parts.join('');
  }

  function tidy(text) {
    return text
      .replace(/ /g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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

    messageText(el) {
      return tidy(messageText(el));
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
