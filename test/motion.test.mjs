import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/content/motion.js');
const { meander } = globalThis.Renard;

// Small deterministic PRNG so paths are reproducible.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('a path ends exactly at the target', () => {
  const path = meander({ x: 0, y: 0 }, { x: 300, y: 120 }, { rand: seeded(1) });
  assert.deepEqual({ x: path.at(-1).x, y: path.at(-1).y }, { x: 300, y: 120 });
  assert.ok(path.length >= 2 && path.length <= 4, `${path.length} points`);
});

test('short hops go straight there', () => {
  const path = meander({ x: 10, y: 10 }, { x: 20, y: 15 }, { rand: seeded(2) });
  assert.equal(path.length, 1);
});

test('waypoints leave the straight line', () => {
  let offLine = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const path = meander({ x: 0, y: 0 }, { x: 400, y: 0 }, { rand: seeded(seed) });
    offLine += path.slice(0, -1).filter((p) => Math.abs(p.y) > 4).length;
  }
  assert.ok(offLine > 10, `${offLine} off-line waypoints`);
});

test('every waypoint stays inside the bounds', () => {
  const bounds = { minX: 0, maxX: 200, minY: 50, maxY: 150 };
  for (let seed = 1; seed <= 50; seed++) {
    for (const p of meander({ x: 10, y: 60 }, { x: 190, y: 140 }, { wiggle: 200, bounds, rand: seeded(seed) })) {
      assert.ok(p.x >= 0 && p.x <= 200 && p.y >= 50 && p.y <= 150, JSON.stringify(p));
    }
  }
});

test('speeds vary gently, hops happen, and hops can be turned off', () => {
  const speeds = [];
  let hops = 0;
  for (let seed = 1; seed <= 30; seed++) {
    for (const p of meander({ x: 0, y: 0 }, { x: 300, y: 0 }, { rand: seeded(seed) })) {
      speeds.push(p.speed);
      if (p.hop) hops++;
      assert.equal(p.pause, undefined, 'no stops along a path');
    }
    assert.ok(meander({ x: 0, y: 0 }, { x: 300, y: 0 }, { hops: false, rand: seeded(seed) }).every((p) => !p.hop));
  }
  assert.ok(Math.min(...speeds) >= 0.85 && Math.max(...speeds) <= 1.25, 'speed changes stay small');
  assert.ok(new Set(speeds.map((v) => v.toFixed(2))).size > 10);
  assert.ok(hops > 0, 'some runs include a hop');
});
