// The speech bubble on the page: its outline, tail, and resize corners, with
// an extension frame (bubble/bubble.html) inside that holds everything the
// user reads and types. The site can see where the bubble is, but not into
// the frame. This class keeps the interface the app uses and relays it to
// the frame; the app decides where the bubble goes.
//
// The channel to the frame is a MessageChannel handed over with a one-time
// key. The key goes from this script to the frame through the background
// script (extension messaging, which sites can't use), so a site that gets
// hold of the frame can't open a channel of its own.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});
  const { h } = R;

  function randomHex(bytes) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  R.Bubble = class {
    constructor(handlers) {
      this.handlers = handlers;
      this.isOpen = false;
      this.markdown = '';
      this.answering = false; // a question has been asked and not cleared
      this.readChat = { checked: false };
      this.port = null;
      this.queue = [];
      this.layout = null;
      this.instance = randomHex(12);
      this.key = randomHex(24);
      this.build();
      this.connect();
    }

    build() {
      this.frame = h('iframe', { class: 'bubble-frame', title: 'Renard', allow: 'clipboard-write' });

      // A resize handle on each corner; dragging one moves that corner while
      // the opposite corner stays put.
      this.corners = ['nw', 'ne', 'sw', 'se'].map((corner) => {
        const el = h('div', { class: `corner corner-${corner}`, 'data-corner': corner, title: 'Drag to resize' }, [R.icon('grip')]);
        this.bindCorner(el, corner);
        return el;
      });

      this.el = h(
        'section',
        { class: 'bubble px-box', 'data-open': 'false', 'data-side': 'left', 'data-expanded': 'false' },
        [R.tail(5), this.frame, ...this.corners],
      );
    }

    // Registers the key, then loads the frame; once it has loaded, hands it
    // one end of a MessageChannel along with the key.
    async connect() {
      try {
        await R.send('renard:bubbleKey', { instance: this.instance, key: this.key });
      } catch {
        return; // extension reloaded; this copy is on its way out
      }
      const origin = new URL(R.ext.runtime.getURL('')).origin;
      this.frame.addEventListener(
        'load',
        () => {
          const channel = new MessageChannel();
          channel.port1.onmessage = (e) => e.data && typeof e.data.type === 'string' && this.fromFrame(e.data);
          this.frame.contentWindow.postMessage({ renard: 'bubble', key: this.key }, origin, [channel.port2]);
          this.port = channel.port1;
          const queued = this.queue;
          this.queue = [];
          for (const m of queued) this.port.postMessage(m);
        },
        { once: true },
      );
      this.frame.src = R.ext.runtime.getURL(`bubble/bubble.html?i=${this.instance}`);
    }

    destroy() {
      if (this.port) this.port.close();
      this.port = null;
      this.queue = [];
    }

    // Messages wait until the frame has connected.
    send(msg) {
      if (this.port) {
        try {
          this.port.postMessage(msg);
          return;
        } catch {
          this.port = null;
        }
      }
      this.queue.push(msg);
    }

    fromFrame(m) {
      const H = this.handlers;
      switch (m.type) {
        case 'height': {
          const px = Math.max(0, Math.min(10000, Math.round(Number(m.px) || 0)));
          this.el.style.setProperty('--frame-h', `${px}px`);
          break;
        }
        case 'submit':
          this.readChat.checked = Boolean(m.readChat);
          H.onSubmit(String(m.question || '').slice(0, 20000));
          break;
        case 'stop':
          H.onStop();
          break;
        case 'close':
          H.onClose();
          break;
        case 'expand':
          H.onExpand();
          break;
        case 'clear':
          H.onClear();
          break;
        case 'settings':
          H.onOpenSettings();
          break;
        case 'readChat':
          this.readChat.checked = Boolean(m.on);
          H.onReadChatChange(this.readChat.checked);
          break;
        case 'command':
          if (m.cmd === 'toggle-bubble' || m.cmd === 'toggle-visibility') H.onCommand(m.cmd);
          break;
        case 'blip':
          H.onBlip();
          break;
        default:
          break;
      }
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
      s.left = `${Math.round(left)}px`;
      s.top = anchor === 'top' ? `${Math.round(offset)}px` : 'auto';
      s.bottom = anchor === 'top' ? 'auto' : `${Math.round(offset)}px`;
      s.setProperty('--w', `${Math.round(width)}px`);
      s.setProperty('--max-h', `${Math.round(maxHeight)}px`);
      s.setProperty('--tail-offset', `${Math.round(tailOffset)}px`);
      s.setProperty('--expanded-h', `${Math.round(expandedHeight)}px`);
      s.setProperty('--h', height ? `${Math.round(height)}px` : 'auto');
      this.el.dataset.sized = height ? 'true' : 'false';
      const layout = {
        type: 'layout',
        side,
        fill: Boolean(height || expanded),
        expanded: Boolean(expanded),
        maxHeight: Math.round(maxHeight),
        pageHeight: innerHeight,
      };
      const key = JSON.stringify(layout);
      if (key !== this.layout) {
        this.layout = key;
        this.send(layout);
      }
    }

    hasAnswer() {
      return this.answering;
    }

    // Keyboard focus goes into the frame first; the frame then focuses its
    // input (or the settings button when asking is blocked).
    focusPrimary({ select = false } = {}) {
      this.frame.focus();
      this.send({ type: 'focus', select });
    }

    focusInput() {
      this.frame.focus();
      this.send({ type: 'focusInput' });
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

    // ---- content (relayed to the frame) ------------------------------------

    setTheme(theme, readable) {
      this.send({ type: 'theme', theme, readable: Boolean(readable) });
    }

    setPrefs({ sound, shortcuts }) {
      this.send({ type: 'prefs', sound: Boolean(sound), shortcuts: shortcuts || {} });
    }

    setLine(text) {
      this.send({ type: 'line', text });
    }

    // Blocked: no way to ask yet (no key, no API access). Shows the notice
    // with the settings button and hides the input.
    setBlocked(detail) {
      this.send({ type: 'blocked', detail: detail || '' });
    }

    setNotice(notice) {
      this.send({ type: 'notice', notice: notice || null });
    }

    setReadChat(on) {
      this.readChat.checked = Boolean(on);
      this.send({ type: 'readChat', on: this.readChat.checked });
    }

    // "Read chat" on chat sites, "Read page" elsewhere.
    setReadLabel(text, title) {
      this.send({ type: 'readLabel', text, title });
    }

    // Puts text in the input unless the user has typed something.
    prefillDraft(text) {
      this.send({ type: 'prefill', text });
    }

    setDraft(text) {
      this.send({ type: 'draft', text });
    }

    startAnswer(question) {
      this.answering = true;
      this.markdown = '';
      this.send({ type: 'start', question });
    }

    reset() {
      this.answering = false;
      this.markdown = '';
      this.send({ type: 'reset' });
    }

    setNote(text) {
      this.send({ type: 'note', text });
    }

    // Streaming text goes over as deltas, so a long answer isn't resent on
    // every update.
    setAnswer(markdown, { streaming = false } = {}) {
      if (streaming && this.markdown && markdown.startsWith(this.markdown) && markdown.length > this.markdown.length) {
        this.send({ type: 'delta', text: markdown.slice(this.markdown.length) });
      } else {
        this.send({ type: 'answer', markdown, streaming });
      }
      this.markdown = markdown;
    }

    announce(text) {
      this.send({ type: 'announce', text });
    }
  };
})();
