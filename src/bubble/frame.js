// The bubble's contents: canned line, controls, question, streamed answer,
// and the input with its "Read chat" switch. This page runs in an extension
// frame inside the bubble that Renard draws on the site, so the site's
// scripts can't read what is typed or answered here, or script it.
//
// Renard's content script drives it over an extension port (sites can't use
// extension messaging): it sends what to show, and this frame reports what
// the user does and how tall the content is.
(function () {
  const R = globalThis.Renard;
  const { h } = R;
  const ext = R.ext;
  const instance = new URLSearchParams(location.search).get('i') || '';

  let port = null;
  function post(msg) {
    if (!port) return;
    try {
      port.postMessage(msg);
    } catch {
      port = null;
    }
  }

  function iconButton(name, label, onclick, extra = {}) {
    return h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onclick, ...extra }, [R.icon(name)]);
  }

  class Panel {
    constructor() {
      this.cancelType = null;
      this.markdown = '';
      this.renderQueued = false;
      this.streaming = false;
      this.copyTimer = 0;
      this.shortcuts = {};
      this.blips = false;
      this.build();
    }

    build() {
      this.lineText = h('span', { class: 'line-text', 'aria-hidden': 'true' });
      this.lineLive = h('span', { class: 'sr-only' });
      this.line = h('p', { class: 'line', id: 'renard-line' }, [this.lineText, this.lineLive]);

      this.expandBtn = iconButton('expand', 'Expand', () => post({ type: 'expand' }), { 'aria-pressed': 'false' });
      this.expandBtn.append(R.icon('collapse'));
      const closeBtn = iconButton('close', 'Close', () => post({ type: 'close' }));

      // One row of controls: answer actions (shown once there is an answer),
      // then the bubble's own expand and close.
      this.copyBtn = iconButton('copy', 'Copy answer', () => this.copy(), { 'data-copied': 'false' });
      this.copyBtn.classList.add('copy-btn');
      this.copyBtn.append(R.icon('check'));
      this.clearBtn = iconButton('clear', 'Clear question and answer', () => post({ type: 'clear' }));
      this.answerActions = h('div', { class: 'head-group', hidden: true }, [this.copyBtn, this.clearBtn]);
      const head = h('header', { class: 'head' }, [
        this.line,
        h('div', { class: 'head-actions' }, [this.answerActions, h('div', { class: 'head-group' }, [this.expandBtn, closeBtn])]),
      ]);

      this.noticeText = h('p', { class: 'notice-text' });
      this.settingsBtn = h('button', { class: 'btn', type: 'button', onclick: () => post({ type: 'settings' }) }, 'Open settings');
      this.notice = h('div', { class: 'notice', hidden: true }, [this.noticeText, this.settingsBtn]);

      this.askedText = h('span', { class: 'asked-text' });
      this.note = h('p', { class: 'note', hidden: true });
      this.answer = h('div', { class: 'answer', tabindex: '0', role: 'region', 'aria-label': 'Answer' });
      this.qa = h('div', { class: 'qa', hidden: true }, [
        h('p', { class: 'asked' }, [h('span', { class: 'asked-label' }, 'You asked: '), this.askedText]),
        this.note,
        h('div', { class: 'answer-box' }, [this.answer]),
      ]);
      this.status = h('p', { class: 'sr-only', role: 'status' });

      this.input = h('textarea', {
        class: 'input',
        rows: '1',
        placeholder: 'Ask Renard…',
        'aria-label': 'Your question',
        maxlength: '20000',
        spellcheck: 'true',
      });
      this.input.addEventListener('input', () => this.autosize());
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          // A held Enter sends once, not thirty asks and stops a second.
          if (!e.repeat) this.form.requestSubmit();
        }
      });

      this.readChat = h('input', { type: 'checkbox', role: 'switch', class: 'switch-input' });
      this.readChat.addEventListener('change', () => post({ type: 'readChat', on: this.readChat.checked }));
      this.readLabelText = h('span', { class: 'switch-label' }, 'Read chat');
      this.readLabel = h('label', { class: 'switch', title: 'Include the chat on this page with your question' }, [
        this.readChat,
        h('span', { class: 'switch-track', 'aria-hidden': 'true' }, [h('span', { class: 'switch-thumb' })]),
        R.icon('chat'),
        this.readLabelText,
      ]);

      this.sendLabel = h('span', {}, 'Ask');
      this.sendBtn = h('button', { type: 'submit', class: 'btn btn-primary send-btn' }, [R.icon('stop'), this.sendLabel]);
      this.form = h('form', { class: 'ask' }, [
        h('div', { class: 'input-box' }, [this.input, h('span', { class: 'block-caret', 'aria-hidden': 'true' })]),
        h('div', { class: 'ask-row' }, [this.readLabel, this.sendBtn]),
      ]);
      // The content script decides between asking and stopping: it knows
      // whether an answer is still coming, without a message's delay.
      this.form.addEventListener('submit', (e) => {
        e.preventDefault();
        post({ type: 'submit', question: this.input.value, readChat: this.readChat.checked });
      });

      this.el = h(
        'main',
        { class: 'panel', role: 'dialog', 'aria-labelledby': 'renard-line', 'data-side': 'left', 'data-fill': 'false' },
        [head, this.notice, this.qa, this.status, this.form],
      );
      document.body.append(this.el);

      // Keys typed here never reach the site, so Renard's shortcuts and Esc
      // are handled here too.
      document.addEventListener('keydown', (e) => {
        if (!e.isTrusted || e.isComposing) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          post({ type: 'close', via: 'key' });
          return;
        }
        if (e.repeat) return;
        for (const [cmd, shortcut] of Object.entries(this.shortcuts)) {
          if (R.matchesShortcut(e, shortcut)) {
            e.preventDefault();
            post({ type: 'command', cmd });
            return;
          }
        }
      });

      // The content script sizes the frame to the panel.
      let lastHeight = 0;
      new ResizeObserver(() => {
        const px = Math.ceil(this.el.getBoundingClientRect().height);
        if (px !== lastHeight) {
          lastHeight = px;
          post({ type: 'height', px });
        }
      }).observe(this.el);
      this.reportHeight = () => {
        lastHeight = Math.ceil(this.el.getBoundingClientRect().height);
        post({ type: 'height', px: lastHeight });
      };
    }

    // ---- messages from the content script ----------------------------------

    handle(m) {
      switch (m.type) {
        case 'layout':
          this.el.dataset.side = m.side === 'right' ? 'right' : 'left';
          this.el.dataset.fill = m.fill ? 'true' : 'false';
          this.el.style.setProperty('--max-h', `${Math.max(120, Number(m.maxHeight) || 0)}px`);
          this.el.style.setProperty('--answer-max', `${Math.max(120, Math.round((Number(m.pageHeight) || 800) * 0.7))}px`);
          this.expandBtn.setAttribute('aria-pressed', m.expanded ? 'true' : 'false');
          this.expandBtn.setAttribute('aria-label', m.expanded ? 'Shrink' : 'Expand');
          this.expandBtn.title = m.expanded ? 'Shrink' : 'Expand';
          break;
        case 'theme': {
          const root = document.documentElement;
          root.dataset.switching = '';
          root.dataset.theme = m.theme === 'dark' ? 'dark' : 'light';
          root.dataset.readable = m.readable ? 'true' : 'false';
          requestAnimationFrame(() => delete root.dataset.switching);
          break;
        }
        case 'prefs':
          this.blips = Boolean(m.sound);
          this.shortcuts = {};
          for (const [cmd, text] of Object.entries(m.shortcuts || {})) {
            const parsed = R.parseShortcut(String(text || ''));
            if (parsed) this.shortcuts[cmd] = parsed;
          }
          break;
        case 'line':
          this.setLine(String(m.text || ''));
          break;
        case 'blocked':
          this.form.hidden = Boolean(m.detail);
          this.setNotice(m.detail ? { text: m.detail, settings: true } : null);
          break;
        case 'notice':
          this.setNotice(m.notice);
          break;
        case 'readChat':
          this.readChat.checked = Boolean(m.on);
          break;
        case 'readLabel':
          this.readLabelText.textContent = String(m.text || '');
          this.readLabel.title = String(m.title || '');
          break;
        case 'prefill':
          if (!this.input.value) this.setDraft(String(m.text || ''));
          break;
        case 'draft':
          this.setDraft(String(m.text || ''));
          break;
        case 'start':
          this.startAnswer(String(m.question || ''));
          break;
        case 'reset':
          this.reset();
          break;
        case 'note':
          this.setNote(String(m.text || ''));
          break;
        case 'answer':
          this.setAnswer(String(m.markdown || ''), { streaming: Boolean(m.streaming) });
          break;
        case 'delta':
          this.setAnswer(this.markdown + String(m.text || ''), { streaming: true });
          break;
        case 'announce':
          this.status.textContent = String(m.text || '');
          break;
        case 'focus':
          this.focusPrimary(Boolean(m.select));
          break;
        case 'focusInput':
          this.input.focus();
          break;
        default:
          break;
      }
    }

    // ---- content ----------------------------------------------------------

    setLine(text) {
      if (this.cancelType) this.cancelType();
      this.lineLive.textContent = text;
      this.cancelType = R.typewrite(this.lineText, text, { onChar: () => this.blips && post({ type: 'blip' }) });
    }

    setNotice(notice) {
      if (!notice || (!notice.text && !notice.settings)) {
        this.notice.hidden = true;
        return;
      }
      this.notice.hidden = false;
      this.noticeText.textContent = String(notice.text || '');
      this.noticeText.hidden = !notice.text;
      this.settingsBtn.hidden = !notice.settings;
    }

    setDraft(text) {
      this.input.value = text;
      this.autosize();
    }

    autosize() {
      const el = this.input;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }

    focusPrimary(select) {
      if (!this.notice.hidden && this.form.hidden) {
        this.settingsBtn.focus();
        return;
      }
      this.input.focus();
      if (select && this.input.value) this.input.select();
    }

    startAnswer(question) {
      this.qa.hidden = false;
      this.answerActions.hidden = false;
      this.askedText.textContent = question;
      this.setNote('');
      this.setNotice(null);
      this.setAnswer('', { streaming: true });
      this.copyBtn.disabled = true;
      this.status.textContent = '';
    }

    // Back to an empty bubble: no question, answer, note, or draft.
    reset() {
      this.setAnswer('', { streaming: false });
      this.qa.hidden = true;
      this.answerActions.hidden = true;
      this.askedText.textContent = '';
      this.setNote('');
      this.setNotice(null);
      this.setDraft('');
      this.status.textContent = 'Cleared';
    }

    setNote(text) {
      this.note.hidden = !text;
      this.note.textContent = text;
    }

    setStreaming(on) {
      this.streaming = on;
      this.el.dataset.streaming = on ? 'true' : 'false';
      this.sendLabel.textContent = on ? 'Stop' : 'Ask';
      this.answer.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    setAnswer(markdown, { streaming = false } = {}) {
      this.markdown = markdown;
      this.setStreaming(streaming);
      this.copyBtn.disabled = streaming || !markdown;
      if (!markdown) {
        this.renderCost = 0;
        this.plainStream = false;
      }
      if (streaming) {
        // Coalesce rapid deltas into one render per frame, or ten a second
        // once rendering gets slow (the whole answer is re-parsed each time).
        if (!this.renderQueued) {
          this.renderQueued = true;
          const delay = this.renderCost > 8 ? 100 : 0;
          setTimeout(() => {
            requestAnimationFrame(() => {
              this.renderQueued = false;
              this.renderAnswer();
            });
          }, delay);
        }
      } else {
        this.renderAnswer();
      }
    }

    renderAnswer() {
      const box = this.answer;
      const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      const started = performance.now();
      // An answer too slow to re-format on every update streams as plain
      // text and is formatted once at the end.
      const frag = this.streaming && this.plainStream ? R.markdown.plainBlock(this.markdown) : R.markdown.render(this.markdown);
      this.renderCost = performance.now() - started;
      if (this.streaming && this.renderCost > 50) this.plainStream = true;
      if (this.streaming) {
        // Put the cursor right after the last character: descend while the
        // last node is an element (list item, paragraph, code), but stop at
        // tables and at elements followed by trailing text.
        let target = frag.lastElementChild;
        while (target && target.lastElementChild && target.lastElementChild === target.lastChild && !/^(TABLE|DIV)$/.test(target.tagName)) {
          target = target.lastElementChild;
        }
        (target || frag).append(h('span', { class: 'stream-cursor', 'aria-hidden': 'true' }));
      }
      box.replaceChildren(frag);
      if (this.streaming && pinned) box.scrollTop = box.scrollHeight;
    }

    async copy() {
      if (!this.markdown) return;
      try {
        await navigator.clipboard.writeText(this.markdown);
      } catch {
        return;
      }
      clearTimeout(this.copyTimer);
      this.copyBtn.dataset.copied = 'true';
      this.copyBtn.setAttribute('aria-label', 'Copied');
      this.status.textContent = 'Answer copied';
      this.copyTimer = setTimeout(() => {
        this.copyBtn.dataset.copied = 'false';
        this.copyBtn.setAttribute('aria-label', 'Copy answer');
      }, 1600);
    }
  }

  const panel = new Panel();

  // Accepts the channel the content script hands over, if it comes with the
  // key the content script registered with the background script for this
  // bubble. The key is fetched over extension messaging, which sites can't
  // use, so no site can open a channel of its own.
  async function connect() {
    const offers = [];
    let key = null;
    const accept = (e) => {
      if (port || !key || e.source !== window.parent || !e.data || e.data.renard !== 'bubble' || e.data.key !== key || e.ports.length !== 1) return;
      port = e.ports[0];
      port.onmessage = (ev) => ev.data && typeof ev.data.type === 'string' && panel.handle(ev.data);
      panel.reportHeight();
    };
    // Offers that arrive before the key are held (a few at most).
    const onMessage = (e) => {
      if (key) accept(e);
      else if (offers.length < 4) offers.push(e);
    };
    window.addEventListener('message', onMessage);
    for (const delay of [0, 300, 1000, 3000]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await ext.runtime.sendMessage({ type: 'renard:frameKey', instance });
        key = res && res.ok ? res.result.key : null;
      } catch {
        key = null;
      }
      if (key) break;
    }
    if (!key) {
      window.removeEventListener('message', onMessage);
      return;
    }
    for (const e of offers.splice(0)) accept(e);
  }
  connect();
})();
