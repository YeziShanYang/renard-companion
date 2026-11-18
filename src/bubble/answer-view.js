// The answer area of the bubble: the answer's Markdown rendered, re-rendered
// as it streams in, with a cursor at its end. Renders wait while the user is
// pressing in the answer or has text selected in it, and a long answer that
// gets slow to format streams as plain text until it's done.
(function () {
  const R = globalThis.Renard;
  const { h } = R;

  R.AnswerView = class {
    // onRender: called after each render (the content's height may have
    // changed).
    constructor({ onRender }) {
      this.onRender = onRender;
      this.markdown = '';
      this.streaming = false;
      this.renderQueued = false;
      this.el = h('div', { class: 'answer', tabindex: '0', role: 'region', 'aria-label': 'Answer' });
      this.box = h('div', { class: 'answer-box' }, [this.el]);
      // A press in the answer holds streaming renders until shortly after it
      // ends, so the click it makes lands on the element it started on.
      this.el.addEventListener('pointerdown', () => {
        clearTimeout(this.pressTimer);
        this.pressing = true;
      });
      const release = () => {
        clearTimeout(this.pressTimer);
        this.pressTimer = setTimeout(() => (this.pressing = false), 150);
      };
      document.addEventListener('pointerup', release);
      document.addEventListener('pointercancel', release);
    }

    // Shows markdown, still streaming in or finished.
    show(markdown, streaming) {
      this.markdown = markdown;
      this.streaming = streaming;
      this.el.setAttribute('aria-busy', streaming ? 'true' : 'false');
      if (!markdown) {
        this.renderCost = 0;
        this.plainStream = false;
      }
      if (streaming) this.queueRender();
      else this.render();
    }

    // Coalesces rapid deltas into one render per frame. Each render re-parses
    // and replaces the whole answer, so once that gets slow the renders are
    // spaced to take at most about a quarter of the time.
    queueRender() {
      if (this.renderQueued) return;
      this.renderQueued = true;
      const delay = this.renderCost > 8 ? Math.min(400, this.renderCost * 3) : 0;
      setTimeout(() => {
        requestAnimationFrame(() => {
          this.renderQueued = false;
          if (!this.streaming) return;
          // Replacing the answer would drop a selection, or the link or
          // Copy button being clicked, so the render waits for them.
          if (this.held()) {
            setTimeout(() => this.queueRender(), 200);
            return;
          }
          this.render();
        });
      }, delay);
    }

    held() {
      if (this.pressing) return true;
      const sel = getSelection();
      return Boolean(sel && !sel.isCollapsed && sel.rangeCount && this.el.contains(sel.getRangeAt(0).commonAncestorContainer));
    }

    render() {
      const box = this.el;
      const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      const started = performance.now();
      // An answer too slow to re-format on every update streams as plain
      // text and is formatted once at the end.
      const frag = this.streaming && this.plainStream ? R.markdown.plainBlock(this.markdown) : R.markdown.render(this.markdown);
      if (this.streaming) {
        // Put the cursor right after the last character: descend while the
        // last node is an element (list item, paragraph, code), but stop at
        // tables, formulas, and elements followed by trailing text.
        let target = frag.lastElementChild;
        while (target && target.lastElementChild && target.lastElementChild === target.lastChild && !/^(TABLE|DIV)$/.test(target.tagName) && !target.classList.contains('math')) {
          target = target.lastElementChild;
        }
        (target || frag).append(h('span', { class: 'stream-cursor', 'aria-hidden': 'true' }));
      }
      box.replaceChildren(frag);
      this.onRender();
      if (this.streaming && pinned) box.scrollTop = box.scrollHeight;
      // The whole cost, layout included, which can be several times the
      // parse itself on a long answer.
      this.renderCost = performance.now() - started;
      if (this.streaming && this.renderCost > 100) this.plainStream = true;
    }
  };
})();
