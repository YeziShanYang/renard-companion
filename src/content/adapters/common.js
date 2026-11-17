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

  // ---- message text ------------------------------------------------------

  // Elements whose text is part of the interface, not the message: buttons
  // ("Copy", "Edit", "Thought for 12s"), form controls, media and scripts.
  const NOT_TEXT = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'svg']);

  // Clipped to nothing: clip: rect() on a positioned box, a clip-path
  // inset() whose sides meet (in percentages), or a circle or ellipse of no
  // size.
  function clippedAway(cs) {
    if ((cs.position === 'absolute' || cs.position === 'fixed') && cs.clip.startsWith('rect(')) {
      const [top, right, bottom, left] = (cs.clip.match(/-?[\d.]+/g) || []).map(Number);
      if (right - left <= 1 || bottom - top <= 1) return true;
    }
    const path = cs.clipPath || '';
    const inset = /^inset\(([^)]*?)(?:\s+round\b[^)]*)?\)/.exec(path);
    if (inset) {
      const v = inset[1].trim().split(/\s+/);
      // Percentages, and zero in any unit (the browser writes 0 as 0px).
      if (v.every((x) => /^[\d.]+%$/.test(x) || /^0+(?:\.0+)?[a-z]*$/.test(x))) {
        const [t, r = t, b = t, l = r] = v.map(parseFloat);
        if (t + b >= 100 || l + r >= 100) return true;
      }
    }
    return /^(?:circle|ellipse)\(\s*0(?:px|%)?[\s)]/.test(path);
  }

  // Shrunk to nothing by a transform or the scale property (scale(0)), or
  // made see-through by a filter (opacity(0)).
  function scaledAway(cs) {
    if (/\bopacity\(\s*0+(?:\.0+)?%?\s*\)/.test(cs.filter || '')) return true;
    if (cs.scale && cs.scale !== 'none' && cs.scale.split(/\s+/).some((v) => Math.abs(parseFloat(v)) < 1e-3)) return true;
    const t = cs.transform;
    if (!t || t === 'none') return false;
    const n = t.slice(t.indexOf('(') + 1).split(',').map(Number);
    const det = t.startsWith('matrix3d(') ? n[0] * n[5] - n[1] * n[4] : n[0] * n[3] - n[1] * n[2];
    return Math.abs(det) < 1e-3;
  }

  // The page's horizontal scroll range in page coordinates: on a
  // right-to-left page it reaches left of zero. Read once per read.
  function scrollRange(memo) {
    if (!memo.range) {
      const doc = document.documentElement;
      const rtl = getComputedStyle(document.body || doc).direction === 'rtl';
      memo.range = rtl ? [-(doc.scrollWidth - doc.clientWidth), doc.clientWidth] : [0, doc.scrollWidth];
    }
    return memo.range;
  }

  // Transparent content that a page fades in once it's scrolled to: still
  // below the window, with an opacity transition or animation, or an opacity
  // a script set (as animation libraries do) or announced in will-change.
  function fadesInLater(el, cs) {
    const animated =
      cs.animationName !== 'none' ||
      (/\b(opacity|all)\b/.test(cs.transitionProperty) && /[1-9]/.test(cs.transitionDuration)) ||
      el.style.opacity !== '' ||
      /\b(opacity|transform)\b/.test(cs.willChange);
    return animated && el.getBoundingClientRect().top >= innerHeight;
  }

  // Elements nobody can see, with everything in them. A page can hide text
  // from the user and still have it read to the model (instructions aimed
  // at the model, say), so what isn't shown isn't read.
  //
  // aria-hidden hides nothing on screen. In a chat it marks icons and a
  // collapsed thinking block, so chats skip it. A page often puts its
  // visible text there, with a copy for screen readers in a clipped box
  // (prices, ratings), so pages read it (page: true).
  //
  // at: what the walker knows about the element's ancestors (see
  // messageText): inside a scroller, anything can be scrolled to, and
  // outside a box that clips its overflow, nothing shows.
  function unread(el, cs, page, at, memo) {
    if (NOT_TEXT.has(el.tagName) || el.hidden) return true;
    if (!page && el.getAttribute('aria-hidden') === 'true') return true;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.contentVisibility === 'hidden') return true;
    if ((parseFloat(cs.opacity) < 0.05 && !fadesInLater(el, cs)) || clippedAway(cs) || scaledAway(cs)) return true;
    // A box of a pixel or less that clips what overflows it:
    // screen-reader-only text ("ChatGPT said:"), or a collapsed block (a
    // closed thinking block).
    if ((parseFloat(cs.width) <= 1 && /hidden|clip/.test(cs.overflowX)) || (parseFloat(cs.height) <= 1 && /hidden|clip/.test(cs.overflowY))) return true;
    // Positioned or moved where nobody can scroll to it: off the window
    // (fixed), out of the scroller it's in, or off the page.
    if (cs.position === 'fixed') {
      const r = boxOf(el, memo);
      return r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight;
    }
    if (cs.position !== 'static' || cs.transform !== 'none' || (cs.translate && cs.translate !== 'none')) {
      const r = reach(el, cs, boxOf(el, memo));
      if (at.scroller) return outside(r, at.scroller);
      const [minX, maxX] = scrollRange(memo);
      return r.right + scrollX <= minX || r.bottom + scrollY <= 0 || r.left + scrollX >= maxX;
    }
    return false;
  }

  // A box together with what overflows it where that shows (overflow:
  // visible): a carousel track moved left of the page has its visible slide
  // hanging out of it. Overflow a box clips or scrolls doesn't show outside
  // it, so it doesn't count. Overflow goes right (left in right-to-left
  // text) and down.
  function reach(el, cs, r) {
    const width = cs.overflowX === 'visible' ? Math.max(r.width, el.scrollWidth) : r.width;
    const height = cs.overflowY === 'visible' ? Math.max(r.height, el.scrollHeight) : r.height;
    const left = cs.direction === 'rtl' ? r.right - width : r.left;
    return { left, right: left + width, top: r.top, bottom: r.top + height, width, height };
  }

  // A box (rect) with no part inside an area ({ left, right, top, bottom }).
  // Boxes of no size (display: contents) are never outside.
  function outside(r, area) {
    return (r.width > 0 || r.height > 0) && (r.right <= area.left || r.left >= area.right || r.bottom <= area.top || r.top >= area.bottom);
  }

  // The area a scroller's content can be scrolled into view from: its box,
  // grown by what it can scroll to. Content overflows to the right (or to
  // the left in right-to-left text) and down, never the other way.
  function scrollArea(el, cs, memo) {
    const r = boxOf(el, memo);
    const left = cs.direction === 'rtl' ? r.right - el.scrollLeft - el.scrollWidth : r.left - el.scrollLeft;
    const top = r.top - el.scrollTop;
    return { left, right: left + el.scrollWidth, top, bottom: top + el.scrollHeight };
  }

  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 12;

  // The background an element paints, as far as its own style tells:
  // undefined when it paints none, null when it paints something its text
  // could show against whatever its color (an image, or a see-through
  // color over what's below), or an opaque color.
  function ownBackground(cs) {
    if (cs.display === 'contents') return undefined; // has no box to paint
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
    const c = toRgba(cs.backgroundColor);
    if (!c || c[3] < 0.05) return undefined;
    return c[3] > 0.9 ? c : null;
  }

  // What's painted behind an element's text: its own background, otherwise
  // what's behind its parent. null when unknown.
  function behind(cs, parentBg) {
    const own = ownBackground(cs);
    return own === undefined ? parentBg : own;
  }

  // Behind the root: the first ancestor that paints, or the page's own
  // white canvas. A page that allows a dark canvas (in its CSS or a
  // <meta name="color-scheme">, as Chrome's plain-text view does) gets one
  // when the system is dark, with light default text, so the canvas is
  // unknown there.
  function backgroundAbove(el) {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const own = ownBackground(getComputedStyle(node));
      if (own !== undefined) return own;
    }
    const meta = document.querySelector('meta[name="color-scheme"]');
    const scheme = `${getComputedStyle(document.documentElement).colorScheme || ''} ${(meta && meta.getAttribute('content')) || ''}`;
    return /\bdark\b/.test(scheme) ? null : [255, 255, 255, 1];
  }

  const MEDIA = 'img, picture, video, canvas, svg, iframe, object, embed';

  // Past this many checks in one read, the rest of the text matching its
  // background counts as hidden, so a page full of it can't stall the read.
  // Only elements with text of their own are checked.
  const MAX_UNDER_CHECKS = 5000;

  // What one read has already looked up for paintedUnder: per parent, the
  // things its children paint ([{ node, own }], own as ownBackground gives
  // it, null for media); per element, its ::before/::after backgrounds and
  // its box.
  function paintMemo() {
    return { parents: new Map(), layers: new Map(), boxes: new Map(), checks: 0 };
  }

  function paintersIn(parent, memo) {
    let list = memo.parents.get(parent);
    if (list) return list;
    list = [];
    for (const child of parent.children) {
      if (child.closest(R.HOST_SELECTOR || '[data-renard-companion]')) continue;
      if (child.matches(MEDIA)) {
        list.push({ node: child, own: null });
      } else {
        const own = ownBackground(getComputedStyle(child));
        if (own !== undefined) list.push({ node: child, own });
      }
      for (const media of child.querySelectorAll(MEDIA)) list.push({ node: media, own: null });
    }
    memo.parents.set(parent, list);
    return list;
  }

  function layersOf(node, memo) {
    let list = memo.layers.get(node);
    if (list) return list;
    list = [];
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(node, pseudo);
      if (cs.content === 'none' || cs.content === 'normal') continue;
      const own = ownBackground(cs);
      if (own !== undefined) list.push(own);
    }
    memo.layers.set(node, list);
    return list;
  }

  function boxOf(node, memo) {
    let r = memo.boxes.get(node);
    if (!r) memo.boxes.set(node, (r = node.getBoundingClientRect()));
    return r;
  }

  // Whether something other than the ancestors' backgrounds is painted
  // under an element, which the ancestors alone don't tell: a cover image or
  // video, an overlay box beside the text, or an ancestor's ::before layer.
  // Only boxes overlapping the element count.
  function paintedUnder(el, color, memo) {
    if (++memo.checks > MAX_UNDER_CHECKS) return false;
    const box = boxOf(el, memo);
    const overlaps = (n) => {
      const r = boxOf(n, memo);
      return r.width > 0 && r.height > 0 && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
    };
    const shows = (own) => own === null || !near(own, color);
    for (let node = el; node && node.parentElement; node = node.parentElement) {
      if (node !== el && layersOf(node, memo).some(shows)) return true;
      for (const p of paintersIn(node.parentElement, memo)) {
        if (p.node === node || node.contains(p.node)) continue;
        if (shows(p.own) && overlaps(p.node)) return true;
      }
    }
    return false;
  }

  // An element's own text (not its children's) that can't be read: under
  // about 2 px, transparent, indented far off the page, or the color of
  // what's behind it with nothing else painted under it. Text painted with
  // a background (background-clip: text), outlined, shadowed or blended
  // shows whatever its color.
  function quietText(el, cs, bg, clipText, memo) {
    if (parseFloat(cs.fontSize) < 2 || parseFloat(cs.textIndent) <= -999) return true;
    if (clipText || parseFloat(cs.webkitTextStrokeWidth) > 0 || (cs.textShadow && cs.textShadow !== 'none') || (cs.mixBlendMode && cs.mixBlendMode !== 'normal')) return false;
    const c = toRgba(cs.webkitTextFillColor || cs.color);
    if (!c) return false;
    if (c[3] < 0.05) return true;
    return Boolean(bg) && near(c, bg) && !paintedUnder(el, c, memo);
  }

  const clipsText = (cs) => cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text';
  const keepsSpace = (cs) => /^(pre|break-spaces)/.test(cs.whiteSpace);
  const FENCE = '```';

  // The text of a chat message or page as the reader sees it, like
  // innerText without the interface inside it or text that isn't shown.
  // Code blocks come out fenced, without their header, KaTeX math as its TeX
  // source, and list items with their markers, indented by nesting. Reading
  // stops once there are limit characters.
  //
  // The text is kept in pieces, with the last few characters copied aside
  // for the checks, so each check costs the same however long the text
  // already is.
  function messageText(root, limit = Infinity, { page = false } = {}) {
    const parts = [];
    let tail = ''; // the last characters written
    let total = 0;
    let afterMarker = false; // a list marker was the last thing written
    const TAIL = 64;
    const write = (s) => {
      if (!s) return;
      parts.push(s);
      total += s.length;
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
        total -= last.length - kept.length;
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
    const memo = paintMemo();
    // at: { el, cs, pre (keep whitespace), depth (list nesting), bg (what's
    // behind), clip (text painted with a background), quiet (the element's
    // own text can't be read; worked out at its first text) }
    const walk = (node, at) => {
      // A closed <details> shows only its summary.
      const closed = node.tagName === 'DETAILS' && !node.open;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (total >= limit) return;
        if (closed && child.tagName !== 'SUMMARY') continue;
        if (child.nodeType === 3) {
          // Worked out where text is written: the element holding it may
          // show even when an ancestor's box doesn't (a carousel track
          // moved left, with its visible slide inside the frame).
          if (at.quiet === undefined && /\S/.test(child.data)) {
            at.quiet = (at.box !== null && outside(boxOf(at.el, memo), at.box)) || quietText(at.el, at.cs, at.bg, at.clip, memo);
          }
          if (at.quiet) continue;
          let t = child.data;
          if (!at.pre) {
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
        if (unread(el, cs, page, at, memo)) continue;
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
          const indent = '  '.repeat(Math.max(0, at.depth - 1));
          if (list.tagName === 'UL') {
            write(indent + '- ');
          } else {
            const n = counts.has(list) ? counts.get(list) + 1 : Number.isFinite(list.start) ? list.start : 1;
            counts.set(list, n);
            write(`${indent}${n}. `);
          }
          afterMarker = true;
        }
        walk(el, inside(at, el, cs));
        if (block) endLines(lines);
      }
    };
    const inside = (at, el, cs) => {
      // <html> and <body> pass their overflow to the window, which the
      // off-page check covers. A box scrolls only on an axis that's auto or
      // scroll and actually overflows: overflow-x: hidden makes overflow-y
      // compute to auto, and a wrapper like that clips, it doesn't scroll.
      const own = el !== document.documentElement && el !== document.body;
      const scrolls =
        own &&
        ((/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) || (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1));
      const clips = own && !scrolls && /hidden|clip|auto|scroll/.test(`${cs.overflowX} ${cs.overflowY}`);
      return {
        el,
        cs,
        pre: at.pre || keepsSpace(cs),
        depth: at.depth + (el.tagName === 'UL' || el.tagName === 'OL' ? 1 : 0),
        bg: behind(cs, at.bg),
        clip: at.clip || clipsText(cs),
        quiet: undefined,
        // The innermost scroller's reach, and the innermost clipping box.
        // What a scroller holds can be scrolled into view, so a clip
        // outside it no longer decides.
        scroller: scrolls ? scrollArea(el, cs, memo) : at.scroller,
        box: scrolls ? null : clips ? boxOf(el, memo) : at.box,
      };
    };
    walk(root, inside({ pre: false, depth: 0, bg: backgroundAbove(root), clip: false, scroller: null, box: null }, root, getComputedStyle(root)));
    return parts.join('');
  }

  // Non-breaking spaces as spaces, and icon-font glyphs (private-use
  // characters, which now come through aria-hidden icons on pages) left out.
  function tidy(text) {
    return text
      .replace(/ /g, ' ')
      .replace(/[-]/g, '')
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

    // The text of a message or page, minus interface and hidden text. Stops
    // reading once there are limit characters.
    // options.page: reading a web page rather than a chat (see unread).
    messageText(el, limit, options) {
      return tidy(messageText(el, limit, options));
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
