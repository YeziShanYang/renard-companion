// Renard on the page: puts the fox and its bubble on the page, keeps them
// in step with settings and the page, and runs the ask flow. The parts:
//   stage.js     Renard's element on the page (shadow root, top layer)
//   fox.js       the fox's sprite, movement and pointer handling
//   bubble.js    the bubble's outline, and the channel to its frame
//   behavior.js  what the fox does (methods of this class)
//   layout.js    where the bubble goes beside the fox
//   ask.js       sending a question and wording what comes back
(function () {
  const R = globalThis.Renard;

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const IMAGES_OFF = "The built-in model can't read images. Pick an API-key provider in settings to attach screenshots.";
  const NO_CAPTURE_ACCESS =
    'Screenshots need Renard to have access to all websites. Allow it under Screenshots in settings, then click the camera again. Pasting or dropping an image works without it.';

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
      this.initFox();
      // The question being answered, if any (see R.sendQuestion).
      this.request = null;
      // The last question asked: { question, image, answer }.
      this.last = null;
      // The image waiting to go with the next question.
      this.attachment = null;
      this.capturing = false;
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
      await R.loadFonts(this.assets);
      const [sheet, fallback] = await Promise.all([R.decodeImage(this.assets.sprite), R.decodeImage(this.assets.icon)]);

      this.stage = new R.Stage({
        css: this.assets.css,
        onReplaced: () => {
          if (R.remount) R.remount();
          else this.unmount();
        },
        onOrphaned: () => this.unmount(),
      });
      this.shadow = this.stage.shadow;
      this.root = this.stage.root;

      this.fox = new R.Fox({
        sheet,
        fallback,
        onActivate: () => this.activate(),
        onDragStart: () => this.dragStart(),
        onDragEnd: () => this.dragEnd(),
        // Pointing at the fox loads the bubble's frame, so it's ready to open.
        onHover: () => {
          this.touch();
          this.bubble.prepare();
        },
      });
      this.bubble = new R.Bubble({
        // Enter or the Ask/Stop button: stop an answer that is still coming,
        // otherwise ask.
        onSubmit: (q) => {
          if (!this.request) this.ask(q);
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
      this.fox.button.addEventListener('focus', () => this.bubble.prepare());
      this.stage.show([this.bubble.el, this.fox.el]);

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
          this.request = null;
        }
        this.bubble.destroy();
      } finally {
        this.stage.destroy();
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
      R.watchKeyboardLayout();

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
          // A media query can change the page's zoom.
          this.stage.fitZoom();
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
        if (!this.stage.keep()) return;
        // A stylesheet the page adds later can zoom <html> without any
        // change the observers see.
        this.stage.fitZoom();
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
          this.stage.fitZoom();
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
    }

    // ---- settings and page state ----------------------------------------------

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
      this.shortcuts = R.parseShortcuts(state.shortcuts);
      const blocked = this.blocker();
      // Renard can't answer (no key, no download, no access to the API): the
      // bubble shows only what to set up, with no input. The conversation so
      // far is dropped rather than left under a sleeping fox, and a usable
      // model later starts from an empty bubble.
      if (blocked && (this.last || this.request || this.bubble.hasAnswer())) this.dropConversation();
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

    // What keeps Renard from answering, if anything: the line to say and
    // the setup notice to show.
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
      } else if (this.moving()) {
        return;
      } else if (this.mode === 'sleeping') {
        this.wakeAndOpen();
      } else if (this.mode !== 'dizzy') {
        this.openBubble();
      }
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

    // The bubble beside the fox, sized for what it shows (see layout.js).
    placeBubble() {
      const { crowded, place } = R.layout.placement({
        fox: this.fox.rect(),
        edge: this.fox.edge,
        viewport: { width: innerWidth, height: innerHeight },
        size: this.bubbleSize,
        answering: this.bubble.hasAnswer(),
        minHeight: this.bubble.minHeight,
        composer: attempt(() => this.adapter.composerRect()),
      });
      this.bubble.el.dataset.crowded = crowded ? 'true' : 'false';
      this.bubble.place(place);
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

    // Corner drag. The bubble keeps the spot it's dragged to until it next
    // closes; the size is remembered. Before a question it fits its content,
    // so dragging sets the width only and it stays beside the fox.
    resizeBubble({ corner, rect, dx, dy }) {
      const viewport = { width: innerWidth, height: innerHeight };
      const box = R.layout.resized({ corner, rect, dx, dy, viewport, minHeight: this.bubble.minHeight });
      if (!this.bubble.hasAnswer()) {
        this.bubbleSize = { ...this.bubbleSize, width: Math.round(box.width), expanded: false };
        this.placeBubble();
        return;
      }
      this.bubbleSize = { width: Math.round(box.width), height: Math.round(box.height), expanded: false };
      this.freePlaced = true;
      const { crowded, place } = R.layout.freePlacement({ box, fox: this.fox.rect(), edge: this.fox.edge, viewport });
      this.bubble.el.dataset.crowded = crowded ? 'true' : 'false';
      this.bubble.place(place);
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
        this.bubble.setNotice({ text: `Couldn't take the screenshot. ${R.answers.scrubError((err && err.message) || err)}` });
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

      const reading = this.adapter.kind === 'page' ? 'page' : 'chat';
      const { chat, page, failed: unread } = this.bubble.readChat.checked
        ? R.readContext(this.adapter, this.site.name)
        : { chat: null, page: null, failed: false };

      // The image goes with this question only. failed() puts it back if no
      // answer arrives, so asking again sends it again.
      const image = this.attachment;
      if (image) this.setAttachment(null);
      this.last = { question, image };
      this.contextNote = '';
      this.bubble.startAnswer(question, { screenshot: Boolean(image) });
      // The answer area just appeared; apply the remembered size unless the
      // user has placed the bubble by hand.
      if (!this.freePlaced) this.placeBubble();
      if (unread) {
        this.bubble.setLine(this.line(reading === 'page' ? 'pageUnreadable' : 'chatUnreadable'), { onChar: this.blip });
        // Kept as the note about what was read, which later notes add to.
        this.contextNote = R.answers.unreadNote(reading);
        this.bubble.setNote(this.contextNote);
        this.react('startled', () => this.think());
      } else {
        this.bubble.setLine(this.line('thinking'), { onChar: this.blip });
        this.think();
      }

      this.request = R.sendQuestion(
        { question, chat, page, image },
        {
          loading: () => this.bubble.setLine(this.line('localLoading'), { onChar: this.blip }),
          context: (m) => {
            this.contextNote = R.answers.contextNote(m);
            if (this.contextNote) this.bubble.setNote(this.contextNote);
          },
          delta: (piece) => this.bubble.appendAnswer(piece),
          done: (text, limited) => {
            this.request = null;
            this.answered(text, { limited });
          },
          failed: (m, text) => {
            this.request = null;
            this.failed(m, text);
          },
        },
      );
    }

    // limited: the answer stopped at the model's output limit.
    answered(text, { limited = false } = {}) {
      this.bubble.setAnswer(text);
      // Added to the note about what was read, which stays.
      const extra = R.answers.endNote(text, limited);
      if (extra) this.bubble.setNote([this.contextNote, extra].filter(Boolean).join(' '));
      const line = this.line('answered');
      this.bubble.setLine(line, { onChar: this.blip });
      this.bubble.announce('Answer ready');
      this.last.answer = text;
      this.react('pounce');
      if (!this.bubble.isOpen && !this.hidden) this.fox.say(line);
    }

    failed(m, text) {
      const e = R.answers.errorStyle(m.kind);
      if ((!text || e.discard) && this.last && this.last.image && !this.attachment) this.setAttachment(this.last.image);
      this.bubble.setAnswer(e.discard ? '' : text);
      this.bubble.setNotice({ text: R.answers.errorDetail(m, this.state.providerName), settings: e.settings });
      const line = this.line(e.line);
      this.bubble.setLine(line, { onChar: this.blip });
      this.bubble.announce(line);
      if (m.kind === 'keyMissing' || m.kind === 'permission') this.refresh().catch(() => {});
      this.react('startled');
      if (!this.bubble.isOpen && !this.hidden) this.fox.say(line);
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
      if (!this.request) return;
      this.cancelAsk();
      this.bubble.setAnswer(this.bubble.markdown);
      this.bubble.setLine(this.line('stopped'), { onChar: this.blip });
      this.rest();
    }

    cancelAsk() {
      if (!this.request) return;
      const request = this.request;
      this.request = null;
      request.cancel();
    }
  };

  Object.assign(R.App.prototype, R.FoxBehavior);
})();
