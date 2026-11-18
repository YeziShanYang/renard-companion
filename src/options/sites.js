// The Sites section: claude.ai and ChatGPT, Every website, and the
// websites added (or turned off) from the toolbar menu.
import '../shared/constants.js';
import { ext, hasOrigins } from '../shared/settings.js';
import { $, settings, saveEntry, send, switchControl, accessButton } from './page.js';

const R = globalThis.Renard;

// Several changes can arrive at once (adding a site fires a permission event
// and a storage change), and each render awaits permission checks. Build the
// rows first and let only the latest render replace the list, so rows are
// never added twice.
let sitesRender = 0;

export async function renderSites() {
  const token = ++sitesRender;
  const rows = [];
  for (const site of Object.values(R.SITES)) {
    const enabled = settings.sites[site.id] !== false;
    const li = document.createElement('li');
    li.className = 'row';
    const text = document.createElement('div');
    text.className = 'row-text';
    const title = Object.assign(document.createElement('span'), { className: 'row-title', id: `site-${site.id}-label`, textContent: site.name });
    const hosts = Object.assign(document.createElement('span'), { className: 'hint', textContent: site.hosts.join(', ') });
    text.append(title, hosts);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    // The switch is on only while Renard can actually run there: the site is
    // on in Renard and the browser has granted access to it. Firefox can
    // leave that access out or let the user take it away.
    const granted = await hasOrigins(site.origins);
    if (enabled && !granted) {
      text.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: "The browser hasn't let Renard into this site. Allow access to bring the fox here." }));
      actions.append(
        accessButton(site.origins, () => {
          renderSites();
        }),
      );
    }
    const { label, input } = switchControl(`site-${site.id}`, enabled && granted, title.id);
    // Turning a site on asks for access in the same click: Firefox shows its
    // prompt only for a request made directly from user input. Declining
    // leaves the site off.
    input.addEventListener('click', () => {
      if (!input.checked) {
        saveEntry('sites', site.id, false).then(renderSites, renderSites);
        return;
      }
      ext.permissions
        .request({ origins: site.origins })
        .then(
          (ok) => saveEntry('sites', site.id, ok),
          () => saveEntry('sites', site.id, false),
        )
        .then(renderSites, renderSites);
    });
    actions.append(label);
    li.append(text, actions);
    rows.push(li);
  }
  rows.push(await allSitesRow());
  // Websites turned off from the toolbar popup while every website is on
  // (added sites that were turned off are listed with the added sites).
  if (settings.allSites) {
    for (const host of settings.skippedSites.filter((h) => !settings.otherSites.includes(h))) {
      const li = document.createElement('li');
      li.className = 'row';
      const text = document.createElement('div');
      text.className = 'row-text';
      const hint = Object.assign(document.createElement('span'), { className: 'hint', textContent: 'Turned off from the toolbar menu' });
      text.append(Object.assign(document.createElement('span'), { className: 'row-title', textContent: host }), hint);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.append(turnOnButton(host, hint));
      li.append(text, actions);
      rows.push(li);
    }
  }
  // Websites added from the toolbar popup.
  for (const host of settings.otherSites) {
    const li = document.createElement('li');
    li.className = 'row';
    const text = document.createElement('div');
    text.className = 'row-text';
    const skipped = settings.skippedSites.includes(host);
    const hint = Object.assign(document.createElement('span'), {
      className: 'hint',
      textContent: skipped ? 'Added, then turned off from the toolbar menu' : 'Added from the toolbar menu',
    });
    text.append(Object.assign(document.createElement('span'), { className: 'row-title', textContent: host }), hint);
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Remove' });
    remove.setAttribute('aria-label', `Remove ${host}`);
    remove.addEventListener('click', async () => {
      // The background script owns the list, so removals and additions
      // from the popup can't overwrite each other.
      remove.disabled = true;
      try {
        await send('renard:removeSite', { host });
      } catch {
        remove.disabled = false;
        hint.textContent = "Couldn't remove it. Try again.";
      }
    });
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (skipped) actions.append(turnOnButton(host, hint));
    actions.append(remove);
    li.append(text, actions);
    rows.push(li);
  }
  if (token !== sitesRender) return;
  // Rebuilding replaces the switches; keyboard focus stays on the same one.
  const focusId = document.activeElement && document.activeElement.id;
  $('sites').replaceChildren(...rows);
  if (focusId && $(focusId) && document.activeElement !== $(focusId)) $(focusId).focus({ preventScroll: true });
}

// Turns Renard back on for a site that was turned off from the toolbar
// popup. hint shows a failure.
function turnOnButton(host, hint) {
  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Turn on' });
  btn.setAttribute('aria-label', `Turn Renard on for ${host}`);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await send('renard:skipSite', { host, skip: false });
    } catch {
      btn.disabled = false;
      hint.textContent = "Couldn't turn it on. Try again.";
    }
  });
  return btn;
}

// The Every website switch. It's on only while the browser has granted
// access to all secure websites, too. Turning it on asks for that access in
// the same click, and turning it off gives the access back.
async function allSitesRow() {
  const li = document.createElement('li');
  li.className = 'row';
  const text = document.createElement('div');
  text.className = 'row-text';
  const title = Object.assign(document.createElement('span'), { className: 'row-title', id: 'site-all-label', textContent: 'Every website' });
  const hint = Object.assign(document.createElement('span'), {
    className: 'hint',
    textContent: 'Every secure (https) website, not only the ones you add. A site you turn off from the toolbar menu stays off.',
  });
  text.append(title, hint);
  const granted = await hasOrigins([R.ALL_WEB]);
  const { label, input } = switchControl('site-all', settings.allSites && granted, title.id);
  input.addEventListener('click', () => {
    const on = input.checked;
    const asked = on ? ext.permissions.request({ origins: [R.ALL_WEB] }) : Promise.resolve(true);
    asked
      .then(
        (ok) => (ok ? send('renard:setAllSites', { on }) : null),
        () => null,
      )
      .then(renderSites, renderSites);
  });
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.append(label);
  li.append(text, actions);
  return li;
}
