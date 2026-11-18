// Renard's element on the page: a plain <div> holding a closed shadow root,
// so the site's CSS and Renard's stay apart. The stage shows it above the
// page, puts it back when the page removes it, undoes the page's zoom, and
// notices when the page replaces itself.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  R.Stage = class {
    // css: Renard's stylesheet. onReplaced: the page rewrote itself or
    // swapped its <html>. onOrphaned: the extension went away (reloaded or
    // updated) while the page stayed open.
    constructor({ css, onReplaced, onOrphaned }) {
      this.onReplaced = onReplaced;
      this.onOrphaned = onOrphaned;
      this.destroyed = false;
      this.restores = [];
      this.restoreTimer = 0;
      // A plain div, not a custom element: a page that defined
      // <renard-companion> first could reach the closed shadow root through
      // attachInternals().
      this.host = document.createElement('div');
      this.host.setAttribute(R.HOST_ATTR, '');
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      this.root = R.h('div', { class: 'renard-root', 'data-theme': 'light' });
      this.shadow.append(this.root);
      this.applyStyles(css);
    }

    // Puts Renard's element, holding children, on the page.
    show(children) {
      this.root.append(...children);
      // Clear any fox an older copy of the extension left on the page.
      for (const stray of document.querySelectorAll(R.HOST_SELECTOR)) if (stray !== this.host) stray.remove();
      // The page's root element at mount: when the page swaps it (a
      // document.open() rewrite, or a new <html>), Renard mounts afresh.
      this.page = document.documentElement;
      document.documentElement.append(this.host);
      // The element shows only while content/host.css is on the page. If a
      // page got the script without the sheet, Renard shows anyway, but
      // there it won't disappear when the extension is removed.
      if (getComputedStyle(this.host).display === 'none') this.host.style.setProperty('--renard-companion-display', 'block');
      this.raise();
      this.fitZoom();
      // Put Renard back if the page replaces the root element's children,
      // and show it again if the page moved it.
      this.observer = new MutationObserver(() => this.keep());
      this.observer.observe(document.documentElement, { childList: true });
    }

    destroy() {
      this.destroyed = true;
      clearTimeout(this.restoreTimer);
      if (this.observer) this.observer.disconnect();
      if (this.raiseAfterFullscreen) document.removeEventListener('fullscreenchange', this.raiseAfterFullscreen);
      this.host.remove();
    }

    // Keeps Renard on the page and in the top layer. False when the page
    // was replaced, and onReplaced has run.
    keep() {
      if (this.pageReplaced()) return false;
      if (!this.host.isConnected) this.restoreHost();
      else if (this.lowered()) this.raise();
      return true;
    }

    // A constructed stylesheet is immune to the page's Content Security
    // Policy (some sites forbid inline styles). Where adopting one fails, a
    // <style> element is the fallback.
    applyStyles(css) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        this.shadow.adoptedStyleSheets = [sheet];
        if (this.shadow.adoptedStyleSheets.length === 1) return;
      } catch {
        // fall through
      }
      const style = document.createElement('style');
      style.textContent = css;
      this.shadow.prepend(style);
    }

    // Shows Renard's root in the browser's top layer, where CSS on the
    // page's <html> (a transform, filter, contain or will-change) can't make
    // it scroll away with the page. Removing or moving the element closes
    // the popover, and a closed popover isn't shown at all, so it's shown
    // again as soon as it closes while the element is on the page, and
    // whenever the element is put back. Without popover support the root
    // stays at the host's z-index.
    raise() {
      const root = this.root;
      if (typeof root.showPopover !== 'function' || !this.host.isConnected || this.destroyed) return;
      if (!this.onPopoverToggle) {
        this.onPopoverToggle = (e) => {
          if (e.newState === 'closed') this.raise();
        };
        root.addEventListener('toggle', this.onPopoverToggle);
      }
      // Shown now, it would go above a video that's full screen.
      if (document.fullscreenElement) {
        if (!this.raiseAfterFullscreen) {
          this.raiseAfterFullscreen = () => {
            if (document.fullscreenElement) return;
            document.removeEventListener('fullscreenchange', this.raiseAfterFullscreen);
            this.raiseAfterFullscreen = null;
            this.raise();
          };
          document.addEventListener('fullscreenchange', this.raiseAfterFullscreen);
        }
        return;
      }
      try {
        if (!root.hasAttribute('popover')) root.setAttribute('popover', 'manual');
        if (!root.matches(':popover-open')) root.showPopover();
      } catch {
        root.removeAttribute('popover');
      }
    }

    // The popover was closed without a toggle event reaching Renard.
    lowered() {
      return this.root.hasAttribute('popover') && !this.root.matches(':popover-open');
    }

    // CSS zoom on the page's <html> would scale Renard too, and put the fox
    // off by the same factor from where its pixel positions say. The root
    // undoes it.
    fitZoom() {
      const zoom = Number(this.host.currentCSSZoom) || 1;
      const want = Math.abs(zoom - 1) < 0.001 ? '' : String(1 / zoom);
      if (this.root.style.zoom !== want) this.root.style.zoom = want;
    }

    // The page rewrote itself (document.open(), which also drops every event
    // listener on the page, Renard's included) or replaced its <html> (out
    // of the observers' reach). Putting the same element back would leave a
    // fox that can't be clicked, so a new Renard is mounted instead.
    pageReplaced() {
      const html = document.documentElement;
      if (!html || html === this.page) return false;
      this.onReplaced();
      return true;
    }

    // Puts Renard back on the page after the page removed it, at most five
    // times in ten seconds and never in the same task: a page that strips
    // every unknown element from <html> would otherwise remove and re-add it
    // forever and freeze the tab.
    restoreHost() {
      if (!R.contextAlive()) {
        this.onOrphaned();
        return;
      }
      if (this.restoreTimer) return;
      const now = performance.now();
      this.restores = this.restores.filter((t) => now - t < 10000);
      if (this.restores.length >= 5) return;
      this.restores.push(now);
      this.restoreTimer = setTimeout(() => {
        this.restoreTimer = 0;
        // Mid-rewrite, the page can have no root element for a moment.
        if (this.destroyed || this.host.isConnected || !document.documentElement) return;
        document.documentElement.append(this.host);
        this.raise();
      }, 50);
    }
  };

  // Renard's pixel font, from the bytes the background sent, so the page's
  // font-src policy is never involved. Added to the page once.
  R.loadFonts = async function (assets) {
    if (R.fontsLoaded) return;
    R.fontsLoaded = true;
    const faces = [
      ['400', assets.fontRegular],
      ['700', assets.fontBold],
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
  };

  // A PNG sent as base64, decoded for drawing, or null.
  R.decodeImage = async function (b64) {
    if (!b64) return null;
    try {
      return await createImageBitmap(new Blob([R.decodeBase64(b64)], { type: 'image/png' }));
    } catch {
      return null;
    }
  };
})();
