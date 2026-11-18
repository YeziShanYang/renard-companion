// The bubble's contents: canned line, controls, question, streamed answer,
// and the input with its "Read chat" switch. This page runs in an extension
// frame inside the bubble that Renard draws on the site, so the site's
// scripts can't read what is typed or answered here, or script it.
//
// Renard's content script drives it over a MessageChannel it hands over
// with a key (see connect below): it sends what to show, and this frame
// reports what the user does and how tall the content is. The answer area
// is in answer-view.js, and attached images in attachments.js.
(function () {
  const R = globalThis.Renard;
  const { h, iconButton } = R;
  const ext = R.ext;
  const instance = new URLSearchParams(location.search).get('i') || '';
  // The answer area never shrinks below about four lines (with its padding),
  // or its whole content when that is shorter.
  const ANSWER_MIN = 120;

  let port = null;
  function post(msg) {
    if (!port) return;
    try {
      port.postMessage(msg);
    } catch {
      port = null;
    }
  }

  class Panel {
    constructor() {
      this.cancelType = null;
      this.markdown = '';
      this.copyTimer = 0;
      this.shortcuts = {};
      this.blips = false;
      this.build();
      // The page lets this frame read the keyboard layout (keyboard-map).
      R.watchKeyboardLayout();
    }

    build() {
      const head = this.buildHead();
      const notice = this.buildNotice();
      const qa = this.buildAnswer();
      this.status = h('p', { class: 'sr-only', role: 'status' });
      const form = this.buildForm();
      this.el = h(
        'main',
        { class: 'panel', role: 'dialog', 'aria-labelledby': 'renard-line', 'data-side': 'left', 'data-fill': 'false' },
        [head, notice, qa, this.status, form],
      );
      document.body.append(this.el);
      this.attachments.takeDrops(this.el);

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

      // The content script sizes the frame to the panel: px is the panel's
      // height, min the least it needs to show everything without clipping.
      let last = '';
      this.reportHeight = (force = false) => {
        const px = Math.ceil(this.el.getBoundingClientRect().height);
        const min = this.minHeight();
        if (!force && last === `${px}:${min}`) return;
        last = `${px}:${min}`;
        post({ type: 'height', px, min });
      };
      new ResizeObserver(() => this.reportHeight()).observe(this.el);
    }

    // The canned line, the question once asked, and the buttons: answer
    // actions (shown once there is an answer), then the bubble's own expand
    // and close.
    buildHead() {
      this.lineText = h('span', { class: 'line-text', 'aria-hidden': 'true' });
      this.lineLive = h('span', { class: 'sr-only' });
      this.line = h('p', { class: 'line', id: 'renard-line' }, [this.lineText, this.lineLive]);

      this.expandBtn = iconButton('expand', 'Expand', () => post({ type: 'expand' }), { 'aria-pressed': 'false' });
      this.expandBtn.append(R.icon('collapse'));
      const closeBtn = iconButton('close', 'Close', () => post({ type: 'close' }));

      this.copyBtn = iconButton('copy', 'Copy answer', () => this.copy(), { 'data-copied': 'false' });
      this.copyBtn.classList.add('copy-btn');
      this.copyBtn.append(R.icon('check'));
      this.clearBtn = iconButton('clear', 'Clear question and answer', () => post({ type: 'clear' }));
      this.answerActions = h('div', { class: 'head-group', hidden: true }, [this.copyBtn, this.clearBtn]);
      // The question sits under the line, in the header, so the answer below
      // never squeezes either of them. While a question is shown both keep
      // to one line, with the full text in the tooltip.
      this.askedText = h('span', { class: 'asked-text' });
      // A camera after the label when an image went with the question.
      this.askedShot = h('span', { class: 'asked-shot', hidden: true }, [R.icon('camera', 1), h('span', { class: 'sr-only' }, 'with a screenshot')]);
      this.asked = h('p', { class: 'asked', hidden: true }, [h('span', { class: 'asked-label' }, 'You asked: '), this.askedShot, this.askedText]);
      return h('header', { class: 'head' }, [
        h('div', { class: 'head-text' }, [this.line, this.asked]),
        h('div', { class: 'head-actions' }, [this.answerActions, h('div', { class: 'head-group' }, [this.expandBtn, closeBtn])]),
      ]);
    }

    buildNotice() {
      this.noticeText = h('p', { class: 'notice-text' });
      this.settingsBtn = h('button', { class: 'btn', type: 'button', onclick: () => post({ type: 'settings' }) }, 'Open settings');
      this.notice = h('div', { class: 'notice', hidden: true }, [this.noticeText, this.settingsBtn]);
      return this.notice;
    }

    // The note about what was read, and the answer.
    buildAnswer() {
      this.note = h('p', { class: 'note', hidden: true });
      this.answer = new R.AnswerView({ onRender: () => this.reportHeight() });
      this.qa = h('div', { class: 'qa', hidden: true }, [this.note, this.answer.box]);
      return this.qa;
    }

    // The question box, any attached image above it, and the row under it:
    // Read chat, the screenshot button, and Ask (Stop while answering).
    buildForm() {
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
          if (!e.repeat) this.submit();
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
      // Not a submit button: a page sandboxed without allow-forms passes
      // that to this frame, and form submission is blocked there.
      this.sendBtn = h('button', { type: 'button', class: 'btn btn-primary send-btn' }, [R.icon('stop'), this.sendLabel]);
      this.sendBtn.addEventListener('click', () => this.submit());
      this.attachments = new R.Attachments({ post, notice: (n) => this.setNotice(n) });

      this.form = h('form', { class: 'ask' }, [
        this.attachments.row,
        h('div', { class: 'input-box' }, [this.input, h('span', { class: 'block-caret', 'aria-hidden': 'true' })]),
        h('div', { class: 'ask-row' }, [h('div', { class: 'ask-tools' }, [this.readLabel, this.attachments.button]), this.sendBtn]),
      ]);
      this.attachments.takePastes(this.input);
      this.form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.submit();
      });
      return this.form;
    }

    // The answer area may shrink to a few lines (it scrolls) when the bubble
    // is short; nothing else shrinks. These keep it from going smaller, and
    // add up the panel's height at that size.
    answerMin() {
      return this.answer.box.getClientRects().length ? Math.min(this.answer.el.scrollHeight, ANSWER_MIN) : 0;
    }

    minHeight() {
      const answerMin = this.answerMin();
      this.el.style.setProperty('--answer-min', `${answerMin}px`);
      const gap = (el) => parseFloat(getComputedStyle(el).rowGap) || 0;
      const sum = (parts, el) => parts.reduce((a, b) => a + b, 0) + gap(el) * Math.max(0, parts.length - 1);
      const qa = [];
      if (!this.note.hidden) qa.push(this.note.getBoundingClientRect().height);
      if (answerMin) qa.push(answerMin + 4); // the box's 2px margins
      const qaMin = sum(qa, this.qa);
      this.el.style.setProperty('--qa-min', `${qaMin}px`);
      const parts = [];
      for (const child of this.el.children) {
        if (child.hidden || !child.getClientRects().length || getComputedStyle(child).position === 'absolute') continue;
        parts.push(child === this.qa ? qaMin : child.getBoundingClientRect().height);
      }
      const cs = getComputedStyle(this.el);
      return Math.ceil(sum(parts, this.el) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
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
          // Reported now, so the last height the page hears is measured in
          // this layout: a report from just before it (the panel filling an
          // old, taller size) could otherwise arrive last and keep the
          // bubble tall.
          this.reportHeight(true);
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
          this.shortcuts = R.parseShortcuts(m.shortcuts);
          break;
        case 'line':
          this.setLine(String(m.text || ''));
          break;
        case 'blocked':
          // Setting up: the notice and its settings button only. Every
          // settings refresh repeats this, so an empty one clears only the
          // setup notice, not an error or other notice shown since.
          this.form.hidden = Boolean(m.detail);
          this.expandBtn.hidden = Boolean(m.detail);
          if (m.detail) this.setNotice({ text: m.detail, settings: true });
          else if (this.blockedNotice) this.setNotice(null);
          this.blockedNotice = Boolean(m.detail);
          break;
        case 'notice':
          this.blockedNotice = false;
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
        case 'start':
          this.startAnswer(String(m.question || ''), Boolean(m.screenshot));
          break;
        case 'attachment':
          this.attachments.show(m.image || null);
          break;
        case 'images':
          this.attachments.setEnabled(Boolean(m.enabled), String(m.why || ''));
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
      this.line.title = text;
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

    // Enter or the Ask/Stop button. The content script decides between
    // asking and stopping: it knows whether an answer is still coming,
    // without a message's delay.
    submit() {
      post({ type: 'submit', question: this.input.value, readChat: this.readChat.checked });
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

    startAnswer(question, screenshot = false) {
      this.qa.hidden = false;
      this.asked.hidden = false;
      this.el.dataset.asked = 'true';
      this.answerActions.hidden = false;
      this.askedShot.hidden = !screenshot;
      this.askedText.textContent = question;
      this.asked.title = screenshot ? `With a screenshot: ${question}` : question;
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
      this.asked.hidden = true;
      delete this.el.dataset.asked;
      this.answerActions.hidden = true;
      this.askedText.textContent = '';
      this.asked.title = '';
      this.setNote('');
      this.setNotice(null);
      this.setDraft('');
      this.status.textContent = 'Cleared';
    }

    setNote(text) {
      this.note.hidden = !text;
      this.note.textContent = text;
    }

    setAnswer(markdown, { streaming = false } = {}) {
      this.markdown = markdown;
      this.el.dataset.streaming = streaming ? 'true' : 'false';
      this.sendLabel.textContent = streaming ? 'Stop' : 'Ask';
      this.copyBtn.disabled = streaming || !markdown;
      this.answer.show(markdown, streaming);
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
      panel.reportHeight(true);
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
