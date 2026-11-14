// Path planning for the fox's runs and strolls. Instead of heading straight
// for its target, the fox follows a few waypoints pushed off the straight
// line, at varied speeds, with the odd stop to look around or hop.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  // from, to: { x, y }. Returns waypoints { x, y, speed, pause, anim } ending
  // exactly at `to`. speed is a multiplier of the caller's base speed; pause
  // (ms) and anim ('idle' | 'pounce') describe a stop at that waypoint.
  // bounds: { minX, maxX, minY, maxY } that every waypoint stays inside.
  R.meander = function (from, to, { wiggle = 48, bounds = null, stops = true, rand = Math.random } = {}) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    const points = [];
    if (len > 24) {
      // Unit vector across the straight line, for the sideways wobble.
      const nx = -dy / len;
      const ny = dx / len;
      const n = clamp(Math.round(len / 90), 1, 3);
      // Zig-zag: alternate sides of the line, always at least a third of
      // the way out, so the path visibly weaves.
      let side = rand() < 0.5 ? -1 : 1;
      for (let i = 1; i <= n; i++) {
        const t = (i + (rand() - 0.5) * 0.5) / (n + 1);
        const off = side * (0.35 + rand() * 0.65) * wiggle * Math.min(1, len / 160);
        side = -side;
        const stop = stops ? rand() : 1;
        points.push({
          x: from.x + dx * t + nx * off,
          y: from.y + dy * t + ny * off,
          speed: 0.7 + rand() * 0.7,
          pause: stop < 0.12 ? 1 : stop < 0.3 ? 250 + rand() * 450 : 0,
          anim: stop < 0.12 ? 'pounce' : 'idle',
        });
      }
    }
    points.push({ x: to.x, y: to.y, speed: 0.8 + rand() * 0.4, pause: 0, anim: 'idle' });
    if (bounds) {
      for (const p of points) {
        p.x = clamp(p.x, bounds.minX, bounds.maxX);
        p.y = clamp(p.y, bounds.minY, bounds.maxY);
      }
    }
    return points;
  };
})();
