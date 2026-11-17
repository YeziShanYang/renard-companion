// The screenshot picker: dims the page and lets the user drag a box over the
// part Renard should see. It lives in Renard's shadow root, above the page,
// and is gone before the screenshot is taken.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});
  const { h } = R;

  // A drag smaller than this either way counts as a click, which picks the
  // whole view.
  const MIN_DRAG = 8;
  // A page can swallow the keys and pointer events the picker listens to,
  // so it also gives up on its own after this long, and Renard's browser
  // shortcuts (which no page can block) cancel it through R.cancelPick.
  const GIVE_UP_MS = 60000;

  // Resolves to { x, y, w, h } in the viewport's CSS pixels, or null when the
  // user cancels with Esc, a right click, or a lost pointer. Enter or Space
  // picks the whole view. The picker is shown in the top layer, above
  // anything the page puts over Renard.
  R.pickRegion = function (root) {
    return new Promise((resolve) => {
      const box = h('div', { class: 'region-box', hidden: true });
      const hint = h('p', { class: 'region-hint px-box' }, 'Drag over what Renard should see. Click or press Enter for the whole view. Esc cancels.');
      const layer = h('div', { class: 'region-layer', role: 'dialog', 'aria-label': 'Choose part of the screen', tabindex: '-1', popover: 'manual' }, [box, hint]);
      let start = null;

      const clampX = (x) => Math.min(Math.max(0, x), innerWidth);
      const clampY = (y) => Math.min(Math.max(0, y), innerHeight);
      const regionTo = (e) => {
        const x = clampX(e.clientX);
        const y = clampY(e.clientY);
        return { x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) };
      };

      const whole = () => ({ x: 0, y: 0, w: innerWidth, h: innerHeight });
      let done = false;
      const finish = (region) => {
        if (done) return;
        done = true;
        clearTimeout(giveUp);
        if (R.cancelPick === cancel) R.cancelPick = null;
        removeEventListener('keydown', onKey, true);
        layer.remove();
        resolve(region);
      };
      const cancel = () => finish(null);
      const giveUp = setTimeout(cancel, GIVE_UP_MS);
      R.cancelPick = cancel;
      const onKey = (e) => {
        // Only the user's own keys: a page could fake Enter to take the
        // whole view (frames it can't read included) instead of the area.
        if (!e.isTrusted) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          finish(whole());
        }
      };

      layer.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        start = { x: clampX(e.clientX), y: clampY(e.clientY) };
        layer.setPointerCapture(e.pointerId);
      });
      layer.addEventListener('pointermove', (e) => {
        if (!start) return;
        const r = regionTo(e);
        if (r.w < MIN_DRAG && r.h < MIN_DRAG) return;
        layer.dataset.dragging = 'true';
        box.hidden = false;
        Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      });
      layer.addEventListener('pointerup', (e) => {
        if (!start) return;
        const r = regionTo(e);
        start = null;
        finish(r.w < MIN_DRAG || r.h < MIN_DRAG ? whole() : r);
      });
      layer.addEventListener('pointercancel', () => finish(null));
      layer.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        finish(null);
      });
      // The page under the picker stays where it is until the box is drawn.
      layer.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
      addEventListener('keydown', onKey, true);

      root.append(layer);
      try {
        layer.showPopover();
      } catch {
        // No popover support: the layer still sits at Renard's z-index.
      }
      layer.focus({ preventScroll: true });
    });
  };
})();
