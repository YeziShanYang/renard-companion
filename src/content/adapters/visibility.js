// Whether the reader can see an element or its text, for reading a chat or
// page the way it shows (text.js). Hidden text is left out, since a page
// could otherwise use it to slip instructions to the model: elements that
// aren't drawn, are clipped, scaled or faded away, moved off the page or
// out of their clipping box, and text the color of what's behind it.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});
  const { toRgba } = R.colors;

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

  R.visibility = { unread, outside, boxOf, quietText, behind, backgroundAbove, clipsText, keepsSpace, scrollArea, paintMemo };
})();
