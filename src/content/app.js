// Renard on the page: mounts the Shadow DOM UI and runs the fox's behavior
// (entrance, idling, napping, dragging, reactions) and the ask flow.
(function () {
  const R = globalThis.Renard;

  const SLEEP_AFTER_MS = 5 * 60 * 1000;
  const LOOK_MIN_MS = 20000;
  const LOOK_MAX_MS = 40000;
  const WANDER_MIN_MS = 12000;
  const WANDER_MAX_MS = 30000;
  const WANDER_SPEED = 91; // px/s: an amble, slower than running back after a drag
  const WANDER_RANGE_Y = 110; // px above or below its home height a stroll may go
  const RUN_SPEED = 221;
  const ENTER_SPEED = 286; // the trot in from off-screen
  const EDGE_GAP = 28; // closest the fox's body ever rests to the screen edge
  const MAX_INSET = 260; // farthest it wanders from the edge
  const LEAP = 120; // entrance: the last stretch is a pounce
  const MARGIN = 12;
  const BUBBLE_WIDTH = 520; // default width; corners resize it
  const EXPANDED_WIDTH = 720;
  const LEGACY_WIDTH = 420; // the earlier default, saved alongside the expand toggle
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
    imageUnsupported: { line: 'imageUnsupported', settings: true },
    rateLimited: { line: 'networkError' },
    network: { line: 'networkError' },
    refused: { line: 'refused', discard: true },
    localMissing: { line: 'localMissing', settings: true },
    noGpu: { line: 'noGpu', settings: true },
    unknown: { line: 'networkError' },
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const IMAGES_OFF = "The built-in model can't read images. Pick an API-key provider in settings to attach screenshots.";
  const NO_CAPTURE_ACCESS =
    'Screenshots need Renard to have access to all websites. Allow it under Screenshots in settings, then click the camera again. Pasting or dropping an image works without it.';

  // The fox is mid-move: reactions, clicks and the bubble wait until it lands,
  // so nothing can strand it walking in place.
  const MOVING = ['entering', 'walking', 'dragging', 'leaving'];

  // Provider error text shown on the page, minus anything shaped like a key.
  function scrubError(text) {
    return String(text)
      .replace(/\b(sk-[\w*.-]{4,}|AIza[\w-]{8,}|[A-Za-z0-9_-]{32,})/g, '[hidden]')
      .slice(0, 300);
  }

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
      // The image waiting to go with the next question.
      this.attachment = null;
      this.capturing = false;
      this.hidden = false;
      this.timers = {};
      this.observers = [];
      this.lastHref = location.href;
      // The reading view is for the page it was opened on; a new page starts
      // with the compact bubble.
      this.bubbleSize = { ...state.bubble, expanded: false };
      this.shortcuts = {};
      this.lastCommand = null;
    }

    // ---- setup ------------------------------------------------------------

    async mount() {
      await this.loadFonts();
      const [sheet, fallback] = await Promise.all([this.bitmap(this.assets.sprite), this.bitmap(this.assets.icon)]);

      // A plain div, not a custom element: a page that defined
      // <renard-companion> first could reach the closed shadow root through
      // attachInternals().
      this.host = document.createElement('div');
      this.host.setAttribute(R.HOST_ATTR, '');
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      this.root = R.h('div', { class: 'renard-root', 'data-theme': 'light' });
      this.shadow.append(this.root);
      this.applyStyles();

      this.fox = new R.Fox({
        sheet,
        fallback,
        onActivate: () => this.activate(),
        onDragStart: () => this.dragStart(),
        onDragEnd: () => this.dragEnd(),
        onHover: () => this.touch(),
      });
      this.bubble = new R.Bubble({
        // Enter or the Ask/Stop button: stop an answer that is still coming,
        // otherwise ask.
        onSubmit: (q) => {
          if (!this.port) this.ask(q);
          else if (performance.now() - this.askedAt > 400) this.stop();
        },
        onStop: () => this.stop(),
        onClose: (via) => {
          // Closed from the keyboard: show the focus ring on the fox again.
          if (via === 'key') delete this.fox.el.dataset.pointer;
          this.closeBubble(true);
        },
        onExpand: () => this.toggleExpand(),
        onResize: (size) => this.resizeBubble(size),
        onResizeEnd: () => this.saveBubble(),
        onReadChatChange: (on) => this.setReadChat(on),
        onOpenSettings: () => R.send('renard:openOptions').catch(() => {}),
        onClear: () => this.clearAnswer(),
        onCapture: () => this.capture(),
        onAttach: (image) => {
          if (image && !this.imagesEnabled()) return;
          this.setAttachment(image);
          if (image) this.bubble.setNotice(null);
        },
        // Keys typed in the bubble stay in its frame, which reports shortcuts.
        onCommand: (cmd) => {
          delete this.fox.el.dataset.pointer;
          this.command(cmd, 'page');
        },
        onBlip: () => this.blip(),
        // The content now needs a different height (an answer arrived, or was
        // cleared): the room the bubble is given may change.
        onMinHeight: () => {
          if (this.bubble.isOpen && !this.freePlaced && !this.bubble.el.dataset.resizing) this.placeBubble();
        },
      });
      this.root.append(this.bubble.el, this.fox.el);
      // Clear any fox an older copy of the extension left on the page.
      for (const stray of document.querySelectorAll(R.HOST_SELECTOR)) if (stray !== this.host) stray.remove();
      document.documentElement.append(this.host);
      // The element shows only while content/host.css is on the page. If a
      // page got the script without the sheet, Renard shows anyway, but
      // there it won't disappear when the extension is removed.
      if (getComputedStyle(this.host).display === 'none') this.host.style.setProperty('--renard-companion-display', 'block');

      if (this.adapter.kind === 'page') this.bubble.setReadLabel('Read page', "Include this page's text with your question");
      this.bindEvents();
      this.updateTheme();
      this.applyState(this.state);
      this.enter({ returning: Boolean(this.state.returning) });
    }

    // Also runs in an orphaned copy (extension reloaded), whose extension
    // APIs throw, so the fox is removed whatever else fails.
    unmount() {
      if (this.unmounted) return;
      this.unmounted = true;
      try {
        for (const t of Object.values(this.timers)) {
          clearTimeout(t);
          clearInterval(t);
        }
        for (const o of this.observers) o.disconnect();
        window.removeEventListener('resize', this.onResize);
        window.removeEventListener('scroll', this.onScroll, { capture: true });
        window.removeEventListener('keydown', this.onKeyDown, true);
        this.colorScheme.removeEventListener('change', this.onSchemeChange);
        this.fox.cancelMotion();
        this.fox.sprite.stop();
        this.blipper.close();
        if (R.cancelPick) R.cancelPick();
        try {
          this.cancelAsk();
        } catch {
          this.port = null;
        }
        this.bubble.destroy();
      } finally {
        this.host.remove();
      }
    }

    // A constructed stylesheet is immune to the page's Content Security
    // Policy (some sites forbid inline styles). Where adopting one fails, a
    // <style> element is the fallback.
    applyStyles() {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(this.assets.css);
        this.shadow.adoptedStyleSheets = [sheet];
        if (this.shadow.adoptedStyleSheets.length === 1) return;
      } catch {
        // fall through
      }
      const style = document.createElement('style');
      style.textContent = this.assets.css;
      this.shadow.prepend(style);
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
        // Only real key presses: a page can dispatch synthetic ones.
        if (!e.isTrusted || e.repeat || e.isComposing) return;
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
          // The fox can't be moved mid-walk or mid-drag, so it waits for the
          // move to end; otherwise it would finish outside a smaller window.
          if (this.fox.motion || this.fox.press) {
            clearTimeout(this.timers.reflow);
            this.timers.reflow = setTimeout(this.onResize, 250);
            return;
          }
          const { min, max } = this.marginRange(this.fox.edge);
          this.inset = Math.min(max, Math.max(min, this.inset));
          this.fox.reflow(this.yFrac, this.inset);
          if (this.bubble.isOpen) this.placeBubble();
        });
      };
      window.addEventListener('resize', this.onResize);

      // The site's message box can move as the page scrolls.
      let scrollQueued = false;
      this.onScroll = () => {
        if (scrollQueued || !this.bubble.isOpen || this.freePlaced) return;
        scrollQueued = true;
        requestAnimationFrame(() => {
          scrollQueued = false;
          if (this.bubble.isOpen && !this.freePlaced && !this.bubble.el.dataset.resizing) this.placeBubble();
        });
      };
      window.addEventListener('scroll', this.onScroll, { passive: true, capture: true });

      // Both sites are single-page apps that change the URL without a reload.
      this.timers.url = setInterval(() => {
        if (this.orphaned()) return;
        // A page that replaced <html> itself took Renard with it.
        if (!this.host.isConnected) this.restoreHost();
        if (location.href === this.lastHref) return;
        this.lastHref = location.href;
        this.updateTheme();
        if (this.bubble.isOpen) this.placeBubble();
      }, 1000);

      // Waits for the page's changes to settle, but no longer than 500 ms, so
      // a page that restyles <html> every frame still gets its theme.
      let themeWaitStart = 0;
      const themeObserver = new MutationObserver(() => {
        clearTimeout(this.timers.theme);
        const now = performance.now();
        if (!themeWaitStart) themeWaitStart = now;
        const delay = Math.max(0, Math.min(100, themeWaitStart + 500 - now));
        this.timers.theme = setTimeout(() => {
          themeWaitStart = 0;
          this.updateTheme();
        }, delay);
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
        if (!this.host.isConnected) this.restoreHost();
      });
      hostObserver.observe(document.documentElement, { childList: true });
      this.observers.push(hostObserver);
    }

    // Puts Renard back on the page after the page removed it, at most five
    // times in ten seconds and never in the same task: a page that strips
    // every unknown element from <html> would otherwise remove and re-add it
    // forever and freeze the tab.
    restoreHost() {
      if (!R.contextAlive()) {
        this.unmount();
        return;
      }
      if (this.timers.restore) return;
      const now = performance.now();
      this.restores = (this.restores || []).filter((t) => now - t < 10000);
      if (this.restores.length >= 5) return;
      this.restores.push(now);
      this.timers.restore = setTimeout(() => {
        this.timers.restore = 0;
        if (!this.unmounted && !this.host.isConnected) document.documentElement.append(this.host);
      }, 50);
    }

    updateTheme() {
      const theme = attempt(() => this.adapter.theme(), 'light');
      if (this.root.dataset.theme === theme) return;
      // Swap tokens without running every color transition at once.
      this.root.dataset.switching = 'true';
      this.root.dataset.theme = theme;
      void this.root.offsetWidth;
      requestAnimationFrame(() => delete this.root.dataset.switching);
      this.bubble.setTheme(theme, this.state.prefs.readableText);
    }

    applyState(state) {
      this.state = state;
      this.root.dataset.readable = state.prefs.readableText ? 'true' : 'false';
      this.blipper.enabled = Boolean(state.prefs.sound);
      this.bubble.setTheme(this.root.dataset.theme, state.prefs.readableText);
      this.bubble.setPrefs({ sound: state.prefs.sound, shortcuts: state.shortcuts });
      // A Read chat change from this page wins over a refresh that was
      // already on its way, until storage catches up with it.
      if (this.pendingReadChat !== undefined) {
        if (state.prefs.readChat === this.pendingReadChat) this.pendingReadChat = undefined;
        else state.prefs.readChat = this.pendingReadChat;
      }
      this.bubble.setReadChat(state.prefs.readChat);
      this.bubble.setImages(this.imagesEnabled(), IMAGES_OFF);
      if (this.attachment && !this.imagesEnabled()) this.setAttachment(null);
      // A bubble placed or being resized by hand keeps its size.
      if (!this.freePlaced && !this.bubble.el.dataset.resizing) this.bubbleSize = { ...state.bubble, expanded: this.bubbleSize.expanded };
      this.shortcuts = {};
      for (const [cmd, text] of Object.entries(state.shortcuts || {})) {
        const parsed = R.parseShortcut(text);
        if (parsed) this.shortcuts[cmd] = parsed;
      }
      const blocked = this.blocker();
      // Renard can't answer (no key, no download, no access to the API): the
      // bubble shows only what to set up, with no input. The conversation so
      // far is dropped rather than left under a sleeping fox, and a usable
      // model later starts from an empty bubble.
      if (blocked && (this.last || this.port || this.bubble.hasAnswer())) this.dropConversation();
      if (this.bubble.isOpen) {
        this.bubble.setBlocked(blocked && blocked.detail);
        // Said when the bubble is open as what's needed changes.
        const reason = blocked ? blocked.line : null;
        if (reason !== this.blockedReason) this.bubble.setLine(this.line(reason || 'open'), { onChar: this.blip });
        if (!this.freePlaced) this.placeBubble();
      }
      this.blockedReason = blocked ? blocked.line : null;
      if (!blocked && this.mode === 'blocked') {
        this.wake().then(() => {
          if (this.mode === 'waking') this.rest();
        });
      } else if (blocked && (this.mode === 'idle' || this.mode === 'wandering')) {
        this.haltWander();
        this.sleepBlocked();
      }
    }

    // Back to an empty, compact bubble: no question, answer or draft.
    dropConversation() {
      this.cancelAsk();
      this.last = null;
      this.bubble.reset();
      this.bubbleSize.expanded = false;
      this.freePlaced = false;
      if (['thinking', 'reacting'].includes(this.mode)) this.rest();
    }

    blocker() {
      const s = this.state;
      if (!s.hasKey && s.provider === 'local') {
        return { line: 'localMissing', detail: `Download ${s.modelName || 'the built-in model'} in settings to get started.` };
      }
      if (!s.hasKey) return { line: 'noKey', detail: 'To get started, open settings: add an API key, or pick Built-in and skip the key.' };
      if (!s.apiPermission) return { line: 'noPermission', detail: `Allow Renard to reach ${s.providerName} in settings.` };
      return null;
    }

    line(category) {
      return this.lines.pick(category, { provider: this.state.providerName });
    }

    async refresh() {
      if (R.sync) await R.sync();
    }

    // An orphaned copy (the extension was reloaded or updated under this
    // page) can no longer answer, so it removes its fox. Checked every
    // second, which a background tab may slow to once a minute, and on every
    // click or shortcut, so a stale fox never opens a bubble that can't work.
    orphaned() {
      if (R.contextAlive()) return false;
      this.unmount();
      return true;
    }

    // ---- behavior ---------------------------------------------------------

    setMode(mode) {
      this.mode = mode;
      this.fox.el.dataset.mode = mode;
    }

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
        if (this.mode === 'idle' && !R.reducedMotion()) {
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
      if (this.hidden || MOVING.includes(this.mode)) return;
      this.setMode('thinking');
      this.fox.sprite.play('look', { loop: true });
    }

    // One-shot reaction animation, then `then` (or back to rest).
    react(anim, then) {
      if (this.hidden || MOVING.includes(this.mode)) return;
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
      if (R.cancelPick) R.cancelPick();
      this.hidden = true;
      this.haltWander();
      this.closeBubble(false);
      clearTimeout(this.timers.look);
      clearTimeout(this.timers.sleep);
      clearTimeout(this.timers.wander);
      if (MOVING.includes(this.mode)) this.fox.cancelMotion();
      this.setMode('hidden');
      this.fox.say(this.line('hidden'), { onChar: this.blip });
      // A later animation can cancel this one's onEnd, so don't wait forever.
      await Promise.race([new Promise((resolve) => this.fox.sprite.play('sleep', { onEnd: resolve })), wait(1500)]);
      await wait(500);
      if (!this.hidden) return;
      this.fox.hush();
      await this.fox.tweenTo(this.fox.offscreenX(this.fox.edge), 230);
      if (this.hidden) this.root.dataset.hidden = 'true';
    }

    async show() {
      if (!this.hidden) return;
      this.hidden = false;
      delete this.root.dataset.hidden;
      await this.enter();
    }

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
    }

    // source: 'browser' (extension command) or 'page' (key seen in the page).
    // One key press can arrive both ways; the second within 600 ms is ignored
    // so a shortcut never toggles twice.
    command(cmd, source = 'browser') {
      if (this.leaving || this.orphaned()) return;
      // Renard's shortcuts cancel a screenshot being chosen; the page can
      // block the picker's own keys, but not these.
      if (R.cancelPick) {
        R.cancelPick();
        if (cmd === 'toggle-bubble') return;
      }
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
        this.show().then(() => {
          if (!this.hidden && !this.bubble.isOpen) this.openBubble();
        });
      } else if (this.bubble.isOpen) {
        this.closeBubble(true);
      } else if (MOVING.includes(this.mode)) {
        return;
      } else if (this.mode === 'sleeping') {
        this.wakeAndOpen();
      } else if (this.mode !== 'dizzy') {
        this.openBubble();
      }
    }

    // ---- pointer ----------------------------------------------------------

    activate() {
      if (this.orphaned() || this.hidden || MOVING.includes(this.mode)) return;
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
    }

    wakeAndOpen() {
      this.wake().then(() => {
        if (this.mode === 'waking') this.rest();
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
      if (this.last) this.bubble.prefillDraft(this.last.question);
      this.placeBubble();
      this.bubble.open();
      this.fox.setExpanded(true);
      requestAnimationFrame(() => {
        this.bubble.focusPrimary({ select: true });
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
      const saved = this.bubbleSize.width && this.bubbleSize.width !== LEGACY_WIDTH ? this.bubbleSize.width : BUBBLE_WIDTH;
      const wanted = expanded ? EXPANDED_WIDTH : saved;
      const width = Math.min(Math.max(wanted, Math.min(360, maxW)), maxW);
      let left = side === 'left' ? r.left + overlap - width : r.right - overlap;
      left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - MARGIN - width));

      // Before a question the bubble fits its content (the line and the
      // input): the reading view's height and a dragged-out height wait for
      // an answer.
      const answering = this.bubble.hasAnswer();
      const fill = expanded && answering;
      // The height the bubble needs to show everything without clipping.
      const need = Math.min(Math.max(this.bubble.minHeight, 200), vh - 2 * MARGIN);
      // The bubble keeps clear of the site's message box when there is room
      // for it on the fox's side of the box, ending at most a little above
      // the fox. A box farther up, level with the fox, is covered instead:
      // moving away from the fox to avoid it would leave the tail pointing
      // at nothing.
      let floor = vh - MARGIN;
      let ceiling = MARGIN;
      const comp = attempt(() => this.adapter.composerRect());
      if (comp && comp.left < left + width && comp.right > left) {
        if (comp.top - MARGIN >= r.top - 48) floor = comp.top - MARGIN;
        else if (comp.bottom + MARGIN <= r.bottom) ceiling = comp.bottom + MARGIN;
      }
      const headY = r.top + r.height * 0.3;
      const common = { side, left, width, expanded: fill, pressed: expanded };

      if (r.top + r.height / 2 < vh * 0.45) {
        // Fox in the upper part of the screen: hang the bubble from beside it
        // and let it grow downward.
        const top = Math.max(MARGIN, r.top - 24);
        const bottom = floor - top >= need ? floor : vh - MARGIN;
        const maxHeight = Math.max(bottom - top, Math.min(need, vh - MARGIN - top));
        this.bubble.place({
          ...common,
          anchor: 'top',
          offset: top,
          height: this.sizedHeight(answering && !fill, maxHeight),
          maxHeight,
          tailOffset: headY - top - 4,
          expandedHeight: Math.min(vh * 0.8, maxHeight),
        });
        return;
      }
      // Otherwise grow upward from a fixed bottom edge beside the fox, so the
      // input stays put while an answer streams in.
      let bottomY = Math.min(floor, Math.max(r.bottom + 12, MARGIN + 300));
      if (bottomY - MARGIN < need) bottomY = Math.min(vh - MARGIN, Math.max(r.bottom + 12, MARGIN + 300));
      const top = bottomY - ceiling >= need ? ceiling : MARGIN;
      const maxHeight = Math.max(160, bottomY - top);
      this.bubble.place({
        ...common,
        anchor: 'bottom',
        offset: vh - bottomY,
        height: this.sizedHeight(answering && !fill, maxHeight),
        maxHeight,
        tailOffset: bottomY - headY - 8,
        expandedHeight: Math.min(vh * 0.8, maxHeight),
      });
    }

    // A height the user dragged out, while there is an answer to show: never
    // less than the content needs, never more than the room there is.
    sizedHeight(applies, maxHeight) {
      if (!applies || !this.bubbleSize.height) return 0;
      return Math.min(Math.max(this.bubbleSize.height, this.bubble.minHeight), maxHeight);
    }

    // The larger reading view. Leaving it goes back to the size the bubble
    // opened at, fitted to its content.
    toggleExpand() {
      const expanded = !this.bubbleSize.expanded;
      this.bubbleSize = expanded ? { ...this.bubbleSize, expanded } : { ...this.bubbleSize, height: 0, expanded };
      this.freePlaced = false;
      this.placeBubble();
      this.saveBubble();
    }

    // Corner drag: the dragged corner follows the pointer and the opposite
    // corner stays put. The bubble keeps that spot until it next closes; the
    // size is remembered. It never gets shorter than its content needs, and
    // before a question it fits its content, so dragging sets the width only.
    resizeBubble({ corner, rect, dx, dy }) {
      const vw = innerWidth;
      const vh = innerHeight;
      const minW = Math.min(300, vw - 2 * MARGIN);
      const minH = Math.min(Math.max(120, this.bubble.minHeight), vh - 2 * MARGIN);
      let { left, top, right, bottom } = rect;
      if (corner.includes('w')) left = Math.min(Math.max(rect.left + dx, MARGIN), right - minW);
      if (corner.includes('e')) right = Math.max(Math.min(rect.right + dx, vw - MARGIN), left + minW);
      if (corner.includes('n')) top = Math.min(Math.max(rect.top + dy, MARGIN), bottom - minH);
      if (corner.includes('s')) bottom = Math.max(Math.min(rect.bottom + dy, vh - MARGIN), top + minH);
      const width = right - left;
      const height = bottom - top;
      if (!this.bubble.hasAnswer()) {
        this.bubbleSize = { ...this.bubbleSize, width: Math.round(width), expanded: false };
        this.placeBubble();
        return;
      }
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
      R.send('renard:saveBubble', { bubble: { ...this.bubbleSize, expanded: false } }).catch(() => {});
    }

    setReadChat(on) {
      this.state.prefs.readChat = on;
      this.pendingReadChat = on;
      R.send('renard:savePrefs', { prefs: { readChat: on } }).catch(() => {});
    }

    // ---- screenshots ------------------------------------------------------

    imagesEnabled() {
      return this.state.provider !== 'local';
    }

    setAttachment(image) {
      this.attachment = image || null;
      this.bubble.setAttachment(this.attachment);
    }

    // Hides Renard, lets the user pick a region, and attaches a screenshot
    // of it. The bubble stays open underneath and comes back with the
    // image, or with a notice saying what went wrong.
    async capture() {
      if (this.capturing || !this.imagesEnabled()) return;
      this.capturing = true;
      let allowed = true;
      try {
        allowed = (await R.send('renard:captureAccess')).granted;
      } catch {
        // The capture itself reports what is wrong.
      }
      if (!allowed) {
        this.capturing = false;
        this.bubble.setNotice({ text: NO_CAPTURE_ACCESS, settings: true });
        return;
      }
      this.root.dataset.capturing = 'true';
      try {
        const rect = await R.pickRegion(this.root);
        if (!rect) return;
        // Two frames, so the page is drawn again without the picker.
        await nextFrame();
        await nextFrame();
        const image = await R.send('renard:capture', { site: this.site.id, rect, viewport: { w: innerWidth, h: innerHeight } });
        if (!R.isAttachedImage(image)) throw new Error('The screenshot came back empty.');
        this.setAttachment(image);
        this.bubble.setNotice(null);
      } catch (err) {
        this.bubble.setNotice({ text: `Couldn't take the screenshot. ${scrubError((err && err.message) || err)}` });
      } finally {
        delete this.root.dataset.capturing;
        this.capturing = false;
        if (this.bubble.isOpen) this.bubble.focusInput();
      }
    }

    // ---- asking -----------------------------------------------------------

    ask(raw) {
      const question = String(raw || '').trim();
      if (!question) {
        this.bubble.focusInput();
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
      this.askedAt = performance.now();

      let chat = null;
      let page = null;
      let chatFailed = false;
      if (this.bubble.readChat.checked) {
        try {
          if (this.adapter.kind === 'page') {
            page = this.adapter.readPage();
            if (!page.text) throw new Error('No text on this page');
          } else {
            const turns = R.adapterUtils.capTurns(this.adapter.readChat());
            if (turns.length) chat = { siteName: this.site.name, turns };
          }
        } catch {
          chatFailed = true;
          page = null;
        }
      }
      const reading = this.adapter.kind === 'page' ? 'page' : 'chat';

      // The image goes with this question only. failed() puts it back if no
      // answer arrives, so asking again sends it again.
      const image = this.attachment;
      if (image) this.setAttachment(null);
      this.last = { question, image };
      this.bubble.startAnswer(question, { screenshot: Boolean(image) });
      // The answer area just appeared; apply the remembered size unless the
      // user has placed the bubble by hand.
      if (!this.freePlaced) this.placeBubble();
      if (chatFailed) {
        this.bubble.setLine(this.line(reading === 'page' ? 'pageUnreadable' : 'chatUnreadable'), { onChar: this.blip });
        this.bubble.setNote(
          reading === 'page'
            ? "Couldn't find any text on this page, so this answer doesn't use it."
            : "Couldn't read the chat on this page, so this answer doesn't use it.",
        );
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
      // Pings keep the background awake through a long answer (Firefox
      // otherwise suspends an idle background page after about 30 s).
      const keepAlive = setInterval(() => {
        try {
          port.postMessage({ type: 'ping' });
        } catch {
          clearInterval(keepAlive);
        }
      }, 10000);
      const release = () => {
        clearInterval(keepAlive);
        if (this.port === port) this.port = null;
        port.disconnect();
      };
      port.onMessage.addListener((m) => {
        if (this.port !== port || !m) return;
        if (m.type === 'loading') {
          // The built-in model is loading; say so unless text already came.
          if (!text) this.bubble.setLine(this.line('localLoading'), { onChar: this.blip });
        } else if (m.type === 'context') {
          if (m.page && m.partial) this.bubble.setNote(`Read the first part of this page (${m.included} of ${m.total} characters).`);
          else if (m.partial) this.bubble.setNote(`Read the latest part of this chat (${m.included} of ${m.total} messages).`);
        } else if (m.type === 'delta') {
          text += m.text;
          this.bubble.setAnswer(text, { streaming: true });
        } else if (m.type === 'done') {
          release();
          this.answered(text, { limited: m.limited === true });
        } else if (m.type === 'error') {
          release();
          this.failed(m, text);
        }
      });
      port.onDisconnect.addListener(() => {
        clearInterval(keepAlive);
        if (this.port !== port) return;
        this.port = null;
        this.failed({ kind: 'network', message: 'Lost the connection to the extension. Try again.' }, text);
      });
      try {
        port.postMessage({ type: 'ask', question, chat, page, image });
      } catch {
        release();
        this.failed({ kind: 'network', message: 'Renard was updated. Reload the page to keep going.' }, '');
      }
    }

    // limited: the answer stopped at the model's output limit.
    answered(text, { limited = false } = {}) {
      this.bubble.setAnswer(text, { streaming: false });
      if (!text) this.bubble.setNote('Hmm, the answer came back empty. Try asking again?');
      else if (limited) this.bubble.setNote("This answer reached the model's length limit, so it ends early.");
      const line = this.line('answered');
      this.bubble.setLine(line, { onChar: this.blip });
      this.bubble.announce('Answer ready');
      this.last.answer = text;
      this.react('pounce');
      if (!this.bubble.isOpen && !this.hidden) this.fox.say(line);
    }

    failed(m, text) {
      const e = ERRORS[m.kind] || ERRORS.unknown;
      if ((!text || e.discard) && this.last && this.last.image && !this.attachment) this.setAttachment(this.last.image);
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
          return 'Connect a model in settings to keep going.';
        case 'permission':
          return `Allow Renard to reach ${p} in settings.`;
        case 'refused':
          return '';
        case 'rateLimited':
          return `${p} is rate limiting requests right now.`;
        case 'keyInvalid':
          // Fixed text: some providers echo part of the key in their message.
          return `${p} didn't accept the API key. Check it in settings.`;
        case 'modelUnavailable':
          return `That model isn't available for this ${p} key. Pick another in settings.`;
        case 'imageUnsupported':
          return `That ${p} model can't read images. Pick another in settings, or ask without the screenshot.`;
        case 'localMissing':
        case 'noGpu':
          return m.message;
        default:
          return m.message ? `${p}: ${scrubError(m.message)}` : '';
      }
    }

    // Clears the question and answer (stopping one still streaming) so the
    // next question starts from an empty bubble.
    clearAnswer() {
      this.cancelAsk();
      this.last = null;
      this.setAttachment(null);
      this.bubble.reset();
      this.bubble.setLine(this.line('cleared'), { onChar: this.blip });
      if (['thinking', 'reacting'].includes(this.mode)) this.rest();
      // Back to the compact bubble it opened as.
      this.bubbleSize.expanded = false;
      this.freePlaced = false;
      this.placeBubble();
      this.bubble.focusInput();
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
