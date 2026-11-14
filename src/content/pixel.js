// Small helpers shared by the content-script UI: element building, pixel
// icons, canned-line picking, the typewriter effect, and the optional blip.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});
  const SVG_NS = 'http://www.w3.org/2000/svg';

  R.ext = globalThis.browser ?? globalThis.chrome;

  // False once the extension has been reloaded, updated, or removed while
  // this page stayed open (runtime.id goes away for orphaned scripts).
  R.contextAlive = function () {
    try {
      return Boolean(R.ext.runtime && R.ext.runtime.id);
    } catch {
      return false;
    }
  };

  R.send = async function (type, payload = {}) {
    const res = await R.ext.runtime.sendMessage({ type, ...payload });
    if (!res || !res.ok) throw new Error((res && res.error) || 'No response from Renard');
    return res.result;
  };

  R.reducedMotion = () => globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // h('div', { class: 'x', onclick: fn }, [child, 'text'])
  R.h = function (tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      el.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  };

  // Icons are drawn on a pixel grid ('#' = filled) and rendered as crisp SVG
  // rects in currentColor, so they recolor with their button's state.
  R.ICONS = {
    close: ['##...##', '.##.##.', '..###..', '...#...', '..###..', '.##.##.', '##...##'],
    expand: ['###.###', '#.....#', '#.....#', '.......', '#.....#', '#.....#', '###.###'],
    collapse: ['.#...#.', '##...##', '.......', '.......', '.......', '##...##', '.#...#.'],
    copy: ['..######', '..#....#', '######.#', '#....#.#', '#....#.#', '#....###', '#....#..', '######..'],
    check: ['.......#', '......##', '#....##.', '##..##..', '.####...', '..##....'],
    chat: ['.#######.', '#.......#', '#.#.#.#.#', '#.......#', '.#######.', '..##.....', '..#......'],
    stop: ['######', '######', '######', '######', '######', '######'],
    grip: ['#.#.#.#', '.......', '#.#.#..', '.......', '#.#....', '.......', '#......'],
  };

  R.icon = function (name, scale = 2) {
    const rows = R.ICONS[name];
    const h = rows.length;
    const w = rows[0].length;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(w * scale));
    svg.setAttribute('height', String(h * scale));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('class', `px-icon px-icon-${name}`);
    rows.forEach((row, y) => {
      let x = 0;
      while (x < w) {
        if (row[x] !== '#') {
          x++;
          continue;
        }
        let end = x;
        while (end < w && row[end] === '#') end++;
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(end - x));
        rect.setAttribute('height', '1');
        rect.setAttribute('fill', 'currentColor');
        svg.append(rect);
        x = end;
      }
    });
    return svg;
  };

  // Speech-bubble tail drawn as a stepped wedge: paper fill with an ink edge.
  R.tail = function (units = 5) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${units} ${units}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('class', 'tail');
    const add = (x, y, w, cls) => {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String(y));
      r.setAttribute('width', String(w));
      r.setAttribute('height', '1');
      r.setAttribute('class', cls);
      svg.append(r);
    };
    for (let y = 0; y < units - 1; y++) {
      if (y > 0) add(0, y, y, 'tail-fill');
      add(y, y, 1, 'tail-ink');
    }
    add(0, units - 1, units, 'tail-ink');
    return svg;
  };

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
  };

  // RPG-style reveal. Returns a cancel function. The full text is exposed to
  // assistive tech separately by the caller, so it is announced once.
  R.typewrite = function (el, text, { speed = 28, onChar } = {}) {
    const chars = Array.from(text);
    if (R.reducedMotion() || chars.length === 0) {
      el.textContent = text;
      return () => {};
    }
    let i = 0;
    el.textContent = '';
    const timer = setInterval(() => {
      i++;
      el.textContent = chars.slice(0, i).join('');
      if (onChar && i % 2 === 1 && chars[i - 1].trim()) onChar();
      if (i >= chars.length) clearInterval(timer);
    }, speed);
    return () => {
      clearInterval(timer);
      el.textContent = text;
    };
  };

  R.decodeBase64 = function (b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
})();
