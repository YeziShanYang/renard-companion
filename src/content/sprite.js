// Frame-stepping sprite animator. Draws one 32×32 frame at a time onto a
// small canvas that CSS scales up with pixelated rendering. Frames advance
// on timers rather than a constant animation-frame loop, so an idle fox
// costs almost nothing.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  R.FRAME = 32;

  // Row layout of Elthen's "2D Pixel Art Fox Sprites" sheet: 32×32 frames,
  // 14 columns × 7 rows, fox facing right, feet on the bottom pixel row.
  R.ANIMS = {
    idle: { row: 0, frames: 5, ms: 170, loop: true },
    look: { row: 1, frames: 14, ms: 110 },
    walk: { row: 2, frames: 8, ms: 85, loop: true },
    pounce: { row: 3, frames: 11, ms: 65 },
    startled: { row: 4, frames: 5, ms: 90 },
    sleep: { row: 5, frames: 6, ms: 150 },
    fall: { row: 6, frames: 7, ms: 95 },
  };

  R.Sprite = class {
    constructor(canvas, sheet, fallback) {
      this.canvas = canvas;
      canvas.width = R.FRAME;
      canvas.height = R.FRAME;
      this.ctx = canvas.getContext('2d');
      this.ctx.imageSmoothingEnabled = false;
      this.sheet = sheet; // ImageBitmap of the sprite sheet, or null
      this.fallback = fallback; // 16×16 static icon used when the sheet is missing
      this.timer = 0;
      this.anim = null;
      this.name = null;
      this.step = 0;
    }

    // Plays an animation. A later play() cancels the earlier one, including
    // its onEnd callback. ms overrides the frame duration; with keep, an
    // already-running loop of the same animation only changes tempo instead
    // of restarting (so a run can speed up and slow down smoothly).
    play(name, { loop, reverse = false, onEnd, ms, keep = false } = {}) {
      if (keep && this.name === name && this.anim && this.anim.loop) {
        if (ms) this.anim.ms = ms;
        return;
      }
      clearTimeout(this.timer);
      const base = R.ANIMS[name];
      this.name = name;
      this.anim = { ...base, loop: loop ?? base.loop, reverse, onEnd, ms: ms || base.ms };
      this.step = 0;
      this.draw();
      this.schedule();
    }

    // Shows a single frame and stops (used for held poses).
    hold(name, frame) {
      clearTimeout(this.timer);
      const base = R.ANIMS[name];
      this.name = name;
      this.anim = { ...base, loop: false, reverse: false, onEnd: null };
      this.step = Math.max(0, Math.min(base.frames - 1, frame ?? base.frames - 1));
      this.draw();
    }

    schedule() {
      const a = this.anim;
      this.timer = setTimeout(() => {
        this.step++;
        if (this.step >= a.frames) {
          if (a.loop) {
            this.step = 0;
          } else {
            this.step = a.frames - 1;
            this.draw();
            const done = a.onEnd;
            a.onEnd = null;
            if (done) done();
            return;
          }
        }
        this.draw();
        this.schedule();
      }, a.ms);
    }

    draw() {
      const a = this.anim;
      const ctx = this.ctx;
      const F = R.FRAME;
      ctx.clearRect(0, 0, F, F);
      if (this.sheet) {
        const col = a.reverse ? a.frames - 1 - this.step : this.step;
        ctx.drawImage(this.sheet, col * F, a.row * F, F, F, 0, 0, F, F);
      } else if (this.fallback) {
        ctx.drawImage(this.fallback, 8, 16);
      }
    }

    stop() {
      clearTimeout(this.timer);
    }
  };
})();
