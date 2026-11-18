// What the fox says: canned lines picked from src/lines.json, and the
// optional blip that goes with the typewriter.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  R.LinePicker = class {
    constructor(lines) {
      this.lines = lines || {};
      this.last = {};
    }

    pick(category, vars = {}) {
      const pool = this.lines[category] || [''];
      let choice = pool[Math.floor(Math.random() * pool.length)];
      if (pool.length > 1) {
        while (choice === this.last[category]) choice = pool[Math.floor(Math.random() * pool.length)];
      }
      this.last[category] = choice;
      return choice.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : ''));
    }
  };

  // Short square-wave blip for the typewriter. Off unless the user enables it.
  R.Blipper = class {
    constructor() {
      this.ctx = null;
      this.enabled = false;
    }

    blip() {
      if (!this.enabled) return;
      try {
        this.ctx = this.ctx || new AudioContext();
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 760 + Math.random() * 140;
        gain.gain.setValueAtTime(0.025, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(t);
        osc.stop(t + 0.05);
      } catch {
        // Audio is decorative; ignore failures (autoplay policy, no device).
      }
    }

    close() {
      if (this.ctx) this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  };
})();
