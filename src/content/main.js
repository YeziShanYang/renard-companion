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
  for (const el of document.querySelectorAll('renard-companion')) el.remove();
  document.addEventListener(REPLACE_EVENT, () => {
    retired = true;
    if (app) {
      app.unmount();
      app = null;
    }
  });

  async function sync() {
    if (retired) return undefined;
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
      if (retired && app) {
        app.unmount();
        app = null;
        return;
      }
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
