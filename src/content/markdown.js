// A small Markdown renderer for answers. parse() builds a plain tree (unit
// tested in Node); render() turns it into DOM nodes. Model output never goes
// through innerHTML, and links are limited to http(s) and mailto. Math is
// typeset with KaTeX and code colored with highlight.js where the page has
// them (the bubble frame); elsewhere both show as plain text.
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

  // A table starts at lines[i]: a row with a pipe, then a separator row with
  // as many cells.
  function startsTable(lines, i) {
    const line = lines[i];
    const sep = lines[i + 1];
    if (!line.includes('|') || sep === undefined || !sep.includes('-')) return false;
    const s = sep.trim();
    return TABLE_SEP.test(s) && splitRow(s).length === splitRow(line).length;
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
    for (;;) {
      const last = u[u.length - 1];
      if ('.,:;"\'!?*_~]'.includes(last)) u = u.slice(0, -1);
      else if (last === ')' && (u.match(/\)/g) || []).length > (u.match(/\(/g) || []).length) u = u.slice(0, -1);
      else break;
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
    { re: /^\*\*(?=\S)((?:(?=(`[^`\n]+`))\2|[^*`]|`(?![^`\n]*`)|\*(?!\*))+?)(?<=\S)\*\*/, make: (m) => ({ type: 'strong', children: parseInline(m[1]) }) },
    { re: /^__(?=\S)([\s\S]+?)(?<=\S)__(?![A-Za-z0-9])/, word: true, make: (m) => ({ type: 'strong', children: parseInline(m[1]) }) },
    // Code spans are skipped whole here too, so "*use `a*b`*" is italic code.
    { re: /^\*(?=[^\s*])((?:(?=(`[^`\n]+`))\2|\*\*[^*]+\*\*|[^*`]|`(?![^`\n]*`))+?)(?<=\S)\*(?!\*)/, make: (m) => ({ type: 'em', children: parseInline(m[1]) }) },
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

  // Where a mailto: link sends mail, cc and bcc included.
  function mailDest(href) {
    const u = new URL(href);
    const to = decoded(u.pathname);
    const copies = ['cc', 'bcc'].flatMap((k) => u.searchParams.getAll(k).map((v) => `${k} ${v}`));
    return [to, ...copies].filter(Boolean).join(', ');
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
    } else if (text !== href.replace(/\/$/, '') && text !== decoded(href).replace(/\/$/, '')) {
      node.dest = new URL(href).host;
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
        // The address may hold balanced parentheses: …/wiki/Foo_(bar).
        const m = rest.match(/^\[([^\]\n]*)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/);
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
        const m = rest.match(/^https?:\/\/[^\s<]+/);
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

  function parse(markdown) {
    // Tabs count as four spaces for indentation, but code inside a fence
    // keeps its own (a Makefile needs them).
    let open = null;
    const lines = String(markdown)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => {
        const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(l);
        if (open) {
          if (m && m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = null;
          return open ? l : l.replace(/\t/g, '    ');
        }
        if (m && !(m[1][0] === '`' && m[2].includes('`'))) open = m[1];
        return l.replace(/\t/g, '    ');
      });
    return parseBlocks(lines);
  }

  // ---- DOM rendering ------------------------------------------------------

  // Math typeset by KaTeX. trust: false refuses the commands that add links,
  // images or HTML attributes; with throwOnError: false a formula KaTeX can't
  // parse shows as its source. Without KaTeX, or while a displayed formula is
  // still streaming in, the source shows as typed.
  // A streaming answer is rendered again many times a second; each formula
  // is typeset once and copied after that.
  const typeset = new Map();

  function renderMath(n, parent) {
    const key = `${n.display ? 'D' : 'I'}${n.tex}`;
    const done = !n.open && typeset.get(key);
    if (done) {
      parent.append(done.cloneNode(true));
      return;
    }
    const el = document.createElement('span');
    el.className = n.display ? 'math math-display' : 'math';
    const katex = globalThis.katex;
    if (katex && !n.open) {
      try {
        katex.render(n.tex, el, {
          displayMode: n.display,
          throwOnError: false,
          trust: false,
          strict: 'ignore',
          errorColor: 'currentColor',
          maxSize: 20,
          maxExpand: 500,
        });
        if (typeset.size > 300) typeset.clear();
        typeset.set(key, el.cloneNode(true));
        parent.append(el);
        return;
      } catch {
        el.replaceChildren();
      }
    }
    el.classList.add('math-source');
    el.textContent = n.raw;
    parent.append(el);
  }

  // highlight.js returns HTML. It is parsed in an inert document, and only its
  // text and its "hljs-…" class spans are copied into the answer, so nothing
  // else in that markup can reach the page. A block still streaming in stays
  // plain until its fence closes.
  function highlight(code, text, lang, open) {
    const hljs = globalThis.hljs;
    if (!open && hljs && lang && hljs.getLanguage(lang) && text.length <= 50000) {
      try {
        const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
        const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
        copySpans(doc.body.firstChild, code);
        return;
      } catch {
        code.replaceChildren();
      }
    }
    code.textContent = text;
  }

  function copySpans(from, to) {
    for (const n of from.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        to.append(document.createTextNode(n.data));
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const classes = [...n.classList].filter((c) => /^hljs-[\w-]+$/.test(c));
        const span = n.tagName === 'SPAN' && classes.length ? document.createElement('span') : null;
        if (span) span.className = classes.join(' ');
        copySpans(n, span || to);
        if (span) to.append(span);
      }
    }
  }

  function codeBlock(b) {
    const el = document.createElement('div');
    el.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';
    const label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = b.lang || 'code';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'code-copy';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', `Copy ${b.lang || 'code'}`);
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(b.text).then(
        () => {
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy'), 1500);
        },
        () => {},
      );
    });
    head.append(label, copy);
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (b.lang) pre.dataset.lang = b.lang;
    highlight(code, b.text, b.lang, b.open);
    pre.append(code);
    el.append(head, pre);
    return el;
  }

  function renderInline(nodes, parent) {
    for (const n of nodes) {
      switch (n.type) {
        case 'text':
          parent.append(document.createTextNode(n.text));
          break;
        case 'br':
          parent.append(document.createElement('br'));
          break;
        case 'math':
          renderMath(n, parent);
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
        case 'code':
          el = codeBlock(b);
          break;
        case 'math':
          el = document.createElement('div');
          el.className = 'math-block';
          renderMath(b, el);
          break;
        case 'quote':
          el = document.createElement('blockquote');
          renderBlocks(b.children, el);
          break;
        case 'ul':
        case 'ol':
          el = document.createElement(b.type);
          if (b.type === 'ol' && b.start !== 1) el.start = b.start;
          if (b.type === 'ol') {
            // Room for the widest number, so "1000." isn't clipped.
            const digits = String(Math.max(Math.abs(b.start), Math.abs(b.start + b.items.length - 1))).length;
            if (digits > 2) el.style.paddingLeft = `${0.6 * digits + 0.4}em`;
          }
          for (const item of b.items) {
            const li = document.createElement('li');
            if (item.task !== undefined) {
              li.className = 'task';
              const box = document.createElement('input');
              box.type = 'checkbox';
              box.checked = item.task;
              box.disabled = true;
              li.append(box);
            }
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
