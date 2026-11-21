// The first-run tour on the settings page, checked in a real Firefox driven
// over WebDriver BiDi. Each scenario starts a headless Firefox on a new
// temporary profile, installs a packaged build as a temporary add-on, and
// works the page with real key presses and pointer clicks.
//
//   node test/e2e/firefox-install.mjs [path-to-firefox-zip] [--old zip] [--out dir] [--only A,C]
//
// The zip defaults to the newest dist/renard-firefox-*.zip by version. The
// update scenario starts from --old (default dist/renard-firefox-0.1.3.zip)
// and is skipped when there's no such file. Screenshots go to --out (default
// dist/e2e-shots/), and FIREFOX_BIN overrides the Firefox binary. Only Node built-ins are used, and
// the file sits outside npm test's glob because it needs Firefox installed.
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');
const FIREFOX_BIN = process.env.FIREFOX_BIN || '/Applications/Firefox.app/Contents/MacOS/firefox';
const ADDON_ID = 'renard-companion@YeziShanYang';
// The last build before the tour, used as the starting point for the update
// (--old picks another zip of a version before 0.1.4).
const DEFAULT_OLD_ZIP = path.join(DIST, 'renard-firefox-0.1.3.zip');
const DEFAULT_OUT = path.join(DIST, 'e2e-shots');
const VIEWPORT = { width: 1280, height: 800 };
const SPACE = ' ';
const ESCAPE = '\uE00C'; // WebDriver's code for the Escape key
const ARROW_LEFT = '\uE012';
const ARROW_RIGHT = '\uE014';
const PHONE = { width: 390, height: 844 };
// Settings a stress scenario must leave alone, compared as JSON.
const SETTINGS_KEYS = ['provider', 'sites', 'allSites', 'otherSites', 'skippedSites', 'prefs', 'localModel', 'spawned'];
// The heading of the section each step points at, or null, as in buildSteps()
// in src/options/tour.js. Update it when the steps change.
const STEP_TARGETS = [null, null, 'ai-title', 'ai-title', 'sites-title', 'shots-title', 'keys-title', null];

// First-run noise a new profile would otherwise show: the default-browser
// prompt, the welcome and What's New pages, and the data-reporting notice.
const BASE_PREFS = {
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'startup.homepage_welcome_url': '',
  'startup.homepage_welcome_url.additional': '',
  'browser.startup.homepage': 'about:blank',
  'browser.startup.page': 0,
  'browser.aboutwelcome.enabled': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'app.update.disabledForTesting': true,
  'extensions.update.enabled': false,
  // Closing the settings tab in the update scenario must not close the window.
  'browser.tabs.closeWindowWithLastTab': false,
  'browser.tabs.warnOnClose': false,
  // Headless Firefox follows the system's dark mode. Light everywhere but the
  // dark-mode scenario keeps screenshots the same on every machine.
  'layout.css.prefers-color-scheme.content-override': 1,
  // Prints console calls from pages (extension pages included) on stdout, so
  // console.error shows up next to the "JavaScript error:" lines.
  'devtools.console.stdout.content': true,
};

// ---- command line -------------------------------------------------------------

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, only: { type: 'string' }, old: { type: 'string' } },
});
const OUT = path.resolve(flags.out || DEFAULT_OUT);
const OLD_ZIP = path.resolve(flags.old || DEFAULT_OLD_ZIP);

function versionOf(file) {
  const m = /renard-firefox-(\d+(?:\.\d+)*)\.zip$/.exec(file);
  return m ? m[1].split('.').map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function newestZip() {
  const zips = (await readdir(DIST)).filter(versionOf);
  if (!zips.length) throw new Error(`No renard-firefox-*.zip in ${DIST}; run npm run build first`);
  zips.sort((a, b) => compareVersions(versionOf(a), versionOf(b)));
  return path.join(DIST, zips.at(-1));
}

// ---- small helpers -------------------------------------------------------------

class Failure extends Error {}

function check(cond, message) {
  if (!cond) throw new Failure(message);
}

// Polls fn until it returns something truthy. Errors thrown while polling
// count as "not yet", since a page that is still navigating can't run scripts.
async function until(what, fn, { timeout = 5000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  let lastError;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      if (err instanceof Failure) throw err;
      lastError = err;
    }
    if (Date.now() > end) {
      const why = lastError ? ` (last error: ${lastError.message})` : '';
      throw new Failure(`Timed out after ${timeout} ms waiting for ${what}${why}`);
    }
    await sleep(interval);
  }
}

const isOptionsUrl = (url) => typeof url === 'string' && /^moz-extension:\/\/[^/]+\/options\/options\.html/.test(url);

// ---- Firefox ------------------------------------------------------------------

// Everything a run has started, so Ctrl-C or a crash still cleans up.
const running = new Set();
const tempDirs = new Set();

async function launchFirefox(prefs) {
  const profile = await mkdtemp(path.join(tmpdir(), 'renard-e2e-'));
  const userJs = Object.entries({ ...BASE_PREFS, ...prefs })
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n');
  await writeFile(path.join(profile, 'user.js'), `${userJs}\n`);

  // Port 0 lets Firefox pick a free port, which it then prints on stderr.
  // -no-remote and our own profile keep it apart from any Firefox already open.
  // Firefox counts moz-extension tabs as privileged, and BiDi runs scripts,
  // input and screenshots in them only with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS set.
  const child = spawn(FIREFOX_BIN, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  });
  const ff = { child, profile, log: [], exited: false, onLine: null };
  running.add(ff);
  child.on('exit', () => {
    ff.exited = true;
  });
  // Output arrives in chunks that can split a line, so each stream keeps
  // its unfinished last line until the rest comes in.
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        ff.log.push(line);
        ff.onLine?.(line);
      }
      if (ff.log.length > 200) ff.log.splice(0, ff.log.length - 200);
    });
  }

  try {
    ff.wsUrl = await until(
      'Firefox to start its WebDriver BiDi server',
      () => {
        if (ff.exited) throw new Failure(`Firefox exited at startup:\n${ff.log.slice(-20).join('\n')}`);
        for (const line of ff.log) {
          const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(line);
          if (m) return `${m[1].replace(/\/$/, '')}/session`;
        }
        return null;
      },
      { timeout: 30000, interval: 100 },
    );
  } catch (err) {
    await stopFirefox(ff);
    throw err;
  }
  return ff;
}

async function stopFirefox(ff, bidi) {
  if (bidi) {
    await bidi.send('browser.close', {}, 3000).catch(() => {});
    bidi.close();
  }
  if (!ff.exited) {
    const gone = new Promise((resolve) => ff.child.once('exit', resolve));
    ff.child.kill('SIGTERM');
    const timer = setTimeout(() => ff.child.kill('SIGKILL'), 5000);
    await gone;
    clearTimeout(timer);
  }
  await rm(ff.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  running.delete(ff);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await Promise.all([...running].map((ff) => stopFirefox(ff)));
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    process.exit(130);
  });
}

// ---- WebDriver BiDi --------------------------------------------------------------

class Bidi {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`Could not connect to ${url}`)), { once: true });
    });
    return new Bidi(ws);
  }

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'event') {
        for (const fn of this.#listeners) fn(msg.method, msg.params);
        return;
      }
      const waiter = this.#pending.get(msg.id);
      if (!waiter) return;
      this.#pending.delete(msg.id);
      if (msg.type === 'success') waiter.resolve(msg.result);
      else waiter.reject(new Error(`${waiter.method}: ${msg.error}: ${msg.message}`));
    });
    ws.addEventListener('close', () => {
      for (const waiter of this.#pending.values()) waiter.reject(new Error(`${waiter.method}: connection closed`));
      this.#pending.clear();
    });
  }

  send(method, params = {}, timeout = 30000) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no reply in ${timeout} ms`));
      }, timeout);
      const done = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.#pending.set(id, { method, resolve: done(resolve), reject: done(reject) });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(fn) {
    this.#listeners.add(fn);
  }

  close() {
    this.#ws.close();
  }
}

// ---- the settings page -------------------------------------------------------------

// Read inside the page. #tour is the wrapper and .tour-card the card the user
// sees, so "shown" asks whether the card is rendered at all; opacity is left
// out so a card that is still fading in counts as shown.
function readTour() {
  const tour = document.getElementById('tour');
  if (!tour) return { found: false, ready: document.readyState };
  const card = tour.querySelector('.tour-card') || tour;
  const control = (id) => {
    const el = document.getElementById(id);
    return el ? { shown: el.checkVisibility({ visibilityProperty: true }), text: el.textContent.trim() } : null;
  };
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
  };
  // The section a step points at is the .card the tour marks .tour-target.
  const target = document.querySelector('.tour-target');
  const heading = target?.querySelector('h1, h2, h3');
  const root = document.documentElement;
  const page = document.querySelector('.page');
  const hero = document.querySelector('.hero-fox');
  const active = document.activeElement;
  // Content that sticks out of the card sideways. A fixed card's overflow
  // doesn't widen the page, so scrollWidth alone can't see it. Elements of a
  // pixel or less are screen-reader-only text.
  const box = card.getBoundingClientRect();
  const spills = [];
  for (const el of card.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1 || !el.checkVisibility({ visibilityProperty: true })) continue;
    const over = Math.max(box.left - r.left, r.right - box.right);
    if (over > 0.5) {
      const name = `<${el.localName}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}>`;
      spills.push({ name, over, left: r.left, right: r.right, text: el.textContent.trim().slice(0, 30) });
    }
  }
  return {
    found: true,
    ready: document.readyState,
    hiddenAttr: tour.hasAttribute('hidden'),
    shown: !tour.hasAttribute('hidden') && card.checkVisibility({ visibilityProperty: true }),
    step: num(tour.dataset.step),
    steps: num(tour.dataset.steps),
    typing: tour.hasAttribute('data-typing'),
    pinned: tour.hasAttribute('data-pinned'),
    text: (document.getElementById('tour-text')?.textContent || '').trim(),
    next: control('tour-next'),
    back: control('tour-back'),
    skip: control('tour-skip'),
    scrollY: Math.round(scrollY),
    card: rect(card),
    spills,
    target: target ? { ...rect(target), heading: heading?.id || null, headingBox: rect(heading) } : null,
    viewport: { width: root.clientWidth, height: root.clientHeight },
    scrollWidth: root.scrollWidth,
    tourCount: document.querySelectorAll('#tour').length,
    targets: [...document.querySelectorAll('.tour-target')].map((el) => el.querySelector('h1, h2, h3')?.id || el.className),
    focus: !!page?.hasAttribute('data-tour-focus'),
    touring: !!page?.hasAttribute('data-touring'),
    hero: hero ? hero.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : null,
    active: active ? `${active.localName}${active.id ? `#${active.id}` : ''}` : null,
  };
}

// Centers of what the drag scenario presses and releases on. The provider
// button is the first one not already chosen.
function dragPoints() {
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  const label = [...document.querySelectorAll('input[name="provider"]')].find((i) => !i.checked)?.closest('label');
  return {
    fox: center(document.getElementById('tour-fox')),
    say: center(document.querySelector('#tour .tour-say')),
    next: center(document.getElementById('tour-next')),
    provider: label ? { ...center(label), name: label.textContent.trim() } : null,
  };
}

// Finds a control, scrolls it into view only if it's off screen (as a person
// would before clicking), and reports its center and what is on top there.
function locate(id) {
  const el = document.getElementById(id);
  if (!el) return { missing: true };
  let r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    r = el.getBoundingClientRect();
  }
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  const describe = (n) => (n ? `<${n.localName}${n.id ? `#${n.id}` : ''}${n.className && typeof n.className === 'string' ? `.${n.className.trim().split(/\s+/).join('.')}` : ''}>` : 'nothing');
  return { x, y, width: r.width, height: r.height, onTop: el.contains(hit), hit: describe(hit) };
}

class Page {
  constructor(bidi, context, url) {
    this.bidi = bidi;
    this.context = context;
    this.url = url;
  }

  // Runs fn in the page's own realm, where the extension's browser API is
  // available. The result crosses back as JSON to skip BiDi's value encoding.
  async run(fn, ...args) {
    const res = await this.bidi.send('script.callFunction', {
      functionDeclaration: `async (...args) => JSON.stringify(await (${fn})(...args))`,
      arguments: args.map((value) => (value === null ? { type: 'null' } : { type: typeof value, value })),
      target: { context: this.context },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    if (res.type === 'exception') throw new Error(`Page script threw: ${res.exceptionDetails.text}`);
    return res.result.type === 'string' ? JSON.parse(res.result.value) : undefined;
  }

  tour() {
    return this.run(readTour);
  }

  tourDone() {
    return this.run(async () => (await browser.storage.local.get('tourDone')).tourDone ?? null);
  }

  // BiDi's browsingContext.activate refuses extension tabs, so the page asks
  // the tabs API to select its own tab instead.
  async activate() {
    await this.run(async () => {
      const tab = await browser.tabs.getCurrent();
      await browser.tabs.update(tab.id, { active: true });
      return true;
    });
    await until('the settings tab to become visible', () => this.run(() => document.visibilityState === 'visible'));
  }

  async waitLoaded() {
    await until('the settings page to finish loading', () => this.run(() => document.readyState === 'complete'), {
      timeout: 15000,
    });
  }

  async reload() {
    await this.bidi.send('browsingContext.reload', { context: this.context, wait: 'complete' });
    await this.waitLoaded();
  }

  async press(value) {
    await this.bidi.send('input.performActions', {
      context: this.context,
      actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }],
    });
  }

  // The settings stress scenarios must leave alone, each as its JSON text.
  settings() {
    return this.run(async (json) => {
      const keys = JSON.parse(json);
      const got = await browser.storage.local.get(keys);
      return Object.fromEntries(keys.map((k) => [k, k in got ? JSON.stringify(got[k]) : null]));
    }, JSON.stringify(SETTINGS_KEYS));
  }

  async pointer(actions) {
    await this.bidi.send('input.performActions', {
      context: this.context,
      actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }],
    });
  }

  // A control's center, after checking that nothing covers it there, since a
  // covered button can't be clicked by a person either.
  async aim(id) {
    const at = await this.run(locate, id);
    check(!at.missing, `#${id} not found on the settings page`);
    check(at.width > 0 && at.height > 0, `#${id} has no size, so it can't be clicked`);
    check(at.onTop, `#${id} is covered by ${at.hit} at (${at.x}, ${at.y})`);
    return at;
  }

  // A real mouse click at the control's center.
  async click(id) {
    await this.spamAt(await this.aim(id), 1, 0);
  }

  // For bursts: clicks the control if a person could (shown and on top),
  // and says whether it did.
  async tryClick(id) {
    const at = await this.run(locate, id);
    if (at.missing || !at.width || !at.height || !at.onTop) return false;
    await this.spamAt(at, 1, 0);
    return true;
  }

  // Clicks one spot again and again without re-aiming, `every` ms apart.
  // One performActions call keeps the timing in Firefox's hands.
  async spamAt({ x, y }, times, every) {
    const actions = [{ type: 'pointerMove', x, y, origin: 'viewport', duration: 0 }];
    for (let i = 0; i < times; i++) {
      actions.push({ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 });
      if (every && i < times - 1) actions.push({ type: 'pause', duration: every });
    }
    await this.pointer(actions);
  }

  // Presses at the first point, moves through the rest, releases at the last.
  async drag([start, ...rest]) {
    await this.pointer([
      { type: 'pointerMove', x: start.x, y: start.y, origin: 'viewport', duration: 0 },
      { type: 'pointerDown', button: 0 },
      ...rest.map(({ x, y }) => ({ type: 'pointerMove', x, y, origin: 'viewport', duration: 30 })),
      { type: 'pointerUp', button: 0 },
    ]);
  }

  // Presses each key in turn, `every` ms apart.
  async keys(values, every) {
    const actions = [];
    for (const value of values) actions.push({ type: 'keyDown', value }, { type: 'keyUp', value }, { type: 'pause', duration: every });
    await this.bidi.send('input.performActions', {
      context: this.context,
      actions: [{ type: 'key', id: 'keyboard', actions }],
    });
  }

  async screenshot(file) {
    // Two frames so the last style change is painted before the capture. A
    // background tab runs no frames, so don't wait on them past a second.
    await this.run(
      () =>
        new Promise((r) => {
          requestAnimationFrame(() => requestAnimationFrame(() => r(true)));
          setTimeout(() => r(true), 1000);
        }),
    );
    const { data } = await this.bidi.send('browsingContext.captureScreenshot', { context: this.context });
    await writeFile(file, Buffer.from(data, 'base64'));
  }
}

// ---- one scenario's session ------------------------------------------------------------

class Session {
  constructor(key, label, prefs, viewport) {
    this.key = key;
    this.label = label;
    this.prefs = prefs;
    this.viewport = viewport;
    this.dir = path.join(OUT, `${key}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    this.shots = 0;
    this.errors = [];
    this.urls = new Map(); // context id -> last known URL
    this.navigations = []; // { url, at } for every context created or navigated
    this.pages = [];
  }

  async start() {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    this.ff = await launchFirefox(this.prefs);
    this.ff.onLine = (line) => this.#output(line);
    this.bidi = await Bidi.connect(this.ff.wsUrl);
    const { capabilities } = await this.bidi.send('session.new', { capabilities: {} });
    this.browserVersion = `${capabilities.browserName} ${capabilities.browserVersion}`;
    this.bidi.on((method, params) => this.#event(method, params));
    await this.bidi.send('session.subscribe', {
      events: ['log.entryAdded', 'browsingContext.contextCreated', 'browsingContext.navigationStarted', 'browsingContext.load'],
    });
    // Set for the whole default user context, which also covers tabs opened
    // later. BiDi refuses a per-tab setViewport on extension tabs.
    await this.bidi.send('browsingContext.setViewport', { userContexts: ['default'], viewport: this.viewport });
  }

  // Firefox 160's BiDi leaves extension pages out when it sets up event
  // listeners (Bug 1755014), so log.entryAdded never fires for them. Firefox
  // still prints their uncaught errors and rejections on stderr with the
  // page's URL, and, with devtools.console.stdout.content, their
  // console.error calls without one. The only pages open in this profile are
  // the extension's, so every console.error counts.
  #output(line) {
    const js = /^JavaScript error: (moz-extension:\/\/\S+), line (\d+): (.*)$/.exec(line);
    if (js) this.errors.push(`uncaught: ${js[3]} at ${js[1]}:${js[2]}`);
    else if (line.startsWith('console.error: ')) this.errors.push(line);
  }

  #event(method, params) {
    if (method.startsWith('browsingContext.')) {
      if (params.url) {
        this.urls.set(params.context, params.url);
        this.navigations.push({ url: params.url, at: Date.now() });
      }
      return;
    }
    // Kept for pages Firefox does report on, and for when it covers extensions.
    if (method !== 'log.entryAdded' || params.level !== 'error') return;
    // Errors count when they come from one of the extension's pages, judged
    // by the page they were logged in or, failing that, by the stack.
    const url = this.urls.get(params.source?.context) || '';
    const frames = params.stackTrace?.callFrames || [];
    const fromExtension = url.startsWith('moz-extension://') || frames.some((f) => f.url?.startsWith('moz-extension://'));
    const where = frames[0] ? ` at ${frames[0].url}:${frames[0].lineNumber + 1}` : url ? ` in ${url}` : '';
    const line = `${params.type === 'console' ? 'console.error' : 'uncaught'}: ${params.text}${where}`;
    if (fromExtension) this.errors.push(line);
  }

  // Resizes every tab, since BiDi won't resize one extension tab alone.
  async resize(viewport) {
    await this.bidi.send('browsingContext.setViewport', { userContexts: ['default'], viewport });
  }

  note(message) {
    console.log(`     ${message}`);
  }

  async shot(page, label) {
    const name = `${String(++this.shots).padStart(2, '0')}-${label}.png`;
    await page.screenshot(path.join(this.dir, name));
  }

  async tree() {
    const { contexts } = await this.bidi.send('browsingContext.getTree', { maxDepth: 0 });
    for (const c of contexts) this.urls.set(c.context, c.url);
    return contexts;
  }

  async install(zip) {
    const { extension } = await this.bidi.send('webExtension.install', {
      extensionData: { type: 'archivePath', path: zip },
    });
    check(extension === ADDON_ID, `Installed add-on ID was ${extension}, expected ${ADDON_ID}`);
  }

  // The settings tab the background opens on its own after a fresh install.
  async waitForSettingsTab(what = 'the settings tab to open by itself') {
    const ctx = await until(what, async () => (await this.tree()).find((c) => isOptionsUrl(c.url)), { timeout: 15000 });
    return this.#adopt(ctx.context, ctx.url);
  }

  // A settings tab opened by hand, the way a person would from about:addons.
  async openSettingsTab(url) {
    const { context } = await this.bidi.send('browsingContext.create', { type: 'tab' });
    await this.bidi.send('browsingContext.navigate', { context, url, wait: 'complete' });
    return this.#adopt(context, url);
  }

  async #adopt(context, url) {
    const page = new Page(this.bidi, context, url);
    this.pages.push(page);
    await page.waitLoaded();
    const info = await page.run(() => ({
      settings: !!document.querySelector('footer.credits'),
      visible: document.visibilityState === 'visible',
      size: `${innerWidth}x${innerHeight}`,
    }));
    check(info.settings, `${url} loaded but isn't Renard's settings page`);
    // A background tab doesn't paint or run animation frames.
    if (!info.visible) await page.activate();
    const want = `${this.viewport.width}x${this.viewport.height}`;
    check(info.size === want, `The settings tab's viewport is ${info.size}, expected ${want}`);
    return page;
  }

  async stop() {
    if (this.ff) await stopFirefox(this.ff, this.bidi);
  }
}

// ---- tour steps shared by the scenarios ------------------------------------------------------

function describe(s) {
  if (!s.found) return '#tour missing';
  return `step ${s.step} of ${s.steps}, ${s.shown ? 'shown' : 'not shown'}${s.hiddenAttr ? ', hidden attribute' : ''}${s.typing ? ', typing' : ''}${s.pinned ? ', pinned' : ''}, text "${s.text.slice(0, 60)}"`;
}

// The tour should be on the page and showing at step 0 by itself.
async function expectTourShown(page) {
  const found = await until('#tour to appear on the settings page', () => page.tour().then((s) => s.found && s), {
    timeout: 3000,
  }).catch(() => null);
  check(found, 'tour not found: the settings page has no #tour element');
  const s = await until('the tour to show', () => page.tour().then((s) => s.shown && s), { timeout: 5000 }).catch(
    async () => {
      throw new Failure(`The tour didn't show on a fresh install (${describe(await page.tour())})`);
    },
  );
  check(s.step === 0, `The tour opened at step ${s.step}, expected 0`);
  check(Number.isInteger(s.steps) && s.steps >= 2, `#tour data-steps is ${s.steps}, expected a count of 2 or more`);
  return s;
}

// Waits for the current step's line to be fully typed out, then for any
// scroll the step started to stop, so a screenshot shows what a person sees.
async function lineReady(page, step, timeout = 8000) {
  const s = await until(
    `step ${step}'s line to finish typing`,
    () => page.tour().then((s) => s.shown && s.step === step && !s.typing && s.text && s),
    { timeout, interval: 50 },
  ).catch(async (err) => {
    throw new Failure(`${err.message} (${describe(await page.tour())})`);
  });
  await settleScroll(page);
  return page.tour();
}

// Waits until the page stops scrolling: the same scrollY on three reads
// 100 ms apart, or 3 s at most.
async function settleScroll(page) {
  let last = await page.run(() => scrollY);
  let still = 0;
  const end = Date.now() + 3000;
  while (still < 3 && Date.now() < end) {
    await sleep(100);
    const y = await page.run(() => scrollY);
    still = y === last ? still + 1 : 0;
    last = y;
  }
}

// Space advances one step. A Space during typing only finishes the line, so
// keep pressing until the step changes, then make sure it moved by exactly
// one and stays there (a focused button would also click on the key's release).
async function spaceToNext(page, from) {
  let s;
  let presses = 0;
  do {
    await page.press(SPACE);
    presses++;
    await sleep(150);
    s = await page.tour();
  } while (s.step === from && presses < 5);
  check(s.step !== from, `Space didn't advance past step ${from} after ${presses} presses (${describe(s)})`);
  check(s.step === from + 1, `Space went from step ${from} to step ${s.step}, expected ${from + 1}`);
  await sleep(300);
  const later = await page.tour();
  check(later.step === from + 1, `After Space the tour moved on again to step ${later.step}, expected to stay on ${from + 1}`);
  return presses;
}

async function expectTourHidden(page, what) {
  await until(`the tour to hide ${what}`, () => page.tour().then((s) => s.found && s.hiddenAttr && !s.shown), {
    timeout: 1500,
    interval: 50,
  }).catch(async () => {
    throw new Failure(`The tour is still showing ${what} (${describe(await page.tour())})`);
  });
}

// For a page that has just loaded: hidden now, and still hidden a second
// later, in case the tour waits on storage before deciding to show.
async function expectTourStaysHidden(page, what) {
  const first = await page.tour();
  check(first.found, 'tour not found: the settings page has no #tour element');
  check(first.hiddenAttr && !first.shown, `The tour is showing ${what} (${describe(first)})`);
  await sleep(1000);
  const later = await page.tour();
  check(later.hiddenAttr && !later.shown, `The tour showed up a moment ${what} (${describe(later)})`);
}

async function expectTourDone(page, what) {
  const done = await page.tourDone();
  check(done === true, `storage.local tourDone is ${JSON.stringify(done)} ${what}, expected true`);
}

const px = (n) => Math.round(n * 10) / 10;

// Where things sit once a step has settled. The card must be fully on
// screen and the page must not scroll sideways. On a pinned step, the
// section it points at must start below the card (the arrow goes in the
// gap), with at least its heading on screen. Each problem has a kind, so the
// resize scenario can note sideways overflow (G's job) without failing on it.
function layoutProblems(s, step) {
  const { card, viewport: vp } = s;
  const out = [];
  const add = (kind, message) => out.push({ kind, message });
  if (!(card.height > 0 && card.top >= 0 && card.bottom <= vp.height)) {
    add('card', `On step ${step} the tour card isn't fully in view: it spans ${px(card.top)}..${px(card.bottom)} px in a ${vp.height} px tall viewport`);
  }
  if (!(card.left >= 0 && card.right <= vp.width)) {
    add('card', `On step ${step} the tour card spills out sideways: it spans ${px(card.left)}..${px(card.right)} px in a ${vp.width} px wide viewport`);
  }
  if (s.scrollWidth > vp.width) add('sideways', `On step ${step} the page scrolls sideways: scrollWidth ${s.scrollWidth} > clientWidth ${vp.width}`);
  if (s.spills.length) {
    add(
      'sideways',
      `On step ${step} content sticks out of the tour card sideways (card ${px(card.left)}..${px(card.right)} px, viewport ${vp.width} px wide): ` +
        s.spills
          .slice(0, 4)
          .map((e) => `${e.name}${e.text ? ` "${e.text}"` : ''} spans ${px(e.left)}..${px(e.right)}, ${px(e.over)} px out`)
          .join('; '),
    );
  }
  if (!s.pinned) return out;
  const target = s.target;
  if (!target) {
    add('target', `Step ${step} is pinned but no section is marked .tour-target`);
    return out;
  }
  const name = target.heading ? `#${target.heading}'s section` : 'the target section';
  if (target.top < card.bottom) {
    add('target', `On step ${step} ${name} starts at ${px(target.top)} px, above the pinned card's bottom at ${px(card.bottom)} px (scrollY ${s.scrollY})`);
  }
  const h = target.headingBox;
  if (!h) add('heading', `On step ${step} ${name} has no heading`);
  else if (!(h.top >= card.bottom && h.bottom <= vp.height)) {
    add('heading', `On step ${step} the heading #${target.heading} isn't visible: it spans ${px(h.top)}..${px(h.bottom)} px, card bottom ${px(card.bottom)}, viewport ${vp.height} px tall`);
  }
  return out;
}

// Fails on any layout problem. Returns the gap above the target, for the log.
function checkLayout(s, step) {
  const problems = layoutProblems(s, step);
  check(!problems.length, problems.map((p) => p.message).join('; '));
  return s.pinned ? s.target.top - s.card.bottom : null;
}

// Walks the whole tour with Space and finishes it with a click on Done.
// shotEvery decides which steps get a screenshot.
async function walkTour(t, page, { shotEvery = () => true, readyTimeout = 8000, checkSpaceWhileTyping = false } = {}) {
  const first = await expectTourShown(page);
  const steps = first.steps;
  t.note(`tour shown with ${steps} steps`);

  if (checkSpaceWhileTyping) {
    // The line has started appearing but isn't finished: one Space should
    // finish it and stay on step 0.
    const typing = await until('step 0 to start typing', () => page.tour().then((s) => s.typing && s.text && s), {
      timeout: 3000,
      interval: 30,
    }).catch(() => null);
    if (typing) {
      await page.press(SPACE);
      await sleep(150);
      const s = await page.tour();
      check(s.step === 0, `Space while step 0 was still typing moved to step ${s.step}; it should only finish the line`);
      check(!s.typing, `Space while step 0 was still typing didn't finish the line (${describe(s)})`);
      t.note('Space during typing finished the line and stayed on step 0');
    } else {
      t.note('step 0 was never caught mid-line, so the Space-during-typing check was skipped');
    }
  }

  for (let step = 0; step < steps; step++) {
    const s = await lineReady(page, step, readyTimeout);
    if (step === 0) {
      check(/Oh, hi/.test(s.text), `Step 0 says "${s.text}", expected it to contain "Oh, hi"`);
      check(!s.back?.shown, 'Back is showing on step 0');
    }
    if (step === 1) check(s.back?.shown, 'Back is missing on step 1');
    const gap = checkLayout(s, step);
    const wrong = stateProblems(s);
    check(!wrong.length, `On step ${step}: ${wrong.join('; ')}`);
    check(s.next?.shown, `Next is missing on step ${step}`);
    const last = step === steps - 1;
    check(
      /done/i.test(s.next.text) === last,
      `Next reads "${s.next.text}" on step ${step} of ${steps}; "Done" belongs on the last step only`,
    );
    if (shotEvery(step, steps)) await t.shot(page, `step-${step}`);
    if (!last) {
      const presses = await spaceToNext(page, step);
      const how = presses > 1 ? ` after ${presses} presses` : '';
      t.note(`step ${step}${gap == null ? '' : ` (pinned, ${px(gap)} px gap)`} -> ${step + 1}${how}`);
    }
  }

  await page.click('tour-next');
  await expectTourHidden(page, 'after Done');
  await expectTourDone(page, 'after Done');
  t.note('Done hid the tour and saved tourDone');
  await t.shot(page, 'after-done');
}

async function freshInstall(t, zip) {
  await t.install(zip);
  const page = await t.waitForSettingsTab();
  t.note(`settings opened by itself at ${page.url}`);
  return page;
}

async function expectMedia(page, query) {
  check(await page.run((q) => matchMedia(q).matches, query), `The page doesn't match ${query}; the pref didn't take`);
}

// ---- stress checks ------------------------------------------------------------------------

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

// Points from a to b in n even steps, b included and a not.
const between = (a, b, n) =>
  Array.from({ length: n }, (_, i) => ({
    x: Math.round(a.x + ((b.x - a.x) * (i + 1)) / n),
    y: Math.round(a.y + ((b.y - a.y) * (i + 1)) / n),
  }));

// The page is in one of two consistent states. Off: the frame hidden, no
// trace of the tour left on the page, the header fox back. On: a valid step,
// the section STEP_TARGETS gives for it marked and pinned to (and nothing
// marked when it gives none), the header fox out, the card on screen.
// Returns what's wrong.
function stateProblems(s) {
  if (!s.found) return ['#tour is missing'];
  const p = [];
  if (s.tourCount !== 1) p.push(`there are ${s.tourCount} #tour elements`);
  if (s.hiddenAttr) {
    if (s.shown) p.push('#tour has the hidden attribute but its card still renders');
    if (s.targets.length) p.push(`sections still marked .tour-target: ${s.targets.join(', ')}`);
    if (s.focus) p.push('.page still has data-tour-focus');
    if (s.touring) p.push('.page still has data-touring');
    if (s.pinned) p.push('#tour still has data-pinned');
    if (s.hero !== true) p.push(s.hero === null ? 'there is no .hero-fox' : 'the header fox (.hero-fox) is hidden');
    return p;
  }
  if (!s.shown) p.push("#tour has no hidden attribute, but its card isn't rendered");
  if (!(Number.isInteger(s.step) && Number.isInteger(s.steps) && s.step >= 0 && s.step < s.steps)) {
    p.push(`data-step is ${s.step} with data-steps ${s.steps}`);
  } else if (s.steps !== STEP_TARGETS.length) {
    p.push(`the tour has ${s.steps} steps but STEP_TARGETS lists ${STEP_TARGETS.length}; update it from tour.js`);
  } else {
    const want = STEP_TARGETS[s.step];
    const marked = s.targets.join(', ') || 'nothing';
    if (want ? s.targets.length !== 1 || s.targets[0] !== want : s.targets.length) {
      p.push(`step ${s.step} should point at ${want ? `#${want}'s section` : 'no section'}, but .tour-target is on ${marked}`);
    }
    if (s.pinned !== Boolean(want)) p.push(`step ${s.step} ${want ? 'points at a section, but #tour has no data-pinned' : "points at no section, but #tour has data-pinned"}`);
    if (s.focus !== Boolean(want)) p.push(`step ${s.step} ${want ? 'points at a section, but .page has no data-tour-focus' : 'points at no section, but .page has data-tour-focus'}`);
  }
  if (!s.touring) p.push('.page has no data-touring while the tour shows');
  if (s.hero) p.push('the header fox (.hero-fox) shows while the tour runs');
  const { card, viewport: vp } = s;
  if (!(card.height > 0 && card.top >= 0 && card.bottom <= vp.height && card.left >= 0 && card.right <= vp.width)) {
    p.push(`the card isn't inside the ${vp.width}x${vp.height} viewport: x ${px(card.left)}..${px(card.right)}, y ${px(card.top)}..${px(card.bottom)}`);
  }
  return p;
}

// Run after each stress action. Waits a second for it to settle, then
// checks for JS errors, for settings that changed since `snap`, and for a
// page that isn't in one consistent state. expect: 'on' or 'off' when the
// action decides which.
async function invariants(t, page, snap, label, { expect } = {}) {
  await sleep(1000);
  const problems = [];
  if (t.errors.length) problems.push(`JS errors: ${t.errors.join(' | ')}`);
  const now = await page.settings();
  for (const k of SETTINGS_KEYS) if (now[k] !== snap[k]) problems.push(`setting ${k} changed from ${snap[k]} to ${now[k]}`);
  const s = await page.tour();
  problems.push(...stateProblems(s));
  if (expect === 'off' && !s.hiddenAttr) problems.push(`the tour should be off but shows step ${s.step}`);
  if (expect === 'on' && s.hiddenAttr) problems.push('the tour should be showing but is off');
  await t.shot(page, slug(label));
  check(!problems.length, `After ${label}: ${problems.join('; ')}`);
  t.note(`after ${label}: ${s.hiddenAttr ? 'tour off' : `tour on at step ${s.step}`}, invariants hold`);
  return s;
}

// Steps forward with Space to `step`, and waits for its line.
async function walkTo(page, step) {
  let s = await page.tour();
  check(s.step <= step, `Expected to walk forward to step ${step}, but the tour is already on step ${s.step}`);
  while (s.step < step) {
    await lineReady(page, s.step);
    await spaceToNext(page, s.step);
    s = await page.tour();
  }
  return lineReady(page, step);
}

// Ends the tour the ordinary way after a stress action: Space through the
// rest of the steps, then on Done, checking each step on the way. A burst can
// leave focus on Back, where Space goes back a step, so focus goes to Next
// first, as a person would put it there.
async function finishWithSpace(t, page) {
  let s = await page.tour();
  if (s.hiddenAttr) {
    t.note('the tour is already off');
    return;
  }
  if (s.active !== 'button#tour-next' && s.active !== 'body') {
    t.note(`focus was on ${s.active}; moving it to Next before pressing Space`);
    await page.run(() => (document.getElementById('tour-next').focus({ preventScroll: true }), true));
  }
  for (;;) {
    s = await lineReady(page, s.step);
    checkLayout(s, s.step);
    const wrong = stateProblems(s);
    check(!wrong.length, `While finishing with Space, on step ${s.step}: ${wrong.join('; ')}`);
    if (s.step === s.steps - 1) break;
    await spaceToNext(page, s.step);
    s = await page.tour();
  }
  await page.press(SPACE);
  await expectTourHidden(page, 'after Space on Done');
  await expectTourDone(page, 'after finishing with Space');
}

// After a resize: the page has the new size, the tour is still on `step`,
// and once the line and the scroll settle, the card, the section it points
// at and that section's heading are on screen. Sideways overflow is only
// noted, since G checks it. With fatal false, every problem is a note.
async function resized(t, page, size, step, { fatal = true } = {}) {
  const name = `${size.width}x${size.height}`;
  const inner = await page.run(() => `${innerWidth}x${innerHeight}`);
  check(inner === name, `After resizing to ${name} the page is ${inner}`);
  const s = await lineReady(page, step);
  await t.shot(page, `step-${step}-${name}`);
  const problems = layoutProblems(s, step);
  for (const p of problems.filter((p) => p.kind === 'sideways')) t.note(`note at ${name}: ${p.message}`);
  const hard = problems.filter((p) => p.kind !== 'sideways');
  const where = s.pinned && s.target ? `card bottom ${px(s.card.bottom)}, section top ${px(s.target.top)}` : 'not pinned';
  if (!fatal && hard.length) {
    for (const p of hard) t.note(`note at ${name} (not counted as a failure): ${p.message}`);
    return;
  }
  check(!hard.length, `At ${name}: ${hard.map((p) => p.message).join('; ')}`);
  t.note(`${name} on step ${step}: ${where}`);
}

// ---- scenarios ------------------------------------------------------------------------------

const SCENARIOS = [
  {
    key: 'A',
    label: 'fresh install walk-through',
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await expectMedia(page, '(prefers-color-scheme: light)');
      await walkTour(t, page, { checkSpaceWhileTyping: true });
      await page.reload();
      await expectTourStaysHidden(page, 'after a reload');
      await t.shot(page, 'after-reload');
      const second = await t.openSettingsTab(page.url);
      await expectTourStaysHidden(second, 'in a second settings tab');
      await t.shot(second, 'second-tab');
      t.note('still hidden after a reload and in a second tab');
    },
  },
  {
    key: 'B',
    label: 'skip',
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await expectTourShown(page);
      await t.shot(page, 'step-0');
      await page.click('tour-skip');
      await expectTourHidden(page, 'after Skip tour');
      await expectTourDone(page, 'after Skip tour');
      await t.shot(page, 'after-skip');
      await page.reload();
      await expectTourStaysHidden(page, 'after a reload');
      await t.shot(page, 'after-reload');
      t.note('Skip hid the tour, saved tourDone, and it stayed hidden after a reload');
    },
  },
  {
    key: 'C',
    label: 'update',
    async run(t, build) {
      if (build.sameAsOld) t.note('the build under test is the old zip, so this reinstalls it over itself');
      await t.install(build.oldZip);
      const old = await t.waitForSettingsTab('the old build to open settings on install');
      const url = old.url.replace(/[?#].*$/, '');
      t.note(`the old build opened ${url}; closing it`);
      await t.bidi.send('browsingContext.close', { context: old.context });

      const since = Date.now();
      await t.install(build.zip);
      // Watch both the tab list and navigation events for 3 s, so even a
      // settings tab that opens and closes quickly is caught.
      const end = since + 3000;
      while (Date.now() < end) {
        const open = (await t.tree()).filter((c) => isOptionsUrl(c.url));
        check(!open.length, `Settings opened by itself after the update (${open[0]?.url})`);
        await sleep(200);
      }
      const opened = t.navigations.find((n) => n.at >= since && isOptionsUrl(n.url));
      check(!opened, `Settings opened by itself after the update (${opened?.url})`);
      t.note('no settings tab within 3 s of the update');

      const page = await t.openSettingsTab(url);
      await expectTourStaysHidden(page, 'after an update');
      await expectTourDone(page, 'after an update');
      await t.shot(page, 'settings-after-update');
      t.note('tour hidden and tourDone saved after the update');
    },
  },
  {
    key: 'D',
    label: 'replay',
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await expectTourShown(page);
      await page.click('tour-skip');
      await expectTourHidden(page, 'after Skip tour');
      await expectTourDone(page, 'after Skip tour');
      // For 400 ms after the tour ends, clicks anywhere but the frame's
      // Next, Back and Skip are swallowed, so a quick second click on Skip
      // can't land on what was under it. Replay is elsewhere on the page.
      await sleep(500);
      await page.click('tour-replay');
      const s = await until('the tour to show again after Take the tour again', () =>
        page.tour().then((s) => s.shown && s),
      ).catch(async () => {
        throw new Failure(`Take the tour again didn't show the tour (${describe(await page.tour())})`);
      });
      check(s.step === 0, `Take the tour again opened at step ${s.step}, expected 0`);
      await expectTourDone(page, 'after Take the tour again');
      await lineReady(page, 0);
      await t.shot(page, 'replay-step-0');
      await page.press(ESCAPE);
      await expectTourHidden(page, 'after Escape');
      await expectTourDone(page, 'after Escape');
      await t.shot(page, 'after-escape');
      t.note('replay showed step 0 without clearing tourDone, and Escape hid it');
    },
  },
  {
    key: 'E',
    label: 'reduced motion',
    prefs: { 'ui.prefersReducedMotion': 1 },
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await expectMedia(page, '(prefers-reduced-motion: reduce)');
      // No run-in and no typing, so each line should be there almost at once.
      await walkTour(t, page, {
        readyTimeout: 1500,
        shotEvery: (step, steps) => step === 0 || step === steps - 1,
      });
      await page.reload();
      await expectTourStaysHidden(page, 'after a reload');
    },
  },
  {
    key: 'F',
    label: 'dark mode',
    prefs: { 'layout.css.prefers-color-scheme.content-override': 0 },
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await expectMedia(page, '(prefers-color-scheme: dark)');
      const { steps } = await expectTourShown(page);
      await lineReady(page, 0);
      await t.shot(page, 'step-0');
      const mid = Math.floor(steps / 2);
      for (let step = 0; step < mid; step++) {
        await lineReady(page, step);
        await spaceToNext(page, step);
      }
      await lineReady(page, mid);
      await t.shot(page, `step-${mid}`);
    },
  },
  {
    key: 'G',
    label: 'phone width',
    viewport: PHONE,
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await walkTour(t, page);
    },
  },
  {
    key: 'H',
    label: 'short window',
    viewport: { width: 1280, height: 640 },
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await walkTour(t, page);
    },
  },
  {
    key: 'I',
    label: 'spam Next',
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await expectTourShown(page);
      await lineReady(page, 0);
      const snap = await page.settings();
      // Aimed once. The frame moves on pinned steps, and the clicks keep
      // landing on the same spot.
      const at = await page.aim('tour-next');
      await page.spamAt(at, 30, 50);
      await invariants(t, page, snap, `30 clicks at Next's spot (${at.x}, ${at.y})`);
      await finishWithSpace(t, page);
      await invariants(t, page, snap, 'finishing with Space', { expect: 'off' });
    },
  },
  {
    key: 'J',
    label: 'spam Skip and Done',
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await expectTourShown(page);
      await lineReady(page, 0);
      const snap = await page.settings();
      await page.spamAt(await page.aim('tour-skip'), 20, 40);
      await invariants(t, page, snap, '20 clicks at Skip', { expect: 'off' });
      await expectTourDone(page, 'after the clicks on Skip');
      // Done on the last step, in a replay, since the first run is over.
      await page.click('tour-replay');
      const { steps } = await until('the replay to show', () => page.tour().then((s) => s.shown && s));
      await walkTo(page, steps - 1);
      await page.spamAt(await page.aim('tour-next'), 20, 40);
      await invariants(t, page, snap, '20 clicks at Done', { expect: 'off' });
      await expectTourDone(page, 'after the clicks on Done');
      await page.reload();
      await expectTourStaysHidden(page, 'after a reload');
      await invariants(t, page, snap, 'a reload', { expect: 'off' });
    },
  },
  {
    key: 'K',
    label: 'mixed spam',
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await expectTourShown(page);
      await lineReady(page, 0);
      const snap = await page.settings();

      let landed = 0;
      for (let i = 0; i < 20; i++) {
        if (await page.tryClick(i % 2 ? 'tour-back' : 'tour-next')) landed++;
        await sleep(30);
      }
      t.note(`${landed} of 20 Next/Back clicks could be aimed; the rest found their button hidden or covered`);
      await invariants(t, page, snap, '20 clicks alternating Next and Back');

      // A fixed mix, so a failure can be run again the same way.
      const mix = [SPACE, ARROW_RIGHT, ARROW_LEFT];
      const keys = Array.from({ length: 40 }, (_, i) => mix[(i * 7 + (i >> 2)) % 3]);
      t.note(`focus before the key presses: ${(await page.tour()).active}`);
      await page.keys(keys, 20);
      await invariants(t, page, snap, '40 presses of Space, ArrowRight and ArrowLeft');

      let replays = 0;
      for (let i = 0; i < 10; i++) {
        await page.press(ESCAPE);
        await sleep(100);
        if (await page.tryClick('tour-replay')) replays++;
        await sleep(100);
      }
      t.note(`${replays} of 10 replay clicks could be aimed`);
      await invariants(t, page, snap, '10 Escape presses mixed with replay clicks');

      await finishWithSpace(t, page);
      await invariants(t, page, snap, 'finishing with Space', { expect: 'off' });
    },
  },
  {
    key: 'L',
    label: 'resize mid-tour',
    async run(t, build) {
      const MID = { width: 900, height: 600 };
      const SHORT = { width: 1280, height: 480 };
      await t.install(build.zip);
      const page = await t.waitForSettingsTab();
      const snap = await page.settings();

      // While the fox is still running in.
      await t.resize(PHONE);
      await sleep(600);
      await expectTourShown(page);
      await resized(t, page, PHONE, 0);
      await t.resize(VIEWPORT);
      await sleep(600);
      await resized(t, page, VIEWPORT, 0);
      await invariants(t, page, snap, 'resizing during the run-in', { expect: 'on' });

      // Halfway through the move from step 1 to step 2, the first pinned step.
      await walkTo(page, 1);
      await page.press(SPACE);
      await sleep(50);
      await t.resize(MID);
      await sleep(600);
      await resized(t, page, MID, 2);
      await t.resize(VIEWPORT);
      await sleep(600);
      await resized(t, page, VIEWPORT, 2);

      // 1280x480 may be too short for the card and a heading, so problems
      // there are noted with their numbers rather than failed.
      for (const step of [3, 5]) {
        await walkTo(page, step);
        for (const size of [PHONE, MID, SHORT, VIEWPORT]) {
          await t.resize(size);
          await sleep(600);
          await resized(t, page, size, step, { fatal: size !== SHORT });
        }
      }
      await invariants(t, page, snap, 'resizing on steps 3 and 5', { expect: 'on' });
      await finishWithSpace(t, page);
      await invariants(t, page, snap, 'finishing with Space', { expect: 'off' });
    },
  },
  {
    key: 'M',
    label: 'drag',
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await expectTourShown(page);
      await lineReady(page, 0);
      const snap = await page.settings();
      const p = await page.run(dragPoints);
      check(p.provider, 'There is no unchosen provider button to release over');

      // Down on the fox, across the bubble, up on Next.
      await page.drag([p.fox, ...between(p.fox, p.say, 5), ...between(p.say, p.next, 5)]);
      await sleep(300);
      let s = await page.tour();
      check(s.step === 0, `A drag from the fox that ended on Next moved the tour to step ${s.step}`);
      await invariants(t, page, snap, 'a drag from the fox to Next', { expect: 'on' });

      // Down on Next, out over the page, up on a provider button.
      await page.drag([p.next, ...between(p.next, p.provider, 10)]);
      await sleep(300);
      s = await page.tour();
      check(s.step === 0, `A drag from Next that ended on ${p.provider.name} moved the tour to step ${s.step}`);
      await invariants(t, page, snap, `a drag from Next to ${p.provider.name}`, { expect: 'on' });

      await finishWithSpace(t, page);
      await invariants(t, page, snap, 'finishing with Space', { expect: 'off' });
    },
  },
  {
    key: 'N',
    label: 'replay spam',
    async run(t, build) {
      const page = await freshInstall(t, build.zip);
      await expectTourShown(page);
      const { text: firstLine } = await lineReady(page, 0);
      const snap = await page.settings();
      await finishWithSpace(t, page);
      await invariants(t, page, snap, 'finishing the tour', { expect: 'off' });

      await page.spamAt(await page.aim('tour-replay'), 10, 40);
      const s = await lineReady(page, 0);
      check(s.text === firstLine, `After 10 replay clicks step 0 says "${s.text}", expected "${firstLine}"`);
      await invariants(t, page, snap, '10 clicks on Take the tour again', { expect: 'on' });
      const later = await page.tour();
      check(later.step === 0, `The replay moved on to step ${later.step} by itself`);

      // Escape, then Take the tour again while the frame is still leaving.
      const at = await page.aim('tour-replay');
      await page.press(ESCAPE);
      await sleep(100);
      await page.spamAt(at, 1, 0);
      const clicked = Date.now();
      let sawOff = false;
      let back = null;
      while (Date.now() - clicked < 2000) {
        const st = await page.tour();
        if (st.hiddenAttr) sawOff = true;
        else if (sawOff && st.shown && back == null) back = Date.now() - clicked;
        await sleep(50);
      }
      const end = await page.tour();
      check(end.shown && end.step === 0, `A replay clicked 100 ms after Escape didn't bring the tour back within 2 s (${describe(end)})`);
      t.note(
        sawOff
          ? `the frame hid, and the new tour showed ${back} ms after the click`
          : 'the frame was never seen hidden between the two tours (read every 50 ms)',
      );
      await invariants(t, page, snap, 'Escape, then replay during the exit', { expect: 'on' });
      await finishWithSpace(t, page);
      await invariants(t, page, snap, 'finishing with Space', { expect: 'off' });
    },
  },
  {
    key: 'O',
    label: 'two tabs',
    async run(t, build) {
      await t.install(build.zip);
      const first = await t.waitForSettingsTab();
      const second = await t.openSettingsTab(first.url);
      await expectTourShown(second);
      const s1 = await first.tour();
      check(s1.shown, `The first tab's tour isn't showing once the second tab opened (${describe(s1)})`);
      t.note('both tabs show the tour');
      await t.shot(second, 'second-tab');
      const snap = await first.settings();

      await first.activate();
      await finishWithSpace(t, first);
      const since = Date.now();
      // The second tab is in the background, as it would be for a person.
      const gone = await until('the second tab to end its tour', () => second.tour().then((s) => s.hiddenAttr && !s.shown && s), {
        timeout: 2000,
        interval: 50,
      }).catch(() => null);
      const took = Date.now() - since;
      const behind = gone ? null : await second.tour();
      await second.activate();
      if (!gone) {
        await sleep(1000);
        throw new Failure(
          `The second tab still shows its tour 2 s after the first tab finished, in the background (${describe(behind)}); ` +
            `1 s after bringing it to the front: ${describe(await second.tour())}`,
        );
      }
      t.note(`the second tab's tour ended ${took} ms after the first finished`);
      await invariants(t, second, snap, 'the first tab finishing, seen in the second', { expect: 'off' });
      await first.activate();
      await invariants(t, first, snap, 'finishing in the first tab', { expect: 'off' });
    },
  },
];

// ---- runner ------------------------------------------------------------------------------

async function runScenario(def, build) {
  const t = new Session(def.key, def.label, def.prefs || {}, def.viewport || VIEWPORT);
  const started = Date.now();
  console.log(`\n${def.key}  ${def.label}`);
  let failure = null;
  try {
    await t.start();
    await def.run(t, build);
    // Give late errors from the last action a moment to arrive.
    await sleep(300);
  } catch (err) {
    failure = err;
  }
  if (failure && t.pages.length) {
    await t.shot(t.pages.at(-1), 'failure').catch(() => {});
  }
  if (!failure && t.errors.length) failure = new Failure(`${t.errors.length} JS error(s) from the extension`);
  for (const line of t.errors) console.log(`     error: ${line}`);
  await t.stop().catch((err) => console.log(`     cleanup: ${err.message}`));
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (failure) {
    // A harness or BiDi error keeps its stack, minus Node's own frames.
    const message =
      failure instanceof Failure
        ? failure.message
        : (failure.stack || String(failure))
            .split('\n')
            .filter((l) => !/\(node:|node:internal/.test(l))
            .join('\n');
    console.log(`FAIL ${def.key}  ${def.label} (${secs} s): ${message}`);
    if (!(failure instanceof Failure) && t.ff) console.log(t.ff.log.slice(-15).map((l) => `     ff: ${l}`).join('\n'));
  } else {
    console.log(`PASS ${def.key}  ${def.label} (${secs} s, ${t.shots} screenshots)`);
  }
  return { def, failure, version: t.browserVersion };
}

// Firefox reads a temporary add-on's files out of its zip for as long as it
// stays installed, so a rebuild during a run would break the pages already
// open. The run installs copies taken at the start, which also keeps every
// scenario on the same build.
async function snapshotBuilds(zip, { withOld }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'renard-e2e-builds-'));
  tempDirs.add(dir);
  const build = {
    dir,
    zip: path.join(dir, `new-${path.basename(zip)}`),
    oldZip: path.join(dir, `old-${path.basename(OLD_ZIP)}`),
    sameAsOld: zip === OLD_ZIP,
  };
  await copyFile(zip, build.zip);
  if (withOld) await copyFile(OLD_ZIP, build.oldZip);
  return build;
}

async function main() {
  const zip = path.resolve(positionals[0] || (await newestZip()));
  const only = flags.only ? new Set(flags.only.toUpperCase().split(/[\s,]+/)) : null;
  let scenarios = SCENARIOS.filter((s) => !only || only.has(s.key));
  const haveOld = await stat(OLD_ZIP).then(
    () => true,
    () => false,
  );
  if (!haveOld && scenarios.some((s) => s.key === 'C')) {
    console.log(`Skipping C (update): ${path.relative(ROOT, OLD_ZIP)} isn't there. Pass --old with a zip of a version before 0.1.4.`);
    scenarios = scenarios.filter((s) => s.key !== 'C');
  }
  const built = (await stat(zip)).mtime.toLocaleString();
  console.log(`Build:       ${path.relative(ROOT, zip) || zip} (modified ${built})`);
  console.log(`Firefox:     ${FIREFOX_BIN}`);
  console.log(`Screenshots: ${OUT}`);

  const build = await snapshotBuilds(zip, { withOld: scenarios.some((s) => s.key === 'C') });
  const results = [];
  for (const def of scenarios) results.push(await runScenario(def, build));
  await rm(build.dir, { recursive: true, force: true });
  tempDirs.delete(build.dir);

  const failed = results.filter((r) => r.failure);
  const version = results.find((r) => r.version)?.version;
  console.log(`\n${results.length - failed.length} of ${results.length} scenarios passed${version ? ` on ${version}` : ''}.`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err);
  await Promise.all([...running].map((ff) => stopFirefox(ff)));
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  process.exitCode = 1;
});
