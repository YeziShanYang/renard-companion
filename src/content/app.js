// Renard on the page: mounts the Shadow DOM UI and runs the fox's behavior
// (entrance, idling, napping, dragging, reactions) and the ask flow.
(function () {
  const R = globalThis.Renard;

  const SLEEP_AFTER_MS = 5 * 60 * 1000;
  const LOOK_MIN_MS = 20000;
  const LOOK_MAX_MS = 40000;
  const WANDER_MIN_MS = 12000;
  const WANDER_MAX_MS = 30000;
  const WANDER_SPEED = 70; // px/s: an amble, slower than running back after a drag
  const WANDER_RANGE_Y = 110; // px above or below its home height a stroll may go
  const RUN_SPEED = 170;
  const EDGE_GAP = 28; // closest the fox's body ever rests to the screen edge
  const MAX_INSET = 260; // farthest it wanders from the edge
  const LEAP = 120; // entrance: the last stretch is a pounce
  const MARGIN = 12;
  const DEFAULT_POSITION = { edge: 'right', y: 0.7 };
  const DIZZY_CLICKS = 10;
  const DIZZY_WINDOW_MS = 3000;

  // How each failure is shown: canned-line category, whether to offer the
  // settings button, and whether partial text is thrown away.
  const ERRORS = {
    keyMissing: { line: 'noKey', settings: true },
    permission: { line: 'noPermission', settings: true },
    keyInvalid: { line: 'keyInvalid', settings: true },
    modelUnavailable: { line: 'modelUnavailable', settings: true },
    rateLimited: { line: 'networkError' },
    network: { line: 'networkError' },
    refused: { line: 'refused', discard: true },
    unknown: { line: 'networkError' },
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function attempt(fn, fallback = null) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  R.App = class {
    constructor(site, state, assets) {
      this.site = site;
      this.state = state;
      this.assets = assets;
      this.adapter = R.adapters[site.id];
      this.lines = new R.LinePicker(assets.lines);
      this.blipper = new R.Blipper();
      this.blip = () => this.blipper.blip();
      this.mode = 'entering';
      this.yFrac = DEFAULT_POSITION.y; // current height (fraction of the usable range)
      this.yHome = DEFAULT_POSITION.y; // remembered height; strolls stay near it
      this.inset = EDGE_GAP;
      this.clicks = [];
      this.port = null;
      this.last = null;
      this.hidden = false;
      this.timers = {};
      this.observers = [];
      this.lastHref = location.href;
      this.bubbleSize = { ...state.bubble };
      this.shortcuts = {};
      this.lastCommand = null;
    }

    // ---- setup ------------------------------------------------------------

    async mount() {
      await this.loadFonts();
      const [sheet, fallback] = await Promise.all([this.bitmap(this.assets.sprite), this.bitmap(this.assets.icon)]);

      this.host = document.createElement('renard-companion');
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = this.assets.css;
      this.root = R.h('div', { class: 'renard-root', 'data-theme': 'light' });
      this.shadow.append(style, this.root);

      this.fox = new R.Fox({
        sheet,
        fallback,
        onActivate: () => this.activate(),
        onDragStart: () => this.dragStart(),
        onDragEnd: () => this.dragEnd(),
        onHover: () => this.touch(),
      });
      this.bubble = new R.Bubble({
        onSubmit: (q) => this.ask(q),
        onStop: () => this.stop(),
        onClose: () => this.closeBubble(true),
        onExpand: () => this.toggleExpand(),
        onResize: (size) => this.resizeBubble(size),
        onResizeEnd: () => this.saveBubble(),
        onReadChatChange: (on) => this.setReadChat(on),
        onOpenSettings: () => R.send('renard:openOptions').catch(() => {}),
      });
      this.root.append(this.bubble.el, this.fox.el);
      // Clear any fox an older copy of the extension left on the page.
      for (const stray of document.querySelectorAll('renard-companion')) stray.remove();
      document.documentElement.append(this.host);

      this.bindEvents();
      this.updateTheme();
      this.applyState(this.state);
      this.enter();
    }

    unmount() {
      if (this.unmounted) return;
      this.unmounted = true;
      this.cancelAsk();
      for (const t of Object.values(this.timers)) {
        clearTimeout(t);
        clearInterval(t);
      }
      for (const o of this.observers) o.disconnect();
      window.removeEventListener('resize', this.onResize);
      window.removeEventListener('keydown', this.onKeyDown, true);
      this.colorScheme.removeEventListener('change', this.onSchemeChange);
      this.fox.cancelMotion();
      this.fox.sprite.stop();
      this.host.remove();
    }

    async loadFonts() {
      if (R.fontsLoaded) return;
      R.fontsLoaded = true;
      // Fonts load from bytes, so the page's font-src policy is never involved.
      const faces = [
        ['400', this.assets.fontRegular],
        ['700', this.assets.fontBold],
      ];
      await Promise.all(
        faces.map(async ([weight, b64]) => {
          try {
            const face = new FontFace('Renard Pixel', R.decodeBase64(b64).buffer, { weight, style: 'normal' });
            await face.load();
            document.fonts.add(face);
          } catch {
            // The CSS falls back to a monospace stack.
          }
        }),
      );
    }

    async bitmap(b64) {
      if (!b64) return null;
      try {
        return await createImageBitmap(new Blob([R.decodeBase64(b64)], { type: 'image/png' }));
      } catch {
        return null;
      }
    }

    bindEvents() {
      // Keystrokes inside Renard stay inside, so the site's own shortcuts
      // (type-to-focus, hotkeys) don't fire while typing a question.
      for (const type of ['keydown', 'keyup', 'keypress']) {
        this.root.addEventListener(type, (e) => e.stopPropagation());
      }
      this.root.addEventListener('keydown', (e) => {
        delete this.fox.el.dataset.pointer;
        if (e.key === 'Escape' && this.bubble.isOpen) {
          e.preventDefault();
          this.closeBubble(true);
        }
      });

      // Renard's shortcuts, recognized in the page as well as by the browser
      // (see keys.js). Capture phase, so the site's own handlers and text
      // fields don't see the key first.
      this.onKeyDown = (e) => {
        if (e.repeat || e.isComposing) return;
        for (const [cmd, shortcut] of Object.entries(this.shortcuts)) {
          if (R.matchesShortcut(e, shortcut)) {
            e.preventDefault();
            e.stopPropagation();
            this.command(cmd, 'page');
            return;
          }
        }
      };
      window.addEventListener('keydown', this.onKeyDown, true);

      let resizeQueued = false;
      this.onResize = () => {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => {
          resizeQueued = false;
          const { min, max } = this.marginRange(this.fox.edge);
          this.inset = Math.min(max, Math.max(min, this.inset));
          this.fox.reflow(this.yFrac, this.inset);
          if (this.bubble.isOpen) this.placeBubble();
        });
      };
      window.addEventListener('resize', this.onResize);

      // Both sites are single-page apps that change the URL without a reload.
      this.timers.url = setInterval(() => {
        // An orphaned copy (extension reloaded under this page) removes
        // itself rather than leaving a fox that can no longer answer.
        if (!R.contextAlive()) {
          this.unmount();
          return;
        }
        if (location.href === this.lastHref) return;
        this.lastHref = location.href;
        this.updateTheme();
        if (this.bubble.isOpen) this.placeBubble();
      }, 1000);

      const themeObserver = new MutationObserver(() => {
        clearTimeout(this.timers.theme);
        this.timers.theme = setTimeout(() => this.updateTheme(), 100);
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-mode', 'data-theme', 'data-color-mode'],
      });
      if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
      this.observers.push(themeObserver);
      this.colorScheme = matchMedia('(prefers-color-scheme: dark)');
      this.onSchemeChange = () => this.updateTheme();
      this.colorScheme.addEventListener('change', this.onSchemeChange);

      // Put Renard back if the page replaces the root element's children.
      const hostObserver = new MutationObserver(() => {
        if (this.host.isConnected) return;
        if (R.contextAlive()) document.documentElement.append(this.host);
        else this.unmount();
      });
      hostObserver.observe(document.documentElement, { childList: true });
      this.observers.push(hostObserver);
    }

    updateTheme() {
      const theme = attempt(() => this.adapter.theme(), 'light');
      if (this.root.dataset.theme === theme) return;
      // Swap tokens without running every color transition at once.
      this.root.dataset.switching = 'true';
      this.root.dataset.theme = theme;
      void this.root.offsetWidth;
      requestAnimationFrame(() => delete this.root.dataset.switching);
    }

    applyState(state) {
      this.state = state;
      this.root.dataset.readable = state.prefs.readableText ? 'true' : 'false';
      this.blipper.enabled = Boolean(state.prefs.sound);
      this.bubble.setReadChat(state.prefs.readChat);
      this.bubbleSize = { ...state.bubble };
      this.shortcuts = {};
      for (const [cmd, text] of Object.entries(state.shortcuts || {})) {
        const parsed = R.parseShortcut(text);
        if (parsed) this.shortcuts[cmd] = parsed;
      }
      const blocked = this.blocker();
      if (this.bubble.isOpen) {
        this.bubble.setBlocked(blocked && blocked.detail);
        this.placeBubble();
      }
      if (!blocked && this.mode === 'blocked') {
        this.wake().then(() => {
          if (this.mode === 'waking') this.idle();
        });
      } else if (blocked && (this.mode === 'idle' || this.mode === 'wandering')) {
        this.haltWander();
        this.sleepBlocked();
      }
    }

    blocker() {
      const s = this.state;
      if (!s.hasKey) return { line: 'noKey', detail: `Add your ${s.providerName} API key in settings to get started.` };
      if (!s.apiPermission) return { line: 'noPermission', detail: `Allow Renard to reach ${s.providerName} in settings.` };
      return null;
    }

    line(category) {
      return this.lines.pick(category, { provider: this.state.providerName });
    }

    async refresh() {
      if (R.sync) await R.sync();
    }

    // ---- behavior ---------------------------------------------------------

    setMode(mode) {
      this.mode = mode;
      this.fox.el.dataset.mode = mode;
    }

    async enter() {
      const pos = this.state.position || DEFAULT_POSITION;
      const f = this.fox;
      this.yFrac = pos.y;
      this.yHome = pos.y;
      this.inset = this.randomInset(pos.edge);
      f.setEdge(pos.edge);
      f.y = f.yFromFrac(pos.y);
      f.x = f.offscreenX(pos.edge);
      f.faceIntoPage();
      f.apply();
      this.setMode('entering');
      // Trot in from off-screen, then pounce the last stretch into place.
      const target = f.xFor(pos.edge, this.inset);
      const dir = Math.sign(target - f.x);
      if (Math.abs(target - f.x) > LEAP + 24) {
        const path = R.meander({ x: f.x, y: f.y }, { x: target - dir * LEAP, y: f.y }, { wiggle: 28, stops: false, bounds: this.roamBounds() });
        if (!(await f.followPath(path, 220)) || this.mode !== 'entering') return;
      }
      f.faceIntoPage();
      f.sprite.play('pounce');
      await f.tweenTo(target, R.ANIMS.pounce.frames * R.ANIMS.pounce.ms);
      if (this.mode !== 'entering') return;
      const blocked = this.blocker();
      if (blocked) {
        this.sleepBlocked();
        f.say(this.line(blocked.line), { onChar: this.blip, duration: 5000 });
      } else {
        this.idle();
        f.say(this.line('greeting'), { onChar: this.blip });
      }
    }

    idle() {
      this.setMode('idle');
      this.fox.sprite.play('idle');
      this.scheduleLook();
      this.scheduleSleep();
      this.scheduleWander();
    }

    // ---- margins and wandering ------------------------------------------

    // Range of insets (gap from the screen edge to the fox's body) that keep
    // the fox in the margin beside the site's content column, away from both
    // the screen edge and the column. The column is measured from the site's
    // message input; without one, a fraction of the window is used.
    marginRange(edge) {
      const vw = innerWidth;
      const comp = attempt(() => this.adapter.composerRect());
      let room = Math.min(MAX_INSET + 100, vw * 0.2);
      if (comp && comp.width < vw * 0.9) room = edge === 'left' ? comp.left : vw - comp.right;
      const max = Math.min(MAX_INSET, room - R.Fox.bodyWidth - 16);
      return { min: EDGE_GAP, max: Math.max(EDGE_GAP, max) };
    }

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
    }

    // Where the fox may roam: fully on screen, anywhere vertically.
    roamBounds() {
      const f = this.fox;
      const { min, max } = f.yBounds();
      return { minX: f.xFor('left', EDGE_GAP / 2), maxX: f.xFor('right', EDGE_GAP / 2), minY: min, maxY: max };
    }

    scheduleWander() {
      clearTimeout(this.timers.wander);
      this.timers.wander = setTimeout(() => this.wander(), WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS));
    }

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
    }

    // Stops a wander in place (before opening the bubble, hiding, etc.).
    haltWander() {
      if (this.mode !== 'wandering') return;
      this.fox.cancelMotion();
      this.inset = this.fox.insetOf(this.fox.edge);
      this.yFrac = this.fox.fracFromY(this.fox.y);
      this.fox.faceIntoPage();
      this.setMode('idle');
      this.fox.sprite.play('idle');
    }

    // Back to the resting pose: idle, or asleep while setup is incomplete.
    rest() {
      if (this.hidden) return;
      if (this.blocker()) this.sleepBlocked();
      else this.idle();
    }

    scheduleLook() {
      clearTimeout(this.timers.look);
      this.timers.look = setTimeout(() => {
        if (this.mode === 'idle') {
          this.fox.sprite.play('look', {
            onEnd: () => {
              if (this.mode === 'idle') this.fox.sprite.play('idle');
            },
          });
        }
        this.scheduleLook();
      }, LOOK_MIN_MS + Math.random() * (LOOK_MAX_MS - LOOK_MIN_MS));
    }

    scheduleSleep() {
      clearTimeout(this.timers.sleep);
      this.timers.sleep = setTimeout(() => {
        if (this.mode === 'idle' && !this.bubble.isOpen) this.fallAsleep();
        else this.scheduleSleep();
      }, SLEEP_AFTER_MS);
    }

    // Any interaction postpones the nap.
    touch() {
      if (this.mode === 'idle') this.scheduleSleep();
    }

    fallAsleep() {
      this.setMode('sleeping');
      this.fox.sprite.play('sleep');
      this.fox.say(this.line('sleep'), { duration: 4000 });
    }

    sleepBlocked() {
      this.setMode('blocked');
      this.fox.sprite.play('sleep');
    }

    wake() {
      this.setMode('waking');
      return new Promise((resolve) => this.fox.sprite.play('sleep', { reverse: true, onEnd: resolve }));
    }

    think() {
      if (this.hidden) return;
      this.setMode('thinking');
      this.fox.sprite.play('look', { loop: true });
    }

    // One-shot reaction animation, then `then` (or back to rest).
    react(anim, then) {
      if (this.hidden) return;
      this.setMode('reacting');
      this.fox.sprite.play(anim, {
        onEnd: () => {
          if (this.mode !== 'reacting') return;
          if (then) then();
          else this.rest();
        },
      });
    }

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
    }

    async hide() {
      if (this.hidden) return;
      this.hidden = true;
      this.haltWander();
      this.closeBubble(false);
      clearTimeout(this.timers.look);
      clearTimeout(this.timers.sleep);
      clearTimeout(this.timers.wander);
      this.setMode('hidden');
      this.fox.say(this.line('hidden'), { onChar: this.blip });
      await new Promise((resolve) => this.fox.sprite.play('sleep', { onEnd: resolve }));
      await wait(500);
      if (!this.hidden) return;
      this.fox.hush();
      await this.fox.tweenTo(this.fox.offscreenX(this.fox.edge), 300);
      if (this.hidden) this.root.dataset.hidden = 'true';
    }

    async show() {
      if (!this.hidden) return;
      this.hidden = false;
      delete this.root.dataset.hidden;
      await this.enter();
    }

    // source: 'browser' (extension command) or 'page' (key seen in the page).
    // One key press can arrive both ways; the second within 600 ms is ignored
    // so a shortcut never toggles twice.
    command(cmd, source = 'browser') {
      const now = performance.now();
      const last = this.lastCommand;
      if (last && last.cmd === cmd && last.source !== source && now - last.at < 600) return;
      this.lastCommand = { cmd, source, at: now };
      if (cmd === 'toggle-visibility') {
        if (this.hidden) this.show();
        else this.hide();
        return;
      }
      if (cmd !== 'toggle-bubble') return;
      if (this.hidden) {
        this.show().then(() => this.openBubble());
      } else if (this.bubble.isOpen) {
        this.closeBubble(true);
      } else if (this.mode === 'sleeping') {
        this.wakeAndOpen();
      } else if (this.mode !== 'dizzy') {
        this.openBubble();
      }
    }

    // ---- pointer ----------------------------------------------------------

    activate() {
      const now = performance.now();
      this.clicks = this.clicks.filter((t) => now - t < DIZZY_WINDOW_MS);
      this.clicks.push(now);
      if (this.clicks.length >= DIZZY_CLICKS && this.mode !== 'dizzy') {
        this.clicks = [];
        this.dizzy();
        return;
      }
      this.haltWander();
      if (['entering', 'dizzy', 'hidden', 'walking', 'dragging'].includes(this.mode)) return;
      if (this.bubble.isOpen) {
        this.closeBubble(false);
        return;
      }
      this.touch();
      if (this.mode === 'sleeping') this.wakeAndOpen();
      else this.openBubble();
    }

    wakeAndOpen() {
      this.wake().then(() => {
        if (this.mode === 'waking') this.idle();
      });
      this.openBubble(this.line('wake'));
    }

    dragStart() {
      this.closeBubble(false);
      this.setMode('dragging');
      this.fox.sprite.play('startled', { loop: true });
      this.fox.say(this.line('dragged'), { duration: 1400, onChar: this.blip });
    }

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
    }

    // ---- bubble -----------------------------------------------------------

    openBubble(text) {
      this.haltWander();
      const blocked = this.blocker();
      this.fox.hush();
      this.bubble.setBlocked(blocked && blocked.detail);
      this.bubble.setLine(text || this.line(blocked ? blocked.line : 'open'), { onChar: this.blip });
      if (!this.bubble.input.value && this.last) this.bubble.setDraft(this.last.question);
      this.placeBubble();
      this.bubble.open();
      this.fox.setExpanded(true);
      requestAnimationFrame(() => {
        this.bubble.focusPrimary();
        if (this.bubble.input.value && this.shadow.activeElement === this.bubble.input) this.bubble.input.select();
      });
    }

    closeBubble(restoreFocus) {
      if (!this.bubble.isOpen) return;
      const hadFocus = this.bubble.contains(this.shadow.activeElement);
      this.bubble.close();
      this.freePlaced = false;
      this.fox.setExpanded(false);
      if (restoreFocus || hadFocus) this.fox.button.focus({ preventScroll: true });
      this.touch();
    }

    placeBubble() {
      const r = this.fox.rect();
      const vw = innerWidth;
      const vh = innerHeight;
      const side = this.fox.edge === 'right' ? 'left' : 'right';
      const overlap = 6;
      const room = side === 'left' ? r.left + overlap - MARGIN : vw - r.right + overlap - MARGIN;
      const maxW = Math.max(240, Math.min(vw * 0.9, room, vw - 2 * MARGIN));
      const expanded = Boolean(this.bubbleSize.expanded);
      const wanted = expanded ? 640 : this.bubbleSize.width || 420;
      const width = Math.min(Math.max(wanted, Math.min(320, maxW)), maxW);
      let left = side === 'left' ? r.left + overlap - width : r.right - overlap;
      left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - MARGIN - width));

      // Lowest point the bubble may reach: the viewport, or just above the
      // site's message input when the bubble would otherwise cover it.
      let floor = vh - MARGIN;
      const comp = attempt(() => this.adapter.composerRect());
      if (comp && comp.left < left + width && comp.right > left && comp.top < floor) {
        floor = Math.max(MARGIN + 220, comp.top - MARGIN);
      }
      const headY = r.top + r.height * 0.3;
      // A size the user dragged out applies once there is an answer to show;
      // before that the bubble fits its content.
      const sized = !expanded && this.bubbleSize.height && this.bubble.hasAnswer() ? this.bubbleSize.height : 0;
      const common = { side, left, width, expanded };

      if (r.top + r.height / 2 < vh * 0.45) {
        // Fox in the upper part of the screen: hang the bubble from beside it
        // and let it grow downward.
        const top = Math.max(MARGIN, r.top - 24);
        const maxHeight = Math.max(200, floor - top);
        this.bubble.place({
          ...common,
          anchor: 'top',
          offset: top,
          height: Math.min(sized, maxHeight),
          maxHeight,
          tailOffset: headY - top - 4,
          expandedHeight: Math.min(vh * 0.8, maxHeight),
        });
        return;
      }
      // Otherwise grow upward from a fixed bottom edge, so the input stays
      // put while an answer streams in.
      const bottomY = Math.min(floor, Math.max(r.bottom + 12, MARGIN + 300));
      const maxHeight = Math.max(160, bottomY - MARGIN);
      this.bubble.place({
        ...common,
        anchor: 'bottom',
        offset: vh - bottomY,
        height: Math.min(sized, maxHeight),
        maxHeight,
        tailOffset: bottomY - headY - 8,
        expandedHeight: Math.min(vh * 0.8, maxHeight),
      });
    }

    toggleExpand() {
      this.bubbleSize.expanded = !this.bubbleSize.expanded;
      this.placeBubble();
      this.saveBubble();
    }

    // Corner drag: the dragged corner follows the pointer and the opposite
    // corner stays put. The bubble keeps that spot until it next closes; the
    // size is remembered.
    resizeBubble({ corner, rect, dx, dy }) {
      const vw = innerWidth;
      const vh = innerHeight;
      const minW = Math.min(300, vw - 2 * MARGIN);
      const minH = 180;
      let { left, top, right, bottom } = rect;
      if (corner.includes('w')) left = Math.min(Math.max(rect.left + dx, MARGIN), right - minW);
      if (corner.includes('e')) right = Math.max(Math.min(rect.right + dx, vw - MARGIN), left + minW);
      if (corner.includes('n')) top = Math.min(Math.max(rect.top + dy, MARGIN), bottom - minH);
      if (corner.includes('s')) bottom = Math.max(Math.min(rect.bottom + dy, vh - MARGIN), top + minH);
      const width = right - left;
      const height = bottom - top;
      this.bubbleSize = { width: Math.round(width), height: Math.round(height), expanded: false };
      this.freePlaced = true;
      const r = this.fox.rect();
      this.bubble.place({
        side: this.fox.edge === 'right' ? 'left' : 'right',
        anchor: 'top',
        offset: top,
        left,
        width,
        height,
        maxHeight: Math.max(height, vh - MARGIN - top),
        tailOffset: r.top + r.height * 0.3 - top - 4,
        expanded: false,
        expandedHeight: 0,
      });
    }

    saveBubble() {
      R.send('renard:saveBubble', { bubble: this.bubbleSize }).catch(() => {});
    }

    setReadChat(on) {
      this.state.prefs.readChat = on;
      R.send('renard:savePrefs', { prefs: { readChat: on } }).catch(() => {});
    }

    // ---- asking -----------------------------------------------------------

    ask(raw) {
      const question = String(raw || '').trim();
      if (!question) {
        this.bubble.input.focus();
        return;
      }
      const blocked = this.blocker();
      if (blocked) {
        this.bubble.setBlocked(blocked.detail);
        this.bubble.setLine(this.line(blocked.line), { onChar: this.blip });
        return;
      }
      this.cancelAsk();
      clearTimeout(this.timers.sleep);

      let chat = null;
      let chatFailed = false;
      if (this.bubble.readChat.checked) {
        try {
          const turns = this.adapter.readChat();
          if (turns.length) chat = { siteName: this.site.name, turns };
        } catch {
          chatFailed = true;
        }
      }

      this.last = { question };
      this.bubble.startAnswer(question);
      // The answer area just appeared; apply the remembered size unless the
      // user has placed the bubble by hand.
      if (!this.freePlaced) this.placeBubble();
      if (chatFailed) {
        this.bubble.setLine(this.line('chatUnreadable'), { onChar: this.blip });
        this.bubble.setNote("Couldn't read the chat on this page, so this answer doesn't use it.");
        this.react('startled', () => this.think());
      } else {
        this.bubble.setLine(this.line('thinking'), { onChar: this.blip });
        this.think();
      }

      let port;
      try {
        port = R.ext.runtime.connect({ name: 'renard:ask' });
      } catch {
        // The extension was reloaded or updated since this page loaded.
        this.failed({ kind: 'network', message: 'Renard was updated. Reload the page to keep going.' }, '');
        return;
      }
      this.port = port;
      let text = '';
      const release = () => {
        if (this.port === port) this.port = null;
        port.disconnect();
      };
      port.onMessage.addListener((m) => {
        if (this.port !== port || !m) return;
        if (m.type === 'context') {
          if (m.partial) this.bubble.setNote(`Read the latest part of this chat (${m.included} of ${m.total} messages).`);
        } else if (m.type === 'delta') {
          text += m.text;
          this.bubble.setAnswer(text, { streaming: true });
        } else if (m.type === 'done') {
          release();
          this.answered(text);
        } else if (m.type === 'error') {
          release();
          this.failed(m, text);
        }
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.port = null;
        this.failed({ kind: 'network', message: 'Lost the connection to the extension. Try again.' }, text);
      });
      port.postMessage({ type: 'ask', question, chat });
    }

    answered(text) {
      this.bubble.setAnswer(text, { streaming: false });
      if (!text) this.bubble.setNote('The answer came back empty.');
      const line = this.line('answered');
      this.bubble.setLine(line, { onChar: this.blip });
      this.bubble.announce('Answer ready');
      this.last.answer = text;
      this.react('pounce');
      if (!this.bubble.isOpen && !this.hidden) this.fox.say(line);
    }

    failed(m, text) {
      const e = ERRORS[m.kind] || ERRORS.unknown;
      this.bubble.setAnswer(e.discard ? '' : text, { streaming: false });
      this.bubble.setNotice({ text: this.errorDetail(m), settings: e.settings });
      const line = this.line(e.line);
      this.bubble.setLine(line, { onChar: this.blip });
      this.bubble.announce(line);
      if (m.kind === 'keyMissing' || m.kind === 'permission') this.refresh().catch(() => {});
      this.react('startled');
      if (!this.bubble.isOpen && !this.hidden) this.fox.say(line);
    }

    errorDetail(m) {
      const p = this.state.providerName;
      switch (m.kind) {
        case 'keyMissing':
          return `Add your ${p} API key in settings.`;
        case 'permission':
          return `Allow Renard to reach ${p} in settings.`;
        case 'refused':
          return '';
        case 'rateLimited':
          return `${p} is rate limiting requests right now.`;
        default:
          return m.message ? `${p}: ${m.message}` : '';
      }
    }

    stop() {
      if (!this.port) return;
      this.cancelAsk();
      this.bubble.setAnswer(this.bubble.markdown, { streaming: false });
      this.bubble.setLine(this.line('stopped'), { onChar: this.blip });
      this.rest();
    }

    cancelAsk() {
      if (!this.port) return;
      const port = this.port;
      this.port = null;
      port.disconnect();
    }
  };
})();
