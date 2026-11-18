// Answers' Markdown as DOM nodes, from the tree markdown-parse.js builds.
// Model output never goes through innerHTML, and links are limited to
// http(s) and mailto. Math is typeset with KaTeX and code colored with
// highlight.js where the page has them (the bubble frame); elsewhere both
// show as plain text.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

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
      renderBlocks(R.markdown.parse(markdown), frag);
    } catch {
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

  R.markdown.render = render;
  R.markdown.plainBlock = plainBlock;
})();
