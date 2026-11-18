// What the fox does on its own and when it's clicked or dragged: running
// in, idling, looking around, wandering its margin, napping, reacting,
// getting dizzy, hiding and leaving.
//
// These are methods of R.App (app.js mixes them in), kept here so app.js
// can stay about wiring the parts together. They use the app's fox, bubble
// and timers, and call back into it to open or close the bubble
// (openBubble, closeBubble), to find out whether Renard can answer
// (blocker), for canned lines (line, blip) and to leave (cancelAsk,
// unmount). The fox's state is this.mode, one of:
//   entering, idle, wandering, walking (back after a drag), dragging,
//   thinking, reacting, sleeping, waking, blocked (asleep until setup is
//   done), dizzy, hidden, leaving
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  const SLEEP_AFTER_MS = 5 * 60 * 1000;
  const LOOK_MIN_MS = 20000;
  const LOOK_MAX_MS = 40000;
  const WANDER_MIN_MS = 12000;
  const WANDER_MAX_MS = 30000;
  const WANDER_SPEED = 91; // px/s: an amble, slower than running back after a drag
  const WANDER_RANGE_Y = 110; // px above or below its home height a stroll may go
  const RUN_SPEED = 221;
  const ENTER_SPEED = 286; // the trot in from off-screen
  const LEAP = 120; // entrance: the last stretch is a pounce
  const DEFAULT_POSITION = { edge: 'right', y: 0.7 };
  const DIZZY_CLICKS = 10;
  const DIZZY_WINDOW_MS = 3000;
  const { EDGE_GAP } = R.layout;

  // The fox is mid-move: reactions, clicks and the bubble wait until it lands,
  // so nothing can strand it walking in place.
  const MOVING = ['entering', 'walking', 'dragging', 'leaving'];

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function attempt(fn, fallback = null) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  R.FoxBehavior = {
    // The fox's state before it runs in.
    initFox() {
      this.mode = 'entering';
      this.yFrac = DEFAULT_POSITION.y; // current height (fraction of the usable range)
      this.yHome = DEFAULT_POSITION.y; // remembered height; strolls stay near it
      this.inset = EDGE_GAP;
      this.clicks = [];
      this.hidden = false;
    },

    setMode(mode) {
      this.mode = mode;
      this.fox.el.dataset.mode = mode;
    },

    moving() {
      return MOVING.includes(this.mode);
    },

    // returning: the fox was already out on this site in this tab, on the
    // page before this one. It stays where it was rather than running in and
    // greeting again.
    async enter({ returning = false } = {}) {
      const pos = this.state.position || DEFAULT_POSITION;
      const f = this.fox;
      this.yFrac = pos.y;
      this.yHome = pos.y;
      // Arriving back, it takes the same spot on every page of the site.
      const { min, max } = this.marginRange(pos.edge);
      this.inset = returning ? Math.round((min + max) / 2) : this.randomInset(pos.edge);
      f.setEdge(pos.edge);
      f.y = f.yFromFrac(pos.y);
      f.x = returning ? f.xFor(pos.edge, this.inset) : f.offscreenX(pos.edge);
      f.faceIntoPage();
      f.apply();
      if (returning) {
        this.rest();
        return;
      }
      this.setMode('entering');
      // Trot in from off-screen, then pounce the last stretch into place.
      const target = f.xFor(pos.edge, this.inset);
      const dir = Math.sign(target - f.x);
      if (Math.abs(target - f.x) > LEAP + 24) {
        const path = R.meander({ x: f.x, y: f.y }, { x: target - dir * LEAP, y: f.y }, { wiggle: 28, hops: false, bounds: this.roamBounds() });
        if (!(await f.followPath(path, ENTER_SPEED)) || this.mode !== 'entering') return;
      }
      f.faceIntoPage();
      f.sprite.play('pounce');
      if (!(await f.tweenTo(target, R.ANIMS.pounce.frames * R.ANIMS.pounce.ms)) || this.mode !== 'entering') return;
      const blocked = this.blocker();
      if (blocked) {
        this.sleepBlocked();
        f.say(this.line(blocked.line), { onChar: this.blip, duration: 5000 });
      } else {
        this.idle();
        f.say(this.line('greeting'), { onChar: this.blip });
      }
    },

    idle() {
      this.setMode('idle');
      this.fox.sprite.play('idle');
      this.scheduleLook();
      this.scheduleSleep();
      this.scheduleWander();
    },

    // ---- margins and wandering ------------------------------------------

    // Range of insets that keep the fox in the margin beside the site's
    // content column (see layout.js).
    marginRange(edge) {
      return R.layout.margins(edge, {
        viewportWidth: innerWidth,
        composer: attempt(() => this.adapter.composerRect()),
        bodyWidth: R.Fox.bodyWidth,
      });
    },

    // A random resting spot in the margin, preferably a little away from `avoid`.
    randomInset(edge, avoid) {
      const { min, max } = this.marginRange(edge);
      const span = max - min;
      if (span < 8) return min;
      let pick = min + Math.random() * span;
      for (let i = 0; i < 6 && avoid != null && Math.abs(pick - avoid) < Math.min(48, span / 2); i++) {
        pick = min + Math.random() * span;
      }
      return Math.round(pick);
    },

    // Where the fox may roam: fully on screen, anywhere vertically.
    roamBounds() {
      const f = this.fox;
      const { min, max } = f.yBounds();
      return { minX: f.xFor('left', EDGE_GAP / 2), maxX: f.xFor('right', EDGE_GAP / 2), minY: min, maxY: max };
    },

    scheduleWander() {
      clearTimeout(this.timers.wander);
      this.timers.wander = setTimeout(() => this.wander(), WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS));
    },

    // Ambles to another spot in the same margin. Not an interaction, so the
    // nap timer keeps running.
    async wander() {
      if (this.mode !== 'idle' || this.bubble.isOpen || this.hidden || R.reducedMotion()) {
        this.scheduleWander();
        return;
      }
      const f = this.fox;
      const next = this.randomInset(f.edge, this.inset);
      const home = f.yFromFrac(this.yHome);
      const target = { x: f.xFor(f.edge, next), y: Math.round(f.clampY(home + (Math.random() * 2 - 1) * WANDER_RANGE_Y)) };
      if (Math.hypot(target.x - f.x, target.y - f.y) < 16) {
        this.scheduleWander();
        return;
      }
      this.setMode('wandering');
      const path = R.meander({ x: f.x, y: f.y }, target, { wiggle: 40, bounds: this.roamBounds() });
      const arrived = await f.followPath(path, WANDER_SPEED);
      if (!arrived || this.mode !== 'wandering') return;
      this.inset = next;
      this.yFrac = f.fracFromY(f.y);
      f.faceIntoPage();
      this.setMode('idle');
      f.sprite.play('idle');
      this.scheduleWander();
    },

    // Stops a wander in place (before opening the bubble, hiding, etc.).
    haltWander() {
      if (this.mode !== 'wandering') return;
      this.fox.cancelMotion();
      this.inset = this.fox.insetOf(this.fox.edge);
      this.yFrac = this.fox.fracFromY(this.fox.y);
      this.fox.faceIntoPage();
      this.setMode('idle');
      this.fox.sprite.play('idle');
    },

    // ---- resting, napping, reacting ---------------------------------------

    // Back to the resting pose: idle, or asleep while setup is incomplete.
    rest() {
      if (this.hidden) return;
      if (this.blocker()) this.sleepBlocked();
      else this.idle();
    },

    scheduleLook() {
      clearTimeout(this.timers.look);
      this.timers.look = setTimeout(() => {
        if (this.mode === 'idle' && !R.reducedMotion()) {
          this.fox.sprite.play('look', {
            onEnd: () => {
              if (this.mode === 'idle') this.fox.sprite.play('idle');
            },
          });
        }
        this.scheduleLook();
      }, LOOK_MIN_MS + Math.random() * (LOOK_MAX_MS - LOOK_MIN_MS));
    },

    scheduleSleep() {
      clearTimeout(this.timers.sleep);
      this.timers.sleep = setTimeout(() => {
        if (this.mode === 'idle' && !this.bubble.isOpen) this.fallAsleep();
        else this.scheduleSleep();
      }, SLEEP_AFTER_MS);
    },

    // Any interaction postpones the nap.
    touch() {
      if (this.mode === 'idle') this.scheduleSleep();
    },

    fallAsleep() {
      this.setMode('sleeping');
      this.fox.sprite.play('sleep');
      this.fox.say(this.line('sleep'), { duration: 4000 });
    },

    sleepBlocked() {
      this.setMode('blocked');
      this.fox.sprite.play('sleep');
    },

    wake() {
      this.setMode('waking');
      return new Promise((resolve) => this.fox.sprite.play('sleep', { reverse: true, onEnd: resolve }));
    },

    think() {
      if (this.hidden || this.moving()) return;
      this.setMode('thinking');
      this.fox.sprite.play('look', { loop: true });
    },

    // One-shot reaction animation, then `then` (or back to rest).
    react(anim, then) {
      if (this.hidden || this.moving()) return;
      this.setMode('reacting');
      this.fox.sprite.play(anim, {
        onEnd: () => {
          if (this.mode !== 'reacting') return;
          if (then) then();
          else this.rest();
        },
      });
    },

    dizzy() {
      this.haltWander();
      this.closeBubble(false);
      this.setMode('dizzy');
      this.fox.say(this.line('dizzy'), { onChar: this.blip });
      this.fox.sprite.play('fall', {
        onEnd: () => {
          this.timers.dizzy = setTimeout(() => {
            if (this.mode !== 'dizzy') return;
            this.fox.sprite.play('fall', {
              reverse: true,
              onEnd: () => {
                if (this.mode === 'dizzy') this.rest();
              },
            });
          }, 1400);
        },
      });
    },

    // ---- hiding and leaving ---------------------------------------------

    async hide() {
      if (this.hidden) return;
      if (R.cancelPick) R.cancelPick();
      this.hidden = true;
      this.haltWander();
      this.closeBubble(false);
      clearTimeout(this.timers.look);
      clearTimeout(this.timers.sleep);
      clearTimeout(this.timers.wander);
      if (this.moving()) this.fox.cancelMotion();
      this.setMode('hidden');
      this.fox.say(this.line('hidden'), { onChar: this.blip });
      // A later animation can cancel this one's onEnd, so don't wait forever.
      await Promise.race([new Promise((resolve) => this.fox.sprite.play('sleep', { onEnd: resolve })), wait(1500)]);
      await wait(500);
      if (!this.hidden) return;
      this.fox.hush();
      await this.fox.tweenTo(this.fox.offscreenX(this.fox.edge), 230);
      if (this.hidden) this.root.dataset.hidden = 'true';
    },

    async show() {
      if (!this.hidden) return;
      this.hidden = false;
      delete this.root.dataset.hidden;
      await this.enter();
    },

    // Unspawned from the toolbar, or the site was turned off: say goodbye,
    // run off the near edge, and remove everything. A background tab can't
    // animate, and the run is capped, so this always finishes.
    async leave() {
      if (this.unmounted || this.leaving) return;
      this.leaving = true;
      const f = this.fox;
      const animate = !this.hidden && !document.hidden && !R.reducedMotion();
      this.haltWander();
      this.closeBubble(false);
      this.cancelAsk();
      for (const t of ['look', 'sleep', 'wander']) clearTimeout(this.timers[t]);
      this.setMode('leaving');
      if (animate) {
        f.say(this.line('hidden'), { onChar: this.blip });
        await wait(700);
        const run = f.followPath([{ x: f.offscreenX(f.edge), y: f.y }], RUN_SPEED * 1.4);
        await Promise.race([run, wait(2500)]);
      }
      this.unmount();
    },

    // ---- pointer ----------------------------------------------------------

    activate() {
      if (this.orphaned() || this.hidden || this.moving()) return;
      const now = performance.now();
      this.clicks = this.clicks.filter((t) => now - t < DIZZY_WINDOW_MS);
      this.clicks.push(now);
      if (this.clicks.length >= DIZZY_CLICKS && this.mode !== 'dizzy') {
        this.clicks = [];
        this.dizzy();
        return;
      }
      this.haltWander();
      if (this.mode === 'dizzy') return;
      if (this.bubble.isOpen) {
        this.closeBubble(false);
        return;
      }
      this.touch();
      if (this.mode === 'sleeping') this.wakeAndOpen();
      else this.openBubble();
    },

    wakeAndOpen() {
      this.wake().then(() => {
        if (this.mode === 'waking') this.rest();
      });
      this.openBubble(this.line('wake'));
    },

    dragStart() {
      this.closeBubble(false);
      this.setMode('dragging');
      this.fox.sprite.play('startled', { loop: true });
      this.fox.say(this.line('dragged'), { duration: 1400, onChar: this.blip });
    },

    async dragEnd() {
      const f = this.fox;
      const edge = f.nearestEdge();
      const inset = this.randomInset(edge);
      // Run back into the margin on a wobbly path, ending near the drop height.
      const target = { x: f.xFor(edge, inset), y: Math.round(f.clampY(f.y + (Math.random() * 2 - 1) * 40)) };
      f.setEdge(edge);
      this.setMode('walking');
      const path = R.meander({ x: f.x, y: f.y }, target, { wiggle: 56, bounds: this.roamBounds() });
      const arrived = await f.followPath(path, RUN_SPEED);
      if (!arrived || this.mode !== 'walking') return;
      this.inset = inset;
      this.yFrac = f.fracFromY(f.y);
      this.yHome = this.yFrac;
      f.faceIntoPage();
      R.send('renard:savePosition', { site: this.site.id, position: { edge, y: this.yHome } }).catch(() => {});
      this.rest();
    },
  };
})();
