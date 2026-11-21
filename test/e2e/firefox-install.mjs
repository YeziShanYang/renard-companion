// Runs the tour scenarios in tour-suite.mjs in a real Firefox, driven over
// WebDriver BiDi. Each scenario starts a headless Firefox on a new temporary
// profile and installs the zip as a temporary add-on.
//
//   node test/e2e/firefox-install.mjs [path-to-firefox-zip] [--old zip] [--out dir] [--only A,C]
//
// FIREFOX_BIN overrides the Firefox binary. See tour-suite.mjs for the rest.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Failure, TourPage, TourSession, check, runSuite, until } from './tour-suite.mjs';

const FIREFOX_BIN = process.env.FIREFOX_BIN || '/Applications/Firefox.app/Contents/MacOS/firefox';
const ADDON_ID = 'renard-companion@YeziShanYang';

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
  // Prints console calls from pages (extension pages included) on stdout, so
  // console.error shows up next to the "JavaScript error:" lines.
  'devtools.console.stdout.content': true,
};

// The media features a scenario asks for, as Firefox prefs. Headless Firefox
// follows the system's dark mode, so light is set unless dark is asked for,
// which keeps screenshots the same on every machine.
function mediaPrefs(media) {
  return {
    'layout.css.prefers-color-scheme.content-override': media['prefers-color-scheme'] === 'dark' ? 0 : 1,
    ...(media['prefers-reduced-motion'] === 'reduce' ? { 'ui.prefersReducedMotion': 1 } : {}),
  };
}

// ---- Firefox ------------------------------------------------------------------

// Every Firefox still running, so Ctrl-C or a crash still cleans up.
const running = new Set();

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

// ---- the page and the session ----------------------------------------------------------

class FirefoxPage extends TourPage {
  constructor(bidi, context, url) {
    super(url);
    this.bidi = bidi;
    this.context = context;
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

  // BiDi's browsingContext.activate refuses extension tabs, so the page asks
  // the tabs API to select its own tab instead.
  async activate() {
    await this.run(async () => {
      const tab = await browser.tabs.getCurrent();
      await browser.tabs.update(tab.id, { active: true });
      return true;
    });
    await until('the tab to become visible', () => this.run(() => document.visibilityState === 'visible'));
  }

  async reload() {
    await this.bidi.send('browsingContext.reload', { context: this.context, wait: 'complete' });
    await this.waitLoaded();
  }

  // One performActions call per burst keeps the timing in Firefox's hands.
  async pointer(actions) {
    await this.bidi.send('input.performActions', {
      context: this.context,
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: actions.map((a) =>
            a.type === 'pointerMove' ? { ...a, origin: 'viewport' } : a.type === 'pause' ? a : { ...a, button: 0 },
          ),
        },
      ],
    });
  }

  async keys(values, every) {
    const actions = [];
    for (const value of values) {
      actions.push({ type: 'keyDown', value }, { type: 'keyUp', value });
      if (every) actions.push({ type: 'pause', duration: every });
    }
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

class FirefoxSession extends TourSession {
  urls = new Map(); // context id -> last known URL

  async start() {
    this.ff = await launchFirefox(mediaPrefs(this.media));
    this.ff.onLine = (line) => this.#output(line);
    this.bidi = await Bidi.connect(this.ff.wsUrl);
    const { capabilities } = await this.bidi.send('session.new', { capabilities: {} });
    this.browserVersion = `${capabilities.browserName} ${capabilities.browserVersion}`;
    this.bidi.on((method, params) => this.#event(method, params));
    await this.bidi.send('session.subscribe', {
      events: ['log.entryAdded', 'browsingContext.contextCreated', 'browsingContext.navigationStarted', 'browsingContext.load'],
    });
    await this.resize(this.viewport);
  }

  async stop() {
    if (this.ff) await stopFirefox(this.ff, this.bidi);
  }

  logTail() {
    return this.ff ? this.ff.log.slice(-15) : [];
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

  // Resizes every tab: set for the whole default user context, which also
  // covers tabs opened later, since BiDi won't resize one extension tab alone.
  async resize(viewport) {
    await this.bidi.send('browsingContext.setViewport', { userContexts: ['default'], viewport });
  }

  async tabs() {
    const { contexts } = await this.bidi.send('browsingContext.getTree', { maxDepth: 0 });
    for (const c of contexts) this.urls.set(c.context, c.url);
    return contexts.map((c) => ({ id: c.context, url: c.url }));
  }

  async install(zip) {
    const { extension } = await this.bidi.send('webExtension.install', {
      extensionData: { type: 'archivePath', path: zip },
    });
    check(extension === ADDON_ID, `Installed add-on ID was ${extension}, expected ${ADDON_ID}`);
  }

  // Installing a newer zip with the same ID over a temporary add-on is an
  // update, with onInstalled's reason "update".
  update(zip) {
    return this.install(zip);
  }

  pageFor(tab) {
    return new FirefoxPage(this.bidi, tab.id, tab.url);
  }

  async openTab(url) {
    const { context } = await this.bidi.send('browsingContext.create', { type: 'tab' });
    await this.bidi.send('browsingContext.navigate', { context, url, wait: 'complete' });
    const page = new FirefoxPage(this.bidi, context, url);
    this.pages.push(page);
    return page;
  }

  async closeTab(page) {
    await this.bidi.send('browsingContext.close', { context: page.context });
  }
}

runSuite({
  name: 'firefox',
  title: 'Firefox',
  binary: FIREFOX_BIN,
  Session: FirefoxSession,
  cleanup: () => Promise.all([...running].map((ff) => stopFirefox(ff))),
});
