// Where things go on the page: the fox's margin, and the bubble's size and
// position beside the fox. Pure functions of the measurements passed in, so
// they can be tested without a page.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  const EDGE_GAP = 28; // closest the fox's body ever rests to the screen edge
  const MAX_INSET = 260; // farthest it wanders from the edge
  const MARGIN = 12; // the bubble's least distance from the viewport's edges
  const BUBBLE_WIDTH = 520; // default width; corners resize it
  const EXPANDED_WIDTH = 720;
  const LEGACY_WIDTH = 420; // the earlier default, saved alongside the expand toggle
  const OVERLAP = 6; // how far the bubble's tail reaches over the fox

  // The side of the fox the bubble opens on: toward the page.
  const sideFor = (edge) => (edge === 'right' ? 'left' : 'right');

  // Range of insets (gap from the screen edge to the fox's body) that keep
  // the fox in the margin beside the site's content column, away from both
  // the screen edge and the column. The column is measured from the site's
  // message input (composer, a rect or null); without one, a fraction of
  // the window is used.
  function margins(edge, { viewportWidth: vw, composer, bodyWidth }) {
    let room = Math.min(MAX_INSET + 100, vw * 0.2);
    if (composer && composer.width < vw * 0.9) room = edge === 'left' ? composer.left : vw - composer.right;
    const max = Math.min(MAX_INSET, room - bodyWidth - 16);
    return { min: EDGE_GAP, max: Math.max(EDGE_GAP, max) };
  }

  // In a window too narrow for the bubble beside the fox, the bubble covers
  // part of the fox. It's drawn above the fox then, so its buttons stay
  // clickable.
  function crowded(edge, left, width, fox) {
    return sideFor(edge) === 'left' ? left + width > fox.left + OVERLAP + 1 : left < fox.right - OVERLAP - 1;
  }

  // The bubble beside the fox. Returns whether it's crowded and the
  // arguments for Bubble.place().
  //   fox: the fox's rect; edge: the screen edge it rests on
  //   viewport: { width, height }
  //   size: the remembered { width, height, expanded }
  //   answering: a question has been asked (the answer area shows)
  //   minHeight: the least height that shows the bubble's content
  //   composer: the site's message box rect, or null
  function placement({ fox: r, edge, viewport, size, answering, minHeight, composer }) {
    const vw = viewport.width;
    const vh = viewport.height;
    const side = sideFor(edge);
    const room = side === 'left' ? r.left + OVERLAP - MARGIN : vw - r.right + OVERLAP - MARGIN;
    const maxW = Math.max(240, Math.min(vw * 0.9, room, vw - 2 * MARGIN));
    const expanded = Boolean(size.expanded);
    const saved = size.width && size.width !== LEGACY_WIDTH ? size.width : BUBBLE_WIDTH;
    const wanted = expanded ? EXPANDED_WIDTH : saved;
    const width = Math.min(Math.max(wanted, Math.min(360, maxW)), maxW);
    let left = side === 'left' ? r.left + OVERLAP - width : r.right - OVERLAP;
    left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - MARGIN - width));

    // Before a question the bubble fits its content (the line and the
    // input): the reading view's height and a dragged-out height wait for
    // an answer.
    const fill = expanded && answering;
    // A height the user dragged out, while there is an answer to show:
    // never less than the content needs, never more than the room there is.
    const sized = (maxHeight) => (answering && !fill && size.height ? Math.min(Math.max(size.height, minHeight), maxHeight) : 0);
    // The height the bubble needs to show everything without clipping.
    const need = Math.min(Math.max(minHeight, 200), vh - 2 * MARGIN);
    // The bubble keeps clear of the site's message box when there is room
    // for it on the fox's side of the box, ending at most a little above
    // the fox. A box farther up, level with the fox, is covered instead:
    // moving away from the fox to avoid it would leave the tail pointing at
    // nothing.
    let floor = vh - MARGIN;
    let ceiling = MARGIN;
    const comp = composer;
    if (comp && comp.left < left + width && comp.right > left) {
      if (comp.top - MARGIN >= r.top - 48) floor = comp.top - MARGIN;
      else if (comp.bottom + MARGIN <= r.bottom) ceiling = comp.bottom + MARGIN;
    }
    const headY = r.top + r.height * 0.3;
    const common = { side, left, width, expanded: fill, pressed: expanded };
    const isCrowded = crowded(edge, left, width, r);

    if (r.top + r.height / 2 < vh * 0.45) {
      // Fox in the upper part of the screen: hang the bubble from beside it
      // and let it grow downward.
      const top = Math.max(MARGIN, r.top - 24);
      const bottom = floor - top >= need ? floor : vh - MARGIN;
      const maxHeight = Math.max(bottom - top, Math.min(need, vh - MARGIN - top));
      return {
        crowded: isCrowded,
        place: {
          ...common,
          anchor: 'top',
          offset: top,
          height: sized(maxHeight),
          maxHeight,
          tailOffset: headY - top - 4,
          expandedHeight: Math.min(vh * 0.8, maxHeight),
        },
      };
    }
    // Otherwise grow upward from a fixed bottom edge beside the fox, so the
    // input stays put while an answer streams in.
    let bottomY = Math.min(floor, Math.max(r.bottom + 12, MARGIN + 300));
    if (bottomY - MARGIN < need) bottomY = Math.min(vh - MARGIN, Math.max(r.bottom + 12, MARGIN + 300));
    const top = bottomY - ceiling >= need ? ceiling : MARGIN;
    const maxHeight = Math.max(160, bottomY - top);
    return {
      crowded: isCrowded,
      place: {
        ...common,
        anchor: 'bottom',
        offset: vh - bottomY,
        height: sized(maxHeight),
        maxHeight,
        tailOffset: bottomY - headY - 8,
        expandedHeight: Math.min(vh * 0.8, maxHeight),
      },
    };
  }

  // Corner drag: the dragged corner follows the pointer and the opposite
  // corner stays put, within the viewport and no smaller than the content
  // needs. rect: the bubble's rect when the drag started; dx, dy: how far
  // the pointer has moved since.
  function resized({ corner, rect, dx, dy, viewport, minHeight }) {
    const vw = viewport.width;
    const vh = viewport.height;
    const minW = Math.min(300, vw - 2 * MARGIN);
    const minH = Math.min(Math.max(120, minHeight), vh - 2 * MARGIN);
    let { left, top, right, bottom } = rect;
    if (corner.includes('w')) left = Math.min(Math.max(rect.left + dx, MARGIN), right - minW);
    if (corner.includes('e')) right = Math.max(Math.min(rect.right + dx, vw - MARGIN), left + minW);
    if (corner.includes('n')) top = Math.min(Math.max(rect.top + dy, MARGIN), bottom - minH);
    if (corner.includes('s')) bottom = Math.max(Math.min(rect.bottom + dy, vh - MARGIN), top + minH);
    return { left, top, width: right - left, height: bottom - top };
  }

  // A bubble resized by hand, where the user left it.
  function freePlacement({ box, fox: r, edge, viewport }) {
    return {
      crowded: crowded(edge, box.left, box.width, r),
      place: {
        side: sideFor(edge),
        anchor: 'top',
        offset: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        maxHeight: Math.max(box.height, viewport.height - MARGIN - box.top),
        tailOffset: r.top + r.height * 0.3 - box.top - 4,
        expanded: false,
        expandedHeight: 0,
      },
    };
  }

  R.layout = { EDGE_GAP, margins, placement, resized, freePlacement };
})();
