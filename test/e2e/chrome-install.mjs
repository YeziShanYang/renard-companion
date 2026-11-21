// Runs the tour scenarios in tour-suite.mjs in a real Chrome, driven over the
// DevTools protocol (CDP) on a pipe. Each scenario starts a headless Chrome on
// a new temporary profile, unpacks the zip into a folder and loads it with
// Extensions.loadUnpacked, since branded Chrome ignores --load-extension.
//
//   node test/e2e/chrome-install.mjs [path-to-chrome-zip] [--old zip] [--out dir] [--only A,C]
//
// CHROME_BIN overrides the Chrome binary. See tour-suite.mjs for the rest.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ARROW_LEFT, ARROW_RIGHT, ESCAPE, Failure, SPACE, TourPage, TourSession, check, runSuite, unzip, until } from './tour-suite.mjs';

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// A quiet, throwaway profile: no first-run or default-browser prompts, no
// sync, no component or background downloads, and no keychain prompt on
// macOS. --remote-debugging-pipe with --enable-unsafe-extension-debugging is
// what lets CDP load an unpacked extension.
const FLAGS = [
  '--headless=new',
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-search-engine-choice-screen',
  '--disable-features=Translate,OptimizationHints,MediaRouter',
  '--metrics-recording-only',
  '--password-store=basic',
  '--use-mock-keychain',
];

// WebDriver key values, as the scenarios use them, to CDP key events.
const CDP_KEYS = {
  [SPACE]: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  [ESCAPE]: { key: 'Escape', code: 'Escape', keyCode: 27 },
  [ARROW_LEFT]: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  [ARROW_RIGHT]: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};

// ---- Chrome -----------------------------------------------------------------------------

// Every Chrome still running, so Ctrl-C or a crash still cleans up.
const running = new Set();

// CDP over the pipe: Chrome reads commands on fd 3 and writes replies and
// events on fd 4, each message JSON ending in a NUL byte. With flatten,
// commands for an attached target carry its sessionId.
class Cdp {
  #out;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();

  constructor(child) {
    this.#out = child.stdio[3];
    const input = child.stdio[4];
    input.setEncoding('utf8');
    let buffer = '';
    input.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        this.#receive(msg);
      }
    });
    input.on('close', () => {
      for (const waiter of this.#pending.values()) waiter.reject(new Error(`${waiter.method}: Chrome closed the pipe`));
      this.#pending.clear();
    });
    // Chrome going away mid-write shouldn't crash the run.
    this.#out.on('error', () => {});
  }

  #receive(msg) {
    if (msg.id == null) {
      for (const fn of this.#listeners) fn(msg.method, msg.params, msg.sessionId);
      return;
    }
    const waiter = this.#pending.get(msg.id);
    if (!waiter) return;
    this.#pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
    else waiter.resolve(msg.result);
  }

  send(method, params = {}, sessionId, timeout = 30000) {
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
      this.#out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  on(fn) {
    this.#listeners.add(fn);
  }
}

async function launchChrome() {
  const root = await mkdtemp(path.join(tmpdir(), 'renard-e2e-chrome-'));
  const profile = path.join(root, 'profile');
  await mkdir(profile);
  // Our own --user-data-dir is a separate Chrome from any already open.
  const child = spawn(CHROME_BIN, [...FLAGS, `--user-data-dir=${profile}`, 'about:blank'], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  const chrome = { child, root, log: [], exited: false };
  running.add(chrome);
  child.on('exit', () => {
    chrome.exited = true;
  });
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) if (line.trim()) chrome.log.push(line);
      if (chrome.log.length > 200) chrome.log.splice(0, chrome.log.length - 200);
    });
  }
  chrome.cdp = new Cdp(child);
  try {
    chrome.version = await chrome.cdp.send('Browser.getVersion', {}, undefined, 30000);
  } catch (err) {
    await stopChrome(chrome);
    throw new Failure(`Chrome didn't answer on the pipe (${err.message}):\n${chrome.log.slice(-20).join('\n')}`);
  }
  return chrome;
}

async function stopChrome(chrome) {
  if (!chrome.exited) {
    const gone = new Promise((resolve) => chrome.child.once('exit', resolve));
    await chrome.cdp.send('Browser.close', {}, undefined, 3000).catch(() => {});
    const term = setTimeout(() => chrome.child.kill('SIGTERM'), 3000);
    const kill = setTimeout(() => chrome.child.kill('SIGKILL'), 6000);
    await gone;
    clearTimeout(term);
    clearTimeout(kill);
  }
  await rm(chrome.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  running.delete(chrome);
}

const remoteText = (o) => (o.type === 'string' ? o.value : (o.description ?? (o.value !== undefined ? JSON.stringify(o.value) : o.type)));

function exceptionText(details) {
  const where = details.url ? ` at ${details.url}:${details.lineNumber + 1}` : '';
  return `${details.exception?.description?.split('\n')[0] || details.text}${where}`;
}

// ---- the page and the session -------------------------------------------------------------

class ChromePage extends TourPage {
  constructor(session, target, url) {
    super(url);
    this.session = session;
    this.targetId = target.targetId;
    this.sessionId = target.sessionId;
    this.mouse = { x: 0, y: 0, pressed: false };
  }

  send(method, params, timeout) {
    return this.session.cdp.send(method, params, this.sessionId, timeout);
  }

  // Runs fn in the page's main world, where the extension's chrome API is.
  async run(fn, ...args) {
    const expression = `(async (...args) => JSON.stringify(await (${fn})(...args)))(...${JSON.stringify(args)})`;
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`Page script threw: ${exceptionText(res.exceptionDetails)}`);
    return typeof res.result.value === 'string' ? JSON.parse(res.result.value) : undefined;
  }

  async activate() {
    await this.session.cdp.send('Target.activateTarget', { targetId: this.targetId });
    await until('the tab to become visible', () => this.run(() => document.visibilityState === 'visible'));
  }

  // The marker is gone once the new document has replaced the old one.
  async reload() {
    await this.run(() => ((window.__e2eBeforeReload = true), true));
    await this.send('Page.reload');
    await until('the page to reload', () => this.run(() => !window.__e2eBeforeReload && document.readyState === 'complete'), {
      timeout: 15000,
    });
  }

  // WebDriver pointer actions as CDP mouse events, timed here in Node.
  async pointer(actions) {
    const m = this.mouse;
    const dispatch = (type, extra) => this.send('Input.dispatchMouseEvent', { type, x: m.x, y: m.y, ...extra });
    for (const a of actions) {
      if (a.type === 'pause') {
        await sleep(a.duration);
      } else if (a.type === 'pointerMove') {
        if (a.duration) await sleep(a.duration);
        m.x = a.x;
        m.y = a.y;
        await dispatch('mouseMoved', m.pressed ? { button: 'left', buttons: 1 } : { button: 'none', buttons: 0 });
      } else if (a.type === 'pointerDown') {
        m.pressed = true;
        await dispatch('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
      } else if (a.type === 'pointerUp') {
        m.pressed = false;
        await dispatch('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
      }
    }
  }

  // A key with text (Space) goes down as keyDown, which also types it, and
  // the others as rawKeyDown, the way Chrome sends real keys.
  async keys(values, every) {
    for (const value of values) {
      const k = CDP_KEYS[value];
      check(k, `No CDP key for ${JSON.stringify(value)}`);
      const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode };
      await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      if (every) await sleep(every);
    }
  }

  async screenshot(file) {
    await this.run(
      () =>
        new Promise((r) => {
          requestAnimationFrame(() => requestAnimationFrame(() => r(true)));
          setTimeout(() => r(true), 1000);
        }),
    );
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(data, 'base64'));
  }
}

class ChromeSession extends TourSession {
  targets = new Map(); // targetId -> { targetId, sessionId, type, url, ready }
  bySession = new Map(); // sessionId -> the same
  // The extension's service worker, once seen. P checks that it was.
  backgroundTarget = null;
  // A new profile also runs Chrome's own component extensions, each with a
  // service worker. Errors are held until loadUnpacked says which ID is ours.
  extId = null;
  early = []; // { url, line } from before the ID was known
  // Each time the extension's service worker starts. During an update, a
  // listener is added to the new worker before its first line runs, to record
  // what onInstalled reports.
  workerStarts = 0;
  watchInstall = false;
  paused = new Set(); // workers with the before-script breakpoint set
  installHeard = false;

  async start() {
    this.chrome = await launchChrome();
    this.cdp = this.chrome.cdp;
    this.browserVersion = this.chrome.version.product.replace(/^(Headless)?Chrome\//, 'chrome ');
    this.extDir = path.join(this.chrome.root, 'renard');
    this.cdp.on((method, params, sessionId) => this.#event(method, params, sessionId));
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    // Every new page and worker waits for us before it runs, so emulation
    // and error listeners are in place before its first script.
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  async stop() {
    if (this.chrome) await stopChrome(this.chrome);
  }

  logTail() {
    return this.chrome ? this.chrome.log.slice(-15) : [];
  }

  #event(method, params, sessionId) {
    switch (method) {
      case 'Target.attachedToTarget':
        this.#attached(params);
        break;
      case 'Target.detachedFromTarget': {
        const gone = this.bySession.get(params.sessionId);
        this.bySession.delete(params.sessionId);
        if (gone) this.targets.delete(gone.targetId);
        break;
      }
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const { targetId, type, url } = params.targetInfo;
        const known = this.targets.get(targetId);
        if (known) known.url = url;
        if (type === 'page' && url) this.navigations.push({ url, at: Date.now() });
        break;
      }
      case 'Target.targetDestroyed':
        this.targets.delete(params.targetId);
        break;
      case 'Debugger.paused':
        if (this.paused.has(sessionId)) this.#listenForInstall(sessionId).catch(() => {});
        break;
      case 'Runtime.exceptionThrown':
        this.#error(sessionId, `uncaught: ${exceptionText(params.exceptionDetails)}`);
        break;
      case 'Runtime.consoleAPICalled':
        if (params.type === 'error') this.#error(sessionId, `console.error: ${params.args.map(remoteText).join(' ')}`);
        break;
      case 'Log.entryAdded':
        if (params.entry.level === 'error') this.#error(sessionId, `${params.entry.source}: ${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}`);
        break;
    }
  }

  // The breakpoint stops before every script the worker runs, its modules
  // included, so only the first stop adds the listener. Whatever goes wrong,
  // the worker must not stay paused.
  async #listenForInstall(sessionId) {
    const send = (method, params) => this.cdp.send(method, params, sessionId).catch(() => {});
    if (!this.installHeard) {
      this.installHeard = true;
      await send('Runtime.evaluate', { expression: 'chrome.runtime.onInstalled.addListener((d) => { globalThis.__e2eInstalled = d; })' });
      await send('Debugger.removeInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' });
    }
    await send('Debugger.resume');
  }

  #ours(url) {
    return Boolean(this.extId) && url.startsWith(`chrome-extension://${this.extId}/`);
  }

  // Errors count when they come from one of the extension's pages or its
  // service worker.
  #error(sessionId, text) {
    const target = this.bySession.get(sessionId);
    if (!target?.url.startsWith('chrome-extension://')) return;
    const where = target.type === 'service_worker' ? 'service worker' : new URL(target.url).pathname.slice(1);
    const line = `[${where}] ${text}`;
    if (!this.extId) this.early.push({ url: target.url, line });
    else if (this.#ours(target.url)) this.errors.push(line);
  }

  #noteWorker(target) {
    if (target.type === 'service_worker' && this.#ours(target.url)) {
      this.backgroundTarget = `the service worker (${new URL(target.url).pathname.slice(1)})`;
      this.workerStarts++;
    }
  }

  #attached({ sessionId, targetInfo, waitingForDebugger }) {
    const { targetId, type, url } = targetInfo;
    const target = { targetId, sessionId, type, url };
    const send = (method, params) => this.cdp.send(method, params, sessionId);
    target.ready = (async () => {
      try {
        if (type === 'page') {
          await send('Page.enable');
          await this.#emulate(sessionId);
        }
        if (type === 'page' || type === 'service_worker') {
          await send('Runtime.enable');
          await send('Log.enable');
        }
        // The extension API isn't there yet while the worker waits to start,
        // so the listener goes in at a pause just before its first script.
        if (type === 'service_worker' && this.watchInstall && this.#ours(url)) {
          this.watchInstall = false;
          this.paused.add(sessionId);
          await send('Debugger.enable');
          await send('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' });
        }
      } finally {
        if (waitingForDebugger) await send('Runtime.runIfWaitingForDebugger').catch(() => {});
      }
    })().catch(() => {});
    this.targets.set(targetId, target);
    this.bySession.set(sessionId, target);
    this.#noteWorker(target);
  }

  // Per-tab emulation: the viewport, and light mode unless the scenario asks
  // for dark, so screenshots don't depend on the machine's appearance.
  async #emulate(sessionId) {
    const send = (method, params) => this.cdp.send(method, params, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { ...this.viewport, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: this.media['prefers-color-scheme'] || 'light' },
        { name: 'prefers-reduced-motion', value: this.media['prefers-reduced-motion'] || 'no-preference' },
      ],
    });
  }

  async resize(viewport) {
    this.viewport = viewport;
    for (const target of this.targets.values()) {
      if (target.type === 'page') await this.cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, target.sessionId);
    }
  }

  async tabs() {
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page').map((t) => ({ id: t.targetId, url: t.url }));
  }

  async #attachedTarget(targetId) {
    const target = await until('Chrome to attach to the tab', () => this.targets.get(targetId), { timeout: 10000 });
    await target.ready;
    return target;
  }

  async pageFor(tab) {
    return new ChromePage(this, await this.#attachedTarget(tab.id), tab.url);
  }

  async openTab(url) {
    const { targetId } = await this.cdp.send('Target.createTarget', { url });
    const page = new ChromePage(this, await this.#attachedTarget(targetId), url);
    this.pages.push(page);
    return page;
  }

  async closeTab(page) {
    await this.cdp.send('Target.closeTarget', { targetId: page.targetId });
  }

  async install(zip) {
    await rm(this.extDir, { recursive: true, force: true });
    await unzip(zip, this.extDir);
    const { id } = await this.cdp.send('Extensions.loadUnpacked', { path: this.extDir });
    this.extId = id;
    for (const { url, line } of this.early.splice(0)) if (this.#ours(url)) this.errors.push(line);
    for (const target of this.targets.values()) this.#noteWorker(target);
  }

  // An unpacked extension's ID comes from its folder's path, so the new
  // build goes into the same folder and is loaded again from there. Chrome
  // treats that as an update of the loaded extension. (chrome.runtime.reload()
  // would be the usual way, but on an extension loaded over CDP it unloads it
  // for good.)
  async update(zip) {
    const starts = this.workerStarts;
    await rm(this.extDir, { recursive: true, force: true });
    await unzip(zip, this.extDir);
    this.watchInstall = true;
    const { id } = await this.cdp.send('Extensions.loadUnpacked', { path: this.extDir });
    check(id === this.extId, `Loading the new build gave ID ${id}, not the installed ${this.extId}`);
    await until('the service worker to start again after the update', () => this.workerStarts > starts, { timeout: 15000 });
  }

  // What onInstalled reported to the worker that started with the update.
  async installDetails() {
    const worker = [...this.targets.values()].findLast((t) => t.type === 'service_worker' && this.#ours(t.url));
    check(worker, "The service worker is gone, so onInstalled can't be read");
    const read = async () => {
      const res = await this.cdp.send('Runtime.evaluate', { expression: 'globalThis.__e2eInstalled', returnByValue: true }, worker.sessionId);
      return res.result.value;
    };
    return until('onInstalled to fire after the update', read, { timeout: 5000 });
  }
}

runSuite({
  name: 'chrome',
  title: 'Chrome',
  binary: CHROME_BIN,
  Session: ChromeSession,
  cleanup: () => Promise.all([...running].map((chrome) => stopChrome(chrome))),
});
