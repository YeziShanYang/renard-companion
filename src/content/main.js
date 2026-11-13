// Content-script entry: decides whether Renard belongs on this page and keeps
// it in sync with settings changes from the background script.
(function () {
  const R = globalThis.Renard;
  if (R.booted) return;
  R.booted = true;

  let site = R.siteForHost(location.hostname);
  // Local fixture pages used in development (?renard-site=claude). The
  // published manifest only injects on claude.ai and ChatGPT, so this branch
  // never runs there.
  if (!site && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    site = R.SITES[new URLSearchParams(location.search).get('renard-site')] || null;
  }
  if (!site || window.top !== window) return;

  let app = null;
  let assets = null;
  let mounting = null;
  let again = false;

  async function sync() {
    if (mounting) {
      again = true;
      return mounting;
    }
    const state = await R.send('renard:getState', { site: site.id });
    if (!state.enabled) {
      if (app) {
        app.unmount();
        app = null;
      }
      return undefined;
    }
    if (app) {
      app.applyState(state);
      return undefined;
    }
    mounting = (async () => {
      assets = assets || (await R.send('renard:getAssets'));
      const next = new R.App(site, state, assets);
      await next.mount();
      app = next;
    })().finally(() => {
      mounting = null;
      if (again) {
        again = false;
        sync().catch(() => {});
      }
    });
    return mounting;
  }
  R.sync = sync;

  R.ext.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'renard:refresh') sync().catch(() => {});
    else if (msg.type === 'renard:command' && app) app.command(msg.command);
  });

  sync().catch((err) => console.warn('[Renard]', err));
})();
