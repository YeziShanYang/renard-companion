// The fox on the page: position in a side margin, walking, dragging, and
// the small speech tag that shows canned lines while the bubble is closed.
// Its horizontal place is an "inset": the gap between the screen edge it
// belongs to and the near side of its body.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  const SCALE = 3; // integer scaling only: 32px frames shown at 96px
  const SIZE = R.FRAME * SCALE;
  // Hit area (the drawn fox) inside the 96px frame box; matches .fox-hit in CSS.
  const HIT_LEFT = 9;
  const HIT_WIDTH = 78;
  const TOP_EMPTY = 13 * SCALE; // empty rows above the fox's ears in each frame
  const DRAG_THRESHOLD = 5;

  R.Fox = class {
    static bodyWidth = HIT_WIDTH;

    constructor({ sheet, fallback, onActivate, onDragStart, onDragEnd, onHover }) {
      this.onActivate = onActivate;
      this.onDragStart = onDragStart;
      this.onDragEnd = onDragEnd;
      this.onHover = onHover;

      this.x = 0;
      this.y = 0;
      this.edge = 'right';
      this.facing = 'left';
      this.motion = null;
      this.press = null;
      this.dragEndedAt = -Infinity;
      this.cancelType = null;
      this.tagTimer = 0;

      this.canvas = R.h('canvas', { class: 'fox-canvas', 'aria-hidden': 'true' });
      this.button = R.h('button', {
        class: 'fox-hit',
        type: 'button',
        'aria-label': 'Renard, your fox helper. Open the question bubble.',
        'aria-expanded': 'false',
        'aria-haspopup': 'dialog',
      });
      this.art = R.h('div', { class: 'fox-art' }, [this.canvas]);
      this.tagText = R.h('span', { class: 'tag-text', 'aria-hidden': 'true' });
      this.tagLive = R.h('span', { class: 'sr-only', role: 'status' });
      this.tag = R.h('div', { class: 'tag px-box', 'data-show': 'false' }, [this.tagText, R.tail(4)]);
      this.el = R.h('div', { class: 'fox', 'data-edge': 'right' }, [this.button, this.art, this.tag, this.tagLive]);

      this.sprite = new R.Sprite(this.canvas, sheet, fallback);
      this.bindPointer();
    }

    // ---- geometry ---------------------------------------------------------

    // Box x for a fox whose body sits `inset` px from the given screen edge.
    xFor(edge, inset) {
      return edge === 'left' ? inset - HIT_LEFT : innerWidth - inset - HIT_LEFT - HIT_WIDTH;
    }

    insetOf(edge) {
      return edge === 'left' ? this.x + HIT_LEFT : innerWidth - (this.x + HIT_LEFT + HIT_WIDTH);
    }

    offscreenX(edge) {
      return edge === 'left' ? -SIZE : innerWidth + 4;
    }

    yBounds() {
      return { min: -TOP_EMPTY + 4, max: Math.max(-TOP_EMPTY + 4, innerHeight - SIZE - 4) };
    }

    yFromFrac(f) {
      const { min, max } = this.yBounds();
      return Math.round(min + Math.min(1, Math.max(0, f)) * (max - min));
    }

    fracFromY(y) {
      const { min, max } = this.yBounds();
      return max === min ? 0 : (y - min) / (max - min);
    }

    clampY(y) {
      const { min, max } = this.yBounds();
      return Math.min(max, Math.max(min, y));
    }

    nearestEdge() {
      return this.x + SIZE / 2 < innerWidth / 2 ? 'left' : 'right';
    }

    // Rectangle of the visible fox (the hit area), in viewport coordinates.
    rect() {
      return this.button.getBoundingClientRect();
    }

    apply() {
      this.el.style.transform = `translate(${Math.round(this.x)}px, ${Math.round(this.y)}px)`;
    }

    face(direction) {
      this.facing = direction;
      this.el.dataset.facing = direction; // the sheet faces right; CSS flips for left
    }

    faceIntoPage() {
      this.face(this.edge === 'right' ? 'left' : 'right');
    }

    setEdge(edge) {
      this.edge = edge;
      this.el.dataset.edge = edge;
    }

    // Keeps the fox in its margin after the window resizes.
    reflow(yFrac, inset) {
      if (this.motion || this.press) return;
      this.x = this.xFor(this.edge, inset);
      this.y = this.yFromFrac(yFrac);
      this.apply();
    }

    // ---- motion -----------------------------------------------------------

    cancelMotion() {
      if (this.motion) {
        cancelAnimationFrame(this.motion.raf);
        const done = this.motion.resolve;
        this.motion = null;
        done(false);
      }
    }

    // Constant-speed walk along x. Resolves true on arrival, false if cancelled.
    walkTo(targetX, speed = 160) {
      this.cancelMotion();
      if (R.reducedMotion()) {
        this.x = targetX;
        this.apply();
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        let last = performance.now();
        const motion = { resolve, raf: 0 };
        const step = (now) => {
          const dt = Math.min(50, now - last) / 1000;
          last = now;
          const d = targetX - this.x;
          const move = speed * dt;
          if (Math.abs(d) <= move) {
            this.x = targetX;
            this.apply();
            this.motion = null;
            resolve(true);
            return;
          }
          this.x += Math.sign(d) * move;
          this.apply();
          motion.raf = requestAnimationFrame(step);
        };
        motion.raf = requestAnimationFrame(step);
        this.motion = motion;
      });
    }

    // Eased move used for the entrance pounce and sliding away.
    tweenTo(targetX, duration, ease = (t) => 1 - (1 - t) ** 3) {
      this.cancelMotion();
      if (R.reducedMotion() || duration <= 0) {
        this.x = targetX;
        this.apply();
        return Promise.resolve(true);
      }
      const startX = this.x;
      const start = performance.now();
      return new Promise((resolve) => {
        const motion = { resolve, raf: 0 };
        const step = (now) => {
          const t = Math.min(1, (now - start) / duration);
          this.x = startX + (targetX - startX) * ease(t);
          this.apply();
          if (t >= 1) {
            this.motion = null;
            resolve(true);
            return;
          }
          motion.raf = requestAnimationFrame(step);
        };
        motion.raf = requestAnimationFrame(step);
        this.motion = motion;
      });
    }

    // ---- input ------------------------------------------------------------

    bindPointer() {
      const b = this.button;
      b.addEventListener('pointerdown', (e) => {
        this.el.dataset.pointer = 'true';
        if (e.button !== 0) return;
        this.press = { sx: e.clientX, sy: e.clientY, ox: e.clientX - this.x, oy: e.clientY - this.y, dragging: false };
        b.setPointerCapture(e.pointerId);
      });
      b.addEventListener('pointermove', (e) => {
        const p = this.press;
        if (!p) return;
        if (!p.dragging) {
          if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < DRAG_THRESHOLD) return;
          p.dragging = true;
          this.cancelMotion();
          this.el.dataset.dragging = 'true';
          this.onDragStart();
        }
        this.x = e.clientX - p.ox;
        this.y = this.clampY(e.clientY - p.oy);
        this.apply();
      });
      const end = () => {
        const p = this.press;
        this.press = null;
        if (p && p.dragging) {
          this.dragEndedAt = performance.now();
          delete this.el.dataset.dragging;
          this.onDragEnd();
        }
      };
      b.addEventListener('pointerup', end);
      b.addEventListener('pointercancel', end);
      b.addEventListener('lostpointercapture', end);
      // Activation goes through click so Enter and Space work too.
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        // The click that ends a drag is not an activation.
        if (performance.now() - this.dragEndedAt < 400) return;
        this.onActivate();
      });
      b.addEventListener('pointerenter', () => this.onHover());
    }

    // ---- speech tag -------------------------------------------------------

    say(text, { duration, onChar } = {}) {
      clearTimeout(this.tagTimer);
      if (this.cancelType) this.cancelType();
      if (!text) {
        this.hush();
        return;
      }
      this.tag.dataset.show = 'true';
      this.tagLive.textContent = text;
      this.cancelType = R.typewrite(this.tagText, text, { onChar });
      const ms = duration ?? 1800 + text.length * 45;
      this.tagTimer = setTimeout(() => this.hush(), ms);
    }

    hush() {
      clearTimeout(this.tagTimer);
      this.tag.dataset.show = 'false';
    }

    setExpanded(open) {
      this.button.setAttribute('aria-expanded', open ? 'true' : 'false');
      this.button.setAttribute(
        'aria-label',
        open ? 'Renard, your fox helper. Close the question bubble.' : 'Renard, your fox helper. Open the question bubble.',
      );
    }
  };
})();
