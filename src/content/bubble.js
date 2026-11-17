// The speech bubble on the page: its outline, tail, and resize corners, with
// an extension frame (bubble/bubble.html) inside that holds everything the
// user reads and types. The site can see where the bubble is, but not into
// the frame. This class keeps the interface the app uses and relays it to
// the frame; the app decides where the bubble goes.
//
// The channel to the frame is a MessageChannel handed over with a secret
// key. The key goes from this script to the frame through the background
// script (extension messaging, which sites can't use), so a site that gets
// hold of the frame can't open a channel of its own. Every load of the frame
// (a reload, or the page moving Renard's element) gets a new channel and a
// replay of what the bubble shows.
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
      // What the frame shows, latest message per kind in the order they
      // were last set, replayed to a freshly loaded frame.
      this.state = new Map();
      // One-off requests (focus, prefill) made before the frame connected.
      this.pending = new Map();
      this.layout = null;
      this.minHeight = 0;
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

    // Registers the key (retrying a transient failure), then loads the
    // frame. Each time the frame loads, it gets a new channel.
    async connect() {
      for (const delay of [0, 500, 1500, 4000]) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (this.destroyed || !R.contextAlive()) return; // extension reloaded: this copy is leaving
        try {
          await R.send('renard:bubbleKey', { instance: this.instance, key: this.key });
          break;
        } catch {
          if (delay === 4000) return;
        }
      }
      if (this.destroyed) return;
      this.frame.addEventListener('load', () => this.handOver());
      // A page that unloads without unmounting still lets its key go.
      this.onPageHide = (e) => {
        if (!e.persisted) R.send('renard:bubbleKeyDrop', { instance: this.instance }).catch(() => {});
      };
      addEventListener('pagehide', this.onPageHide);
      this.frame.src = R.ext.runtime.getURL(`bubble/bubble.html?i=${this.instance}`);
    }

    handOver() {
      if (this.destroyed || !this.frame.contentWindow) return;
      if (this.port) this.port.close();
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => e.data && typeof e.data.type === 'string' && this.fromFrame(e.data);
      const origin = new URL(R.ext.runtime.getURL('')).origin;
      this.frame.contentWindow.postMessage({ renard: 'bubble', key: this.key }, origin, [channel.port2]);
      this.port = channel.port1;
      for (const m of this.state.values()) this.post(m);
      for (const m of this.pending.values()) this.post(m);
      this.pending.clear();
    }

    destroy() {
      this.destroyed = true;
      if (this.onPageHide) removeEventListener('pagehide', this.onPageHide);
      if (this.port) this.port.close();
      this.port = null;
      this.state.clear();
      this.pending.clear();
      R.send('renard:bubbleKeyDrop', { instance: this.instance }).catch(() => {});
    }

    // One message that fails to send is dropped; the channel stays.
    post(msg) {
      if (!this.port) return;
      try {
        this.port.postMessage(msg);
      } catch (err) {
        console.warn('[Renard] bubble message dropped:', err);
      }
    }

    // State: remembered for a reloaded frame, sent now if connected.
    keep(kind, msg) {
      this.state.delete(kind);
      this.state.set(kind, msg);
      this.post(msg);
    }

    // One-off: sent now, or once the frame connects.
    once(msg) {
      if (this.port) this.post(msg);
      else this.pending.set(msg.type, msg);
    }

    fromFrame(m) {
      const H = this.handlers;
      switch (m.type) {
        case 'height': {
          const px = Math.max(0, Math.min(10000, Math.round(Number(m.px) || 0)));
          this.el.style.setProperty('--frame-h', `${px}px`);
          // The least height that shows everything; resizing stops here.
          const min = Math.max(0, Math.min(10000, Math.round(Number(m.min) || 0)));
          if (min !== this.minHeight) {
            this.minHeight = min;
            if (this.handlers.onMinHeight) this.handlers.onMinHeight();
          }
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
          H.onClose(m.via === 'key' ? 'key' : 'pointer');
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
        case 'capture':
          H.onCapture();
          break;
        // A picture pasted or dropped into the frame, already scaled there.
        case 'attach':
          if (R.isAttachedImage(m.image)) H.onAttach(m.image);
          break;
        case 'detach':
          H.onAttach(null);
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
    // expanded: the reading view's height applies; pressed: the expand
    // button shows the reading view as on (before a question it only widens).
    place({ side, anchor, offset, left, width, height = 0, maxHeight, tailOffset, expanded, pressed = expanded, expandedHeight }) {
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
        expanded: Boolean(pressed),
        maxHeight: Math.round(maxHeight),
        pageHeight: innerHeight,
      };
      const key = JSON.stringify(layout);
      if (key !== this.layout) {
        this.layout = key;
        this.keep('layout', layout);
      }
    }

    hasAnswer() {
      return this.answering;
    }

    // Keyboard focus goes into the frame first; the frame then focuses its
    // input (or the settings button when asking is blocked).
    focusPrimary({ select = false } = {}) {
      this.frame.focus();
      this.once({ type: 'focus', select });
    }

    focusInput() {
      this.frame.focus();
      this.once({ type: 'focusInput' });
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
      this.keep('theme', { type: 'theme', theme, readable: Boolean(readable) });
    }

    setPrefs({ sound, shortcuts }) {
      this.keep('prefs', { type: 'prefs', sound: Boolean(sound), shortcuts: shortcuts || {} });
    }

    setLine(text) {
      this.keep('line', { type: 'line', text });
    }

    // Blocked: no way to ask yet (no key, no API access). Shows the notice
    // with the settings button and hides the input.
    setBlocked(detail) {
      this.keep('blocked', { type: 'blocked', detail: detail || '' });
    }

    setNotice(notice) {
      this.keep('notice', { type: 'notice', notice: notice || null });
    }

    setReadChat(on) {
      this.readChat.checked = Boolean(on);
      this.keep('readChat', { type: 'readChat', on: this.readChat.checked });
    }

    // "Read chat" on chat sites, "Read page" elsewhere.
    setReadLabel(text, title) {
      this.keep('readLabel', { type: 'readLabel', text, title });
    }

    // Puts text in the input unless the user has typed something.
    prefillDraft(text) {
      this.once({ type: 'prefill', text });
    }

    setDraft(text) {
      this.once({ type: 'draft', text });
    }

    // screenshot: an image went with the question.
    startAnswer(question, { screenshot = false } = {}) {
      this.answering = true;
      this.markdown = '';
      for (const kind of ['answer', 'note']) this.state.delete(kind);
      this.keep('start', { type: 'start', question, screenshot: Boolean(screenshot) });
    }

    // The image waiting to go with the next question, or null.
    setAttachment(image) {
      this.keep('attachment', { type: 'attachment', image: image || null });
    }

    // Whether screenshots can be attached, and why not when they can't.
    setImages(enabled, why = '') {
      this.keep('images', { type: 'images', enabled: Boolean(enabled), why });
    }

    reset() {
      this.answering = false;
      this.markdown = '';
      for (const kind of ['start', 'answer', 'note', 'notice']) this.state.delete(kind);
      this.post({ type: 'reset' });
    }

    setNote(text) {
      this.keep('note', { type: 'note', text });
    }

    // Streaming text goes over as deltas, so a long answer isn't resent on
    // every update; a reloaded frame gets the whole answer.
    setAnswer(markdown, { streaming = false } = {}) {
      const delta = streaming && this.markdown && markdown.startsWith(this.markdown) && markdown.length > this.markdown.length;
      const full = { type: 'answer', markdown, streaming };
      this.state.delete('answer');
      this.state.set('answer', full);
      this.post(delta ? { type: 'delta', text: markdown.slice(this.markdown.length) } : full);
      this.markdown = markdown;
    }

    announce(text) {
      this.post({ type: 'announce', text });
    }
  };
})();
