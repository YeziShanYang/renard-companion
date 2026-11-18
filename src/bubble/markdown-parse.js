// Markdown for answers, parsed into a plain tree of blocks and inline
// nodes (unit tested in Node). markdown-render.js turns the tree into DOM.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;
  // The text after the hashes; closing hashes are trimmed in headingText()
  // (a lazy match with trailing \s* backtracked on a long run of spaces).
  const HEADING = /^\s{0,3}(#{1,6})(?:[ \t]+(.*))?$/;
  const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>/;
  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  // Tested on a trimmed line (overlapping \s* on a line of spaces backtracks).
  const TABLE_SEP = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
  // Display math on its own lines: $$ … $$ or \[ … \].
  const MATH_BLOCK = /^\s{0,3}(\$\$|\\\[)(.*)$/;
  const TASK = /^\[([ xX])\]\s+(.*)$/;

  const isBlank = (l) => /^\s*$/.test(l);
  const lead = (l) => l.match(/^ */)[0].length;

  // "Title ##  " is "Title": trailing spaces, then closing hashes after a
  // space, go.
  function headingText(text) {
    let t = text.trimEnd();
    let k = t.length;
    while (k > 0 && t[k - 1] === '#') k--;
    if (k < t.length && (k === 0 || t[k - 1] === ' ' || t[k - 1] === '\t')) t = t.slice(0, k).trimEnd();
    return t;
  }

  // A backtick fence's info string can't hold a backtick, so a line like
  // "```bash npm i``` then restart" is inline code, not a fence.
  function fenceOf(line) {
    const m = line.match(FENCE);
    if (m && m[2][0] === '`' && line.slice(m[0].length).includes('`')) return null;
    return m;
  }

  function startsBlock(line) {
    return Boolean(fenceOf(line)) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line) || MATH_BLOCK.test(line);
  }

  // A table starts at lines[i]: a row with a pipe, then a separator row. A
  // one-cell separator must match the header, so "a | b" over a lone "-"
  // isn't a table; models also write separators with more or fewer cells.
  function startsTable(lines, i) {
    const line = lines[i];
    const sep = lines[i + 1];
    if (!line.includes('|') || sep === undefined || !sep.includes('-')) return false;
    const s = sep.trim();
    if (!TABLE_SEP.test(s)) return false;
    const cells = splitRow(s).length;
    return cells >= 2 || cells === splitRow(line).length;
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') {
        cur += '|';
        i++;
      } else if (s[i] === '|') {
        cells.push(cur.trim());
        cur = '';
      } else cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  function parseList(lines, start) {
    const first = lines[start].match(LIST);
    const base = first[1].length;
    const ordered = /\d/.test(first[2]);
    const node = { type: ordered ? 'ol' : 'ul', start: ordered ? parseInt(first[2], 10) : 1, items: [] };
    let i = start;
    while (i < lines.length) {
      const m = lines[i].match(LIST);
      if (!m || m[1].length < base || m[1].length > base + 1 || /\d/.test(m[2]) !== ordered) break;
      const contentIndent = m[1].length + m[2].length + 1;
      const item = [m[3]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (isBlank(l)) {
          let j = i + 1;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j < lines.length && lead(lines[j]) >= base + 2) {
            for (; i < j; i++) item.push('');
            continue;
          }
          break;
        }
        const n = lead(l);
        if (n >= base + 2) {
          item.push(l.slice(Math.min(n, contentIndent)));
          i++;
          continue;
        }
        if (startsBlock(l) || startsTable(lines, i)) break;
        item.push(l.trim()); // lazy continuation
        i++;
      }
      // A task list item: "- [ ] to do" or "- [x] done".
      const task = item[0].match(TASK);
      if (task) item[0] = task[2];
      node.items.push(task ? { task: task[1] !== ' ', children: nested(item) } : { children: nested(item) });
      // A blank line between sibling items keeps the list going.
      let j = i;
      while (j < lines.length && isBlank(lines[j])) j++;
      const next = j < lines.length && lines[j].match(LIST);
      if (j > i && next && next[1].length === base && /\d/.test(next[2]) === ordered) i = j;
    }
    return [node, i];
  }

  // Quotes and lists nest by recursion; past this depth the rest is text, so
  // a hostile answer can't overflow the stack.
  const MAX_DEPTH = 20;
  let depth = 0;

  function nested(lines) {
    if (depth >= MAX_DEPTH) return [{ type: 'p', children: [{ type: 'text', text: lines.join(' ') }] }];
    depth++;
    try {
      return parseBlocks(lines);
    } finally {
      depth--;
    }
  }

  function parseBlocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        i++;
        continue;
      }

      let m = fenceOf(line);
      if (m) {
        const fence = m[2];
        const indent = m[1].length;
        const close = new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
        const buf = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) {
          buf.push(lines[i].slice(Math.min(indent, lead(lines[i]))));
          i++;
        }
        // A fence still open is the end of an answer still streaming in.
        const node = { type: 'code', lang: m[3] || '', text: buf.join('\n') };
        if (i >= lines.length) node.open = true;
        i++;
        out.push(node);
        continue;
      }

      m = line.match(MATH_BLOCK);
      if (m) {
        const close = m[1] === '$$' ? '$$' : '\\]';
        const first = m[2];
        const at = first.indexOf(close);
        // "$$ x $$ and more" is inline math inside a paragraph.
        if (at === -1 || !first.slice(at + close.length).trim()) {
          const buf = [];
          let open = true;
          if (at !== -1) {
            buf.push(first.slice(0, at));
            open = false;
            i++;
          } else {
            buf.push(first);
            i++;
            while (i < lines.length) {
              const end = lines[i].indexOf(close);
              if (end !== -1) {
                buf.push(lines[i].slice(0, end));
                open = false;
                i++;
                break;
              }
              buf.push(lines[i]);
              i++;
            }
          }
          const tex = buf.join('\n').trim();
          const node = { type: 'math', display: true, tex, raw: `${m[1]}${buf.join('\n')}${open ? '' : close}` };
          if (open) node.open = true;
          if (tex || open) out.push(node);
          continue;
        }
      }

      m = line.match(HEADING);
      if (m) {
        out.push({ type: 'heading', level: m[1].length, children: parseInline(headingText(m[2] || '')) });
        i++;
        continue;
      }

      if (HR.test(line)) {
        out.push({ type: 'hr' });
        i++;
        continue;
      }

      if (QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i++;
        }
        out.push({ type: 'quote', children: nested(buf) });
        continue;
      }

      if (startsTable(lines, i)) {
        const head = splitRow(line);
        const align = splitRow(lines[i + 1].trim()).map((c) =>
          c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null,
        );
        i += 2;
        const rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push({
          type: 'table',
          align,
          head: head.map(parseInline),
          rows: rows.map((r) => head.map((_, c) => parseInline(r[c] || ''))),
        });
        continue;
      }

      if (LIST.test(line)) {
        const [node, next] = parseList(lines, i);
        out.push(node);
        i = next;
        continue;
      }

      const buf = [line];
      i++;
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i]) && !startsTable(lines, i)) {
        buf.push(lines[i]);
        i++;
      }
      out.push({ type: 'paragraph', children: parseInline(buf.map((l) => l.replace(/^\s+/, '')).join('\n')) });
    }
    return out;
  }

  // A bare address ends before trailing punctuation, and before a closing
  // parenthesis it didn't open ("(see https://x.example/a_(b))").
  function trimUrl(url) {
    let u = url;
    let opens = (u.match(/\(/g) || []).length;
    let closes = (u.match(/\)/g) || []).length;
    for (;;) {
      const last = u[u.length - 1];
      if ('.,:;"\'!?*_~]}'.includes(last)) u = u.slice(0, -1);
      else if (last === ')' && closes > opens) {
        u = u.slice(0, -1);
        closes--;
      } else break;
    }
    return u.length > 'https://'.length ? u : null;
  }

  function safeUrl(url) {
    try {
      const u = new URL(url);
      return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  }

  const INLINE_RULES = [
    { re: /^\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/, make: (m) => ({ type: 'strong', children: [{ type: 'em', children: parseInline(m[1]) }] }) },
    // Code spans inside are skipped whole, so "**`a ** b`:**" is bold code.
    // (?=(…))\2 takes a span atomically, and a lone backtick counts only when
    // no backtick follows it on the line. Without both, an unclosed ** before
    // many code spans tried every way of splitting them: 84 characters took
    // seconds.
    // A double-backtick span (``a`b``) is taken whole the same way.
    { re: /^\*\*(?=\S)((?:(?=(``(?:[^`\n]|`(?!`))+?``))\2|(?=(`[^`\n]+`))\3|[^*`]|`(?![^`\n]*`)|\*(?!\*))+?)(?<=\S)\*\*/, make: (m) => ({ type: 'strong', children: parseInline(m[1]) }) },
    { re: /^__(?=\S)([\s\S]+?)(?<=\S)__(?![A-Za-z0-9])/, word: true, make: (m) => ({ type: 'strong', children: parseInline(m[1]) }) },
    // Code spans are skipped whole here too, so "*use `a*b`*" is italic code.
    { re: /^\*(?=[^\s*])((?:(?=(``(?:[^`\n]|`(?!`))+?``))\2|(?=(`[^`\n]+`))\3|\*\*[^*]+\*\*|[^*`]|`(?![^`\n]*`))+?)(?<=\S)\*(?!\*)/, make: (m) => ({ type: 'em', children: parseInline(m[1]) }) },
    { re: /^_(?=[^\s_])([\s\S]+?)(?<=\S)_(?![A-Za-z0-9_])/, word: true, make: (m) => ({ type: 'em', children: parseInline(m[1]) }) },
    { re: /^~~(?=\S)([\s\S]+?)(?<=\S)~~/, make: (m) => ({ type: 'del', children: parseInline(m[1]) }) },
  ];

  // Inside a link's text, nothing else becomes a link (no nested anchors).
  let inLink = 0;

  // Math counts as its source, so a formula in link text can't make the text
  // look like the address.
  function plainText(nodes) {
    const of = (n) => (n.type === 'text' || n.type === 'code' ? n.text : n.type === 'math' ? n.raw : n.children ? plainText(n.children) : '');
    return nodes.map(of).join('');
  }

  function decoded(href) {
    try {
      return decodeURI(href);
    } catch {
      return href;
    }
  }

  // Where a mailto: link sends mail: its address, and any to, cc and bcc
  // fields in its query (in any case).
  function mailDest(href) {
    const u = new URL(href);
    const to = decoded(u.pathname);
    const more = [];
    for (const [k, v] of u.searchParams) {
      const key = k.toLowerCase();
      if (key === 'to' || key === 'cc' || key === 'bcc') more.push(`${key} ${v}`);
    }
    return [to, ...more].filter(Boolean).join(', ');
  }

  // A link whose text isn't its own address also shows where it really goes,
  // so "[your settings](https://elsewhere.example)" can't pass for a link to
  // the settings. Bare addresses get the same check, which shows the real
  // (punycode) host of one spelled with look-alike letters.
  function linkNode(href, children) {
    const node = { type: 'link', href, children };
    const text = plainText(children).trim().replace(/\/$/, '');
    if (href.startsWith('mailto:')) {
      const dest = mailDest(href);
      if (text !== dest) node.dest = dest;
    } else {
      // Text that is itself an address needs a label only when its host
      // isn't the real one (look-alike letters, or another site entirely);
      // case, a port, a query or a path don't matter.
      const shown = /^https?:\/\/([^/?#\s:]+)/i.exec(text);
      const real = new URL(href);
      if (shown ? shown[1].toLowerCase() !== real.hostname : text !== href.replace(/\/$/, '') && text !== decoded(href).replace(/\/$/, '')) {
        node.dest = real.host;
      }
    }
    return node;
  }

  function parseInline(src) {
    const out = [];
    let text = '';
    // Closers already known to be missing after some point, so a run of
    // unclosed "\(" or "[" isn't searched to the end again from each one.
    const missing = new Set();
    const flush = () => {
      if (text) out.push({ type: 'text', text });
      text = '';
    };
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      const rest = src.slice(i);

      // Math: \( … \) inline, \[ … \] displayed.
      if (ch === '\\' && (src[i + 1] === '(' || src[i + 1] === '[')) {
        const close = src[i + 1] === '(' ? '\\)' : '\\]';
        const end = missing.has(close) ? -1 : src.indexOf(close, i + 2);
        if (end === -1) missing.add(close);
        const tex = end === -1 ? '' : src.slice(i + 2, end).trim();
        if (tex) {
          flush();
          out.push({ type: 'math', display: close === '\\]', tex, raw: src.slice(i, end + 2) });
          i = end + 2;
          continue;
        }
      }

      if (ch === '$') {
        const m = dollarMath(src, i);
        if (m) {
          flush();
          out.push(m.node);
          i = m.end;
          continue;
        }
      }

      if (ch === '\\' && /[\\`*_{}[\]()#+\-.!|~<>$]/.test(src[i + 1] || '')) {
        text += src[i + 1];
        i += 2;
        continue;
      }

      if (ch === '`') {
        const run = rest.match(/^`+/)[0];
        const end = src.indexOf(run, i + run.length);
        if (end !== -1) {
          flush();
          let code = src.slice(i + run.length, end).replace(/\n/g, ' ');
          if (/^ .* $/.test(code)) code = code.slice(1, -1);
          out.push({ type: 'code', text: code });
          i = end + run.length;
          continue;
        }
        text += run;
        i += run.length;
        continue;
      }

      if (ch === '\n') {
        flush();
        if ((out.length && out[out.length - 1].type === 'text' ? out[out.length - 1].text : '').endsWith('  ')) {
          out[out.length - 1].text = out[out.length - 1].text.trimEnd();
          out.push({ type: 'br' });
        } else {
          text = ' ';
        }
        i++;
        continue;
      }

      if (ch === '[' && !inLink && !missing.has('](')) {
        if (src.indexOf('](', i) === -1) missing.add('](');
        // The address may hold balanced parentheses (…/wiki/Foo_(bar)), and
        // falls back to everything before the first ")" when they don't
        // balance. A title may be in double or single quotes.
        const m = rest.match(/^\[([^\]\n]*)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+|[^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/);
        const href = m && safeUrl(m[2]);
        if (href) {
          flush();
          inLink++;
          const children = parseInline(m[1] || m[2]);
          inLink--;
          out.push(linkNode(href, children));
          i += m[0].length;
          continue;
        }
      }

      if (ch === '<' && !inLink) {
        const m = rest.match(/^<(https?:\/\/[^>\s]+)>/);
        const href = m && safeUrl(m[1]);
        if (href) {
          flush();
          out.push(linkNode(href, [{ type: 'text', text: m[1] }]));
          i += m[0].length;
          continue;
        }
      }

      if (ch === 'h' && !inLink && !/[A-Za-z0-9]/.test(src[i - 1] || '')) {
        // A quote or > ends a bare URL (raw HTML such as src="…">).
        const m = rest.match(/^https?:\/\/[^\s<>"]+/);
        const url = m && trimUrl(m[0]);
        const href = url && safeUrl(url);
        if (href) {
          flush();
          out.push(linkNode(href, [{ type: 'text', text: url }]));
          i += url.length;
          continue;
        }
      }

      if (ch === '*' || ch === '_' || ch === '~') {
        let matched = false;
        for (const rule of INLINE_RULES) {
          if (rule.word && /[A-Za-z0-9]/.test(src[i - 1] || '')) continue;
          const m = rest.match(rule.re);
          if (m) {
            flush();
            out.push(rule.make(m));
            i += m[0].length;
            matched = true;
            break;
          }
        }
        if (matched) continue;
      }

      text += ch;
      i++;
    }
    flush();
    return out;
  }

  // $$ … $$ (displayed) or $ … $ (inline) starting at src[i]. A price is
  // not math: as in Pandoc, an opening $ must be followed by a non-space and
  // a closing $ must follow a non-space and not be followed by a digit, so
  // "$5 and $10" stays text.
  function dollarMath(src, i) {
    if (src[i + 1] === '$') {
      const end = src.indexOf('$$', i + 2);
      const tex = end === -1 ? '' : src.slice(i + 2, end).trim();
      return tex ? { node: { type: 'math', display: true, tex, raw: src.slice(i, end + 2) }, end: end + 2 } : null;
    }
    if (!src[i + 1] || /\s/.test(src[i + 1])) return null;
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') {
        j++;
        continue;
      }
      if (src[j] === '$') {
        if (/\s/.test(src[j - 1]) || /\d/.test(src[j + 1] || '')) return null;
        return { node: { type: 'math', display: false, tex: src.slice(i + 1, j), raw: src.slice(i, j + 1) }, end: j + 1 };
      }
    }
    return null;
  }

  // The blocks of an answer as a plain tree. A failed parse leaves no state
  // behind for the next one.
  function parse(markdown) {
    try {
      return parseLines(markdown);
    } catch (err) {
      depth = 0;
      inLink = 0;
      throw err;
    }
  }

  function parseLines(markdown) {
    // Tabs count as four spaces for indentation, but code inside a fence
    // keeps its own (a Makefile needs them).
    let open = null;
    const lines = String(markdown)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => {
        // Only a fence at the top level, as list items measure their code's
        // indentation in spaces.
        const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
        if (open) {
          if (m && m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = null;
          return open ? l : l.replace(/\t/g, '    ');
        }
        if (m && !(m[1][0] === '`' && m[2].includes('`'))) open = m[1];
        return l.replace(/\t/g, '    ');
      });
    return parseBlocks(lines);
  }

  R.markdown = { parse };
})();
