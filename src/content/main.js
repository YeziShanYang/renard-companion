// Content-script entry: decides whether Renard belongs on this page and keeps
// it in sync with settings changes from the background script.
(function () {
  const R = globalThis.Renard;
  if (R.booted) return;
  R.booted = true;

  let site = R.siteForHost(location.hostname);
  // Local fixture pages used in development (?renard-site=claude).
  if (!site && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    site = R.SITES[new URLSearchParams(location.search).get('renard-site')] || null;
  }
  // Anywhere else, this script runs only because the user added the site
  // (registered from settings, or injected from the toolbar popup).
  if (!site && location.protocol === 'https:' && R.isWebHost(location.hostname)) {
    site = R.webSite(location.hostname);
  }
  if (!site || window.top !== window) return;
  // Renard's element needs an HTML page: an SVG or XML file opened on its
  // own has no place for it. (Chrome shows plain XML in an HTML viewer whose
  // new elements still aren't HTML, so that's checked too.)
  if (!(document.documentElement instanceof HTMLHtmlElement) || !(document.createElement('div') instanceof HTMLElement)) return;
  // A page sandboxed by its security policy (raw files on some code hosts)
  // has an opaque origin, and the bubble's frame would inherit the sandbox
  // and stay empty.
  if (self.origin === 'null') return;

  let app = null;
  let assets = null;
  let running = null;
  let again = false;
  let retired = false;

  // One Renard per page. Reloading or updating the extension starts a new
  // copy of this script while an older copy's fox is still on the page:
  // Firefox injects the new copy into open tabs and leaves the old DOM
  // behind, and Chrome keeps orphaned scripts running. Ask older copies to
  // step aside (their listeners run synchronously), then remove anything
  // they left. This copy listens only after asking, so it never retires
  // itself.
  const REPLACE_EVENT = 'renard-companion:replace';
  document.dispatchEvent(new Event(REPLACE_EVENT));
  for (const el of document.querySelectorAll(R.HOST_SELECTOR)) el.remove();
  const onReplace = () => {
    // Only a copy whose extension context is gone steps aside, so the page
    // itself can't dispatch this event to switch a live Renard off.
    if (R.contextAlive()) return;
    retired = true;
    if (app) {
      app.unmount();
      app = null;
    }
  };
  // A page restored from the back/forward cache missed the refreshes sent
  // while it was away (settings changed, a model downloaded, Renard sent
  // home), so it asks for the current state.
  const onPageShow = (e) => {
    if (e.isTrusted && e.persisted && R.contextAlive()) sync().catch(() => {});
  };
  // A page that rewrites itself (document.open) erases these, so they're
  // added again when Renard mounts afresh. Adding one twice does nothing.
  const listen = () => {
    document.addEventListener(REPLACE_EVENT, onReplace);
    addEventListener('pageshow', onPageShow);
  };
  listen();

  // The page rewrote itself or replaced its <html>: the fox lost its
  // listeners or its observers, so a new one is mounted in its place, at
  // most five times in ten seconds. A page that keeps rewriting itself gets
  // its next fox once the ten seconds are up.
  let remounts = [];
  let remountTimer = 0;
  R.remount = function () {
    if (retired) return;
    clearTimeout(remountTimer);
    const now = performance.now();
    remounts = remounts.filter((t) => now - t < 10000);
    if (remounts.length >= 5) {
      remountTimer = setTimeout(R.remount, 10000 - (now - remounts[0]) + 50);
      return;
    }
    remounts.push(now);
    if (app) {
      app.unmount();
      app = null;
    }
    // The page's fonts may have gone with the old document.
    R.fontsLoaded = false;
    listen();
    sync().catch(() => {});
  };

  // Brings the page in line with settings: mount, update, or remove Renard.
  async function syncOnce() {
    if (retired) return;
    const state = await R.send('renard:getState', { site: site.id, mount: !app });
    if (retired) return;
    if (!state.enabled) {
      // Unspawned or site turned off. A respawn that arrives during the
      // goodbye run waits for it (sync is serialized), then mounts afresh.
      if (app) {
        const leaving = app;
        app = null;
        await leaving.leave();
      }
      return;
    }
    if (app) {
      app.applyState(state);
      return;
    }
    assets = assets || (await R.send('renard:getAssets'));
    const next = new R.App(site, state, assets);
    await next.mount();
    if (retired) next.unmount();
    else app = next;
  }

  // Runs one sync at a time. A request that arrives mid-sync (a settings
  // change right at page load, say) queues one more pass instead of starting
  // a second, parallel mount.
  function sync() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await syncOnce();
          } catch (err) {
            // A pass queued meanwhile still runs; otherwise report it.
            if (!again) throw err;
          }
        } while (again && !retired);
      } finally {
        running = null;
      }
    })();
    return running;
  }
  R.sync = sync;

  R.ext.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'renard:refresh') sync().catch(() => {});
    else if (msg.type === 'renard:command' && app) app.command(msg.command);
  });

  sync().catch((err) => console.warn('[Renard]', err));
})();
