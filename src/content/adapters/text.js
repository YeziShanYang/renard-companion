// The text of a chat message or page as the reader sees it (see
// messageText below), built on the checks in visibility.js.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});
  const { unread, outside, boxOf, quietText, behind, backgroundAbove, clipsText, keepsSpace, scrollArea, paintMemo } = R.visibility;

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

  // The text of a message or page, minus interface and hidden text, tidied.
  R.readText = function (root, limit, options) {
    return tidy(messageText(root, limit, options));
  };
})();
