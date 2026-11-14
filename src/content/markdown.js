// A small Markdown renderer for answers. parse() builds a plain tree (unit
// tested in Node); render() turns it into DOM nodes. Model output never goes
// through innerHTML, and links are limited to http(s) and mailto.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>/;
  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  const isBlank = (l) => /^\s*$/.test(l);
  const lead = (l) => l.match(/^ */)[0].length;

  function startsBlock(line) {
    return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line);
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
        if (startsBlock(l)) break;
        item.push(l.trim()); // lazy continuation
        i++;
      }
      node.items.push({ children: nested(item) });
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

      let m = line.match(FENCE);
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
        i++; // closing fence (or end of a still-streaming answer)
        out.push({ type: 'code', lang: m[3] || '', text: buf.join('\n') });
        continue;
      }

      m = line.match(HEADING);
      if (m) {
        out.push({ type: 'heading', level: m[1].length, children: parseInline(m[2]) });
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

      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = splitRow(line);
        const align = splitRow(lines[i + 1]).map((c) =>
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
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push({ type: 'paragraph', children: parseInline(buf.map((l) => l.replace(/^\s+/, '')).join('\n')) });
    }
    return out;
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
    { re: /^\*\*(?=\S)((?:[^*]|\*(?!\*))+?)(?<=\S)\*\*/, make: (m) => ({ type: 'strong', children: parseInline(m[1]) }) },
    { re: /^__(?=\S)([\s\S]+?)(?<=\S)__(?![A-Za-z0-9])/, word: true, make: (m) => ({ type: 'strong', children: parseInline(m[1]) }) },
    { re: /^\*(?=[^\s*])((?:\*\*[^*]+\*\*|[^*])+?)(?<=\S)\*(?!\*)/, make: (m) => ({ type: 'em', children: parseInline(m[1]) }) },
    { re: /^_(?=[^\s_])([\s\S]+?)(?<=\S)_(?![A-Za-z0-9_])/, word: true, make: (m) => ({ type: 'em', children: parseInline(m[1]) }) },
    { re: /^~~(?=\S)([\s\S]+?)(?<=\S)~~/, make: (m) => ({ type: 'del', children: parseInline(m[1]) }) },
  ];

  // Inside a link's text, nothing else becomes a link (no nested anchors).
  let inLink = 0;

  function plainText(nodes) {
    return nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.text : n.children ? plainText(n.children) : '')).join('');
  }

  // A link whose text isn't its own address also shows where it really goes,
  // so "[your settings](https://elsewhere.example)" can't pass for a link to
  // the settings.
  function linkNode(href, children) {
    const node = { type: 'link', href, children };
    const text = plainText(children).trim().replace(/\/$/, '');
    if (text !== href.replace(/\/$/, '') && text !== href.replace(/^mailto:/, '')) {
      node.dest = href.startsWith('mailto:') ? href.slice(7).split('?')[0] : new URL(href).host;
    }
    return node;
  }

  function parseInline(src) {
    const out = [];
    let text = '';
    const flush = () => {
      if (text) out.push({ type: 'text', text });
      text = '';
    };
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      const rest = src.slice(i);

      if (ch === '\\' && /[\\`*_{}[\]()#+\-.!|~<>]/.test(src[i + 1] || '')) {
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
        if (/ {2,}$/.test(out.length && out[out.length - 1].type === 'text' ? out[out.length - 1].text : '')) {
          out[out.length - 1].text = out[out.length - 1].text.replace(/ +$/, '');
          out.push({ type: 'br' });
        } else {
          text = ' ';
        }
        i++;
        continue;
      }

      if (ch === '[' && !inLink) {
        const m = rest.match(/^\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/);
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
          out.push({ type: 'link', href, children: [{ type: 'text', text: m[1] }] });
          i += m[0].length;
          continue;
        }
      }

      if (ch === 'h' && !inLink && !/[A-Za-z0-9]/.test(src[i - 1] || '')) {
        const m = rest.match(/^https?:\/\/[^\s<]+[^\s<.,:;"')\]!?*_~]/);
        const href = m && safeUrl(m[0]);
        if (href) {
          flush();
          out.push({ type: 'link', href, children: [{ type: 'text', text: m[0] }] });
          i += m[0].length;
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

  function parse(markdown) {
    const lines = String(markdown).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    return parseBlocks(lines);
  }

  // ---- DOM rendering ------------------------------------------------------

  function renderInline(nodes, parent) {
    for (const n of nodes) {
      switch (n.type) {
        case 'text':
          parent.append(document.createTextNode(n.text));
          break;
        case 'br':
          parent.append(document.createElement('br'));
          break;
        case 'code': {
          const el = document.createElement('code');
          el.textContent = n.text;
          parent.append(el);
          break;
        }
        case 'link': {
          const a = document.createElement('a');
          a.href = n.href;
          a.title = n.href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          renderInline(n.children, a);
          parent.append(a);
          if (n.dest) {
            const dest = document.createElement('span');
            dest.className = 'link-dest';
            dest.textContent = ` (${n.dest})`;
            parent.append(dest);
          }
          break;
        }
        default: {
          const el = document.createElement(n.type === 'del' ? 's' : n.type);
          renderInline(n.children, el);
          parent.append(el);
        }
      }
    }
  }

  function renderBlocks(blocks, parent) {
    for (const b of blocks) {
      let el;
      switch (b.type) {
        case 'paragraph':
          el = document.createElement('p');
          renderInline(b.children, el);
          break;
        case 'heading':
          el = document.createElement(b.level <= 2 ? 'h3' : b.level === 3 ? 'h4' : 'h5');
          renderInline(b.children, el);
          break;
        case 'hr':
          el = document.createElement('hr');
          break;
        case 'code': {
          el = document.createElement('pre');
          const code = document.createElement('code');
          if (b.lang) el.dataset.lang = b.lang;
          code.textContent = b.text;
          el.append(code);
          break;
        }
        case 'quote':
          el = document.createElement('blockquote');
          renderBlocks(b.children, el);
          break;
        case 'ul':
        case 'ol':
          el = document.createElement(b.type);
          if (b.type === 'ol' && b.start !== 1) el.start = b.start;
          for (const item of b.items) {
            const li = document.createElement('li');
            renderBlocks(item.children, li);
            el.append(li);
          }
          break;
        case 'table': {
          el = document.createElement('div');
          el.className = 'table-wrap';
          const table = document.createElement('table');
          const thead = document.createElement('thead');
          const tr = document.createElement('tr');
          b.head.forEach((cell, c) => {
            const th = document.createElement('th');
            if (b.align[c]) th.style.textAlign = b.align[c];
            renderInline(cell, th);
            tr.append(th);
          });
          thead.append(tr);
          const tbody = document.createElement('tbody');
          for (const row of b.rows) {
            const r = document.createElement('tr');
            row.forEach((cell, c) => {
              const td = document.createElement('td');
              if (b.align[c]) td.style.textAlign = b.align[c];
              renderInline(cell, td);
              r.append(td);
            });
            tbody.append(r);
          }
          table.append(thead, tbody);
          el.append(table);
          break;
        }
        default:
          continue;
      }
      parent.append(el);
    }
  }

  // Never throws: anything the parser can't handle shows as plain text.
  function render(markdown) {
    const frag = document.createDocumentFragment();
    try {
      renderBlocks(parse(markdown), frag);
    } catch {
      depth = 0;
      inLink = 0;
      frag.replaceChildren(plainBlock(markdown));
    }
    return frag;
  }

  function plainBlock(markdown) {
    const p = document.createElement('p');
    p.className = 'plain';
    p.textContent = String(markdown);
    return p;
  }

  R.markdown = { parse, render, plainBlock };
})();
