// The speech bubble: canned line, the question and streamed answer, the
// input with its "Read chat" switch, plus expand and resize controls.
// It owns its DOM and controls; the app decides where it goes.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});
  const { h } = R;

  function iconButton(name, label, onclick, extra = {}) {
    return h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onclick, ...extra }, [R.icon(name)]);
  }

  R.Bubble = class {
    constructor(handlers) {
      this.handlers = handlers;
      this.isOpen = false;
      this.cancelType = null;
      this.markdown = '';
      this.renderQueued = false;
      this.streaming = false;
      this.copyTimer = 0;
      this.build();
    }

    build() {
      const H = this.handlers;

      this.lineText = h('span', { class: 'line-text', 'aria-hidden': 'true' });
      this.lineLive = h('span', { class: 'sr-only' });
      this.line = h('p', { class: 'line', id: 'renard-line' }, [this.lineText, this.lineLive]);

      this.expandBtn = iconButton('expand', 'Expand', () => H.onExpand(), { 'aria-pressed': 'false' });
      this.expandBtn.append(R.icon('collapse'));
      const closeBtn = iconButton('close', 'Close', () => H.onClose());
      const head = h('header', { class: 'head' }, [this.line, h('div', { class: 'head-actions' }, [this.expandBtn, closeBtn])]);

      this.noticeText = h('p', { class: 'notice-text' });
      this.settingsBtn = h('button', { class: 'btn', type: 'button', onclick: () => H.onOpenSettings() }, 'Open settings');
      this.notice = h('div', { class: 'notice', hidden: true }, [this.noticeText, this.settingsBtn]);

      this.askedText = h('span', { class: 'asked-text' });
      this.copyBtn = iconButton('copy', 'Copy answer', () => this.copy(), { 'data-copied': 'false' });
      this.copyBtn.classList.add('copy-btn');
      this.copyBtn.append(R.icon('check'));
      this.clearBtn = iconButton('clear', 'Clear question and answer', () => H.onClear());
      this.note = h('p', { class: 'note', hidden: true });
      this.answer = h('div', { class: 'answer', tabindex: '0', role: 'region', 'aria-label': 'Answer' });
      this.qa = h('div', { class: 'qa', hidden: true }, [
        h('div', { class: 'qa-head' }, [h('p', { class: 'asked' }, [h('span', { class: 'asked-label' }, 'You asked: '), this.askedText]), this.copyBtn, this.clearBtn]),
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
          this.form.requestSubmit();
        }
      });

      this.readChat = h('input', { type: 'checkbox', role: 'switch', class: 'switch-input' });
      this.readChat.addEventListener('change', () => H.onReadChatChange(this.readChat.checked));
      const readChatLabel = h('label', { class: 'switch', title: 'Include the chat on this page with your question' }, [
        this.readChat,
        h('span', { class: 'switch-track', 'aria-hidden': 'true' }, [h('span', { class: 'switch-thumb' })]),
        R.icon('chat'),
        h('span', { class: 'switch-label' }, 'Read chat'),
      ]);

      this.sendLabel = h('span', {}, 'Ask');
      this.sendBtn = h('button', { type: 'submit', class: 'btn btn-primary send-btn' }, [R.icon('stop'), this.sendLabel]);
      this.form = h('form', { class: 'ask' }, [
        h('div', { class: 'input-box' }, [this.input, h('span', { class: 'block-caret', 'aria-hidden': 'true' })]),
        h('div', { class: 'ask-row' }, [readChatLabel, this.sendBtn]),
      ]);
      this.form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (this.streaming) H.onStop();
        else H.onSubmit(this.input.value);
      });

      // A resize handle on each corner; dragging one moves that corner while
      // the opposite corner stays put.
      this.corners = ['nw', 'ne', 'sw', 'se'].map((corner) => {
        const el = h('div', { class: `corner corner-${corner}`, 'data-corner': corner, title: 'Drag to resize' }, [R.icon('grip')]);
        this.bindCorner(el, corner);
        return el;
      });

      this.el = h(
        'section',
        {
          class: 'bubble px-box',
          role: 'dialog',
          'aria-labelledby': 'renard-line',
          'data-open': 'false',
          'data-side': 'left',
          'data-expanded': 'false',
        },
        [R.tail(5), head, this.notice, this.qa, this.status, this.form, ...this.corners],
      );
    }

    // ---- open / close / placement ---------------------------------------

    open() {
      this.isOpen = true;
      this.el.dataset.open = 'true';
    }

    close() {
      this.isOpen = false;
      this.el.dataset.open = 'false';
    }

    contains(node) {
      return this.el.contains(node);
    }

    // anchor 'bottom': offset is the distance from the viewport bottom and the
    // bubble grows upward; anchor 'top': offset is the top, growing downward.
    // height: a fixed height (from resizing), or 0 to fit the content.
    place({ side, anchor, offset, left, width, height = 0, maxHeight, tailOffset, expanded, expandedHeight }) {
      const s = this.el.style;
      this.el.dataset.side = side;
      this.el.dataset.anchor = anchor;
      this.el.dataset.expanded = expanded ? 'true' : 'false';
      this.expandBtn.setAttribute('aria-pressed', expanded ? 'true' : 'false');
      this.expandBtn.setAttribute('aria-label', expanded ? 'Shrink' : 'Expand');
      this.expandBtn.title = expanded ? 'Shrink' : 'Expand';
      s.left = `${Math.round(left)}px`;
      s.top = anchor === 'top' ? `${Math.round(offset)}px` : 'auto';
      s.bottom = anchor === 'top' ? 'auto' : `${Math.round(offset)}px`;
      s.setProperty('--w', `${Math.round(width)}px`);
      s.setProperty('--max-h', `${Math.round(maxHeight)}px`);
      s.setProperty('--tail-offset', `${Math.round(tailOffset)}px`);
      s.setProperty('--expanded-h', `${Math.round(expandedHeight)}px`);
      s.setProperty('--h', height ? `${Math.round(height)}px` : 'auto');
      this.el.dataset.sized = height ? 'true' : 'false';
    }

    hasAnswer() {
      return !this.qa.hidden;
    }

    focusPrimary() {
      if (!this.notice.hidden && this.form.hidden) this.settingsBtn.focus();
      else this.input.focus();
    }

    bindCorner(el, corner) {
      let start = null;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        start = { x: e.clientX, y: e.clientY, rect: this.el.getBoundingClientRect() };
        this.el.dataset.resizing = 'true';
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (!start) return;
        this.handlers.onResize({ corner, rect: start.rect, dx: e.clientX - start.x, dy: e.clientY - start.y });
      });
      const end = () => {
        if (!start) return;
        start = null;
        delete this.el.dataset.resizing;
        this.handlers.onResizeEnd();
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }

    // ---- content --------------------------------------------------------

    setLine(text, { onChar } = {}) {
      if (this.cancelType) this.cancelType();
      this.lineLive.textContent = text;
      this.cancelType = R.typewrite(this.lineText, text, { onChar });
    }

    // Blocked: no way to ask yet (no key, no API access). Shows the notice
    // with the settings button and hides the input.
    setBlocked(detail) {
      this.form.hidden = Boolean(detail);
      this.setNotice(detail ? { text: detail, settings: true } : null);
    }

    setNotice(notice) {
      if (!notice || (!notice.text && !notice.settings)) {
        this.notice.hidden = true;
        return;
      }
      this.notice.hidden = false;
      this.noticeText.textContent = notice.text || '';
      this.noticeText.hidden = !notice.text;
      this.settingsBtn.hidden = !notice.settings;
    }

    setReadChat(on) {
      this.readChat.checked = Boolean(on);
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

    startAnswer(question) {
      this.qa.hidden = false;
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
      if (streaming) {
        // Coalesce rapid deltas into one render per frame.
        if (!this.renderQueued) {
          this.renderQueued = true;
          requestAnimationFrame(() => {
            this.renderQueued = false;
            this.renderAnswer();
          });
        }
      } else {
        this.renderAnswer();
      }
    }

    renderAnswer() {
      const box = this.answer;
      const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      const frag = R.markdown.render(this.markdown);
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

    announce(text) {
      this.status.textContent = text;
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
      this.announce('Answer copied');
      this.copyTimer = setTimeout(() => {
        this.copyBtn.dataset.copied = 'false';
        this.copyBtn.setAttribute('aria-label', 'Copy answer');
      }, 1600);
    }
  };
})();
