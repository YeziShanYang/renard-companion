import '../shared/constants.js';
import { ext, loadSettings, saveSettings, hasOrigins } from '../shared/settings.js';
import { listModels, ProviderError } from '../shared/providers.js';

const R = globalThis.Renard;
const $ = (id) => document.getElementById(id);

const KEY_HINTS = {
  anthropic: { text: 'Create a key in the Claude Console', url: 'https://platform.claude.com/settings/keys' },
  openai: { text: 'Create a key on the OpenAI platform', url: 'https://platform.openai.com/api-keys' },
  gemini: { text: 'Create a key in Google AI Studio', url: 'https://aistudio.google.com/apikey' },
};

let settings = null;
let models = [];
let checkController = null;
let keyTimer = 0;
let savedTimer = 0;

function flashSaved() {
  const el = $('saved');
  el.textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    el.textContent = '';
  }, 1400);
}

async function save(partial) {
  Object.assign(settings, partial);
  await saveSettings(partial);
  flashSaved();
}

// Sets one entry of a nested setting (sites, prefs, apiKeys, models,
// localModel). The background applies it on top of the stored value, in the
// same queue as its own writes, so two quick toggles here, or a change made
// elsewhere (another settings tab, the popup, a bubble), never cancel out.
async function saveEntry(key, entry, value) {
  settings[key] = { ...settings[key], [entry]: value };
  await send('renard:setEntry', { key, entry, value });
  flashSaved();
}

// JSON with sorted keys, so stored objects compare equal whatever order a
// browser returns their keys in.
function stable(value) {
  return JSON.stringify(value, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
}

// Characters a copied key can pick up: spaces, line breaks, and invisible
// formatting characters such as zero-width spaces.
const KEY_JUNK = /[\s\p{Cf}]+/gu;
let refusedKey = null;

async function send(type, payload) {
  const res = await ext.runtime.sendMessage({ type, ...payload });
  if (!res || !res.ok) throw new Error((res && res.error) || 'No response from Renard');
  return res.result;
}

function setStatus(state, text) {
  const el = $('key-status');
  el.dataset.state = state || '';
  el.textContent = text || '';
}

// ---- provider, key, model ---------------------------------------------------

function renderProvider() {
  for (const radio of document.querySelectorAll('input[name="provider"]')) {
    radio.checked = radio.value === settings.provider;
  }
  const isLocal = settings.provider === 'local';
  $('key-field').hidden = isLocal;
  $('model-field').hidden = isLocal;
  $('local-field').hidden = !isLocal;
  if (isLocal) {
    renderLocal();
    return;
  }
  const provider = R.PROVIDERS[settings.provider];
  $('key-label').textContent = `${provider.name} API key`;
  $('key').value = settings.apiKeys[settings.provider] || '';
  // Each provider's key starts hidden, even if the last one was shown.
  $('key').type = 'password';
  $('key-toggle').textContent = 'Show';
  $('key-toggle').setAttribute('aria-pressed', 'false');
  const hint = KEY_HINTS[settings.provider];
  const link = Object.assign(document.createElement('a'), { href: hint.url, target: '_blank', rel: 'noopener noreferrer', textContent: hint.text });
  $('key-hint').replaceChildren('Stored only in this browser. ', link, '.');
}

function renderModels() {
  const select = $('model');
  select.replaceChildren();
  if (!models.length) {
    // While a check runs, or offline, the saved model still shows.
    const saved = settings.models[settings.provider];
    select.append(new Option(saved && typeof saved.name === 'string' ? saved.name : 'Connect a key to load models'));
    select.disabled = true;
    return;
  }
  const current = settings.models[settings.provider];
  for (const m of models) {
    const label = m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id;
    select.append(new Option(label, m.id, false, Boolean(current && current.id === m.id)));
  }
  select.disabled = false;
}

function describeError(err, providerName) {
  const kind = err instanceof ProviderError ? err.kind : 'unknown';
  if (kind === 'keyInvalid') return "That key didn't work.";
  if (kind === 'network') return `Couldn't reach ${providerName}. Check your connection.`;
  if (kind === 'rateLimited') return `${providerName} is rate limiting requests. Try again soon.`;
  return `That key didn't work (${err.message}).`;
}

// Fetching the model list doubles as the key check.
async function checkKey() {
  if (checkController) checkController.abort();
  // Registered before any await, so a second check always cancels this one.
  const controller = new AbortController();
  checkController = controller;
  if (settings.provider === 'local') return;
  const provider = R.PROVIDERS[settings.provider];
  const key = settings.apiKeys[provider.id];
  models = [];
  renderModels();
  // A refused paste stays explained until the field is edited.
  if (refusedKey !== null && $('key').value.replace(KEY_JUNK, '') === refusedKey) {
    setStatus('bad', "✗ That doesn't look like an API key. A key is one line of letters, numbers and dashes.");
    return;
  }
  if (!key) {
    setStatus('', 'Paste a key to connect.');
    renderModels();
    return;
  }
  if (!R.isApiKey(key)) {
    setStatus('bad', "✗ That doesn't look like an API key. A key is one line of letters, numbers and dashes.");
    renderModels();
    return;
  }
  const granted = await hasOrigins(provider.origins);
  if (controller.signal.aborted) return;
  if (!granted) {
    // The access box under the key explains it and offers the button.
    setStatus('', '');
    renderModels();
    return;
  }
  setStatus('busy', 'Checking…');
  // A stalled connection gives up after 15 seconds instead of "Checking…"
  // forever.
  const timeout = AbortSignal.timeout(15000);
  const signal = AbortSignal.any ? AbortSignal.any([controller.signal, timeout]) : controller.signal;
  try {
    const list = await listModels(provider.id, key, { signal });
    if (controller.signal.aborted) return;
    models = list;
    if (!list.length) {
      setStatus('bad', 'Connected, but no models are available for this key.');
    } else {
      setStatus('ok', '✓ Connected');
      const current = (await loadSettings(['models'])).models[provider.id];
      if (controller.signal.aborted) return;
      const match = current && list.find((m) => m.id === current.id);
      // Keep the chosen model (refreshing its limits); otherwise take the newest.
      const chosen = match || list[0];
      if (!current || stable(current) !== stable(chosen)) {
        await saveEntry('models', provider.id, chosen);
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    if (timeout.aborted) {
      setStatus('bad', `✗ Couldn't reach ${provider.name}. Check your connection.`);
    } else if (!(err instanceof ProviderError && err.kind === 'aborted')) {
      setStatus('bad', `✗ ${describeError(err, provider.name)}`);
    }
  } finally {
    if (checkController === controller) checkController = null;
  }
  renderModels();
}

function bindAi() {
  for (const radio of document.querySelectorAll('input[name="provider"]')) {
    // Ask for the provider's API access as part of choosing it. Firefox
    // grants host access only at install, so a provider added in a later
    // version starts without it. The request has to start inside the click
    // (Firefox drops the user gesture after an await); for access already
    // granted it resolves at once without a prompt. A new grant re-renders
    // the page through permissions.onAdded.
    radio.addEventListener('click', () => {
      const origins = R.PROVIDERS[radio.value].origins;
      if (origins.length) ext.permissions.request({ origins }).catch(() => {});
    });
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      await flushKey();
      await save({ provider: radio.value });
      renderProvider();
      renderAccess();
      checkKey();
    });
  }

  $('key').addEventListener('input', () => {
    clearTimeout(keyTimer);
    // Remember which provider the key was typed for, in case the provider
    // changes before the save.
    pendingKey = { provider: settings.provider, value: $('key').value.trim() };
    refusedKey = null;
    keyTimer = setTimeout(flushKey, 500);
  });
  // Leaving the field, or the page, saves a key still waiting for its timer.
  $('key').addEventListener('change', () => flushKey());
  addEventListener('pagehide', () => {
    if (!pendingKey || pendingKey.provider === 'local') return;
    const value = pendingKey.value.replace(KEY_JUNK, '');
    if (value && !R.isApiKey(value)) return;
    // One direct write: there may be no time for a round trip.
    saveSettings({ apiKeys: { ...settings.apiKeys, [pendingKey.provider]: value } });
  });

  $('key-toggle').addEventListener('click', () => {
    const input = $('key');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('key-toggle').textContent = show ? 'Hide' : 'Show';
    $('key-toggle').setAttribute('aria-pressed', String(show));
  });

  $('model').addEventListener('change', () => {
    const chosen = models.find((m) => m.id === $('model').value);
    if (chosen) saveEntry('models', settings.provider, chosen);
  });
}

let pendingKey = null;

async function flushKey() {
  clearTimeout(keyTimer);
  const pending = pendingKey;
  pendingKey = null;
  if (!pending || !R.PROVIDERS[pending.provider] || pending.provider === 'local') return;
  // Pasted keys often bring a newline or spaces along; anything else that
  // can't be in a key isn't saved, so a stray paste can't replace a good key.
  const value = pending.value.replace(KEY_JUNK, '');
  if (value && !R.isApiKey(value)) {
    refusedKey = value;
    if (settings.provider === pending.provider) {
      setStatus('bad', "✗ That doesn't look like an API key. A key is one line of letters, numbers and dashes.");
    }
    return;
  }
  await saveEntry('apiKeys', pending.provider, value);
  if (settings.provider === pending.provider) checkKey();
}

// ---- built-in model ------------------------------------------------------------

const IS_FIREFOX = typeof ext.runtime.getBrowserInfo === 'function';
let gpu = null; // { ok, f16, dtype } or { ok: false, reason }
let downloadPort = null;

function formatBytes(n) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

async function detectGpu() {
  const advice = 'Choose a cloud provider above instead.';
  if (!navigator.gpu) return { ok: false, reason: `This browser can't use WebGPU on this computer, so the built-in model can't run here. ${advice}` };
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch {
    // treated as unavailable
  }
  if (!adapter) return { ok: false, reason: `This browser can't use the graphics chip on this computer, so the built-in model can't run here. ${advice}` };
  const f16 = adapter.features.has('shader-f16');
  return { ok: true, f16, dtype: R.localDtype(IS_FIREFOX, f16) };
}

function setLocalStatus(state, text) {
  const el = $('local-status');
  el.dataset.state = state || '';
  el.textContent = text || '';
}

function renderLocal() {
  const lm = settings.localModel;
  const dtype = (gpu && gpu.dtype) || R.localDtype(IS_FIREFOX, true);
  const list = $('local-models');
  const focusId = document.activeElement && document.activeElement.id;
  list.replaceChildren(
    ...Object.values(R.LOCAL_MODELS).map((m) => {
      const ready = R.localReady(lm, m);
      const label = document.createElement('label');
      label.className = 'model-choice';
      const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'local-model', id: `local-${m.id}`, value: m.id, checked: lm.key === m.id });
      input.addEventListener('change', async () => {
        if (!input.checked) return;
        await saveEntry('localModel', 'key', m.id);
        // A download in progress keeps its status line.
        if (!downloadPort) setLocalStatus('', '');
        renderLocal();
      });
      const dot = Object.assign(document.createElement('span'), { className: 'model-dot' });
      dot.setAttribute('aria-hidden', 'true');
      const name = Object.assign(document.createElement('span'), { className: 'model-name', textContent: m.name });
      const size = Object.assign(document.createElement('span'), {
        className: ready ? 'model-state' : 'model-size',
        textContent: ready ? (Number(ready.bytes) > 0 ? `Downloaded · ${formatBytes(ready.bytes)}` : 'Downloaded') : `${formatBytes(m.sizes[dtype])} download`,
      });
      const blurb = Object.assign(document.createElement('span'), { className: 'model-blurb', textContent: m.blurb });
      label.append(input, dot, name, size, blurb);
      return label;
    }),
  );

  // Rebuilding replaces the radios; keyboard focus stays on the same one.
  if (focusId && $(focusId) && document.activeElement !== $(focusId)) $(focusId).focus({ preventScroll: true });

  const selected = R.LOCAL_MODELS[lm.key] || R.LOCAL_MODELS['gemma-3-1b'];
  const ready = R.localReady(lm, selected);
  const busy = Boolean(downloadPort);
  $('local-download').hidden = Boolean(ready);
  $('local-download').textContent = `Download ${selected.name} (${formatBytes(selected.sizes[dtype])})`;
  $('local-download').disabled = busy || (gpu && !gpu.ok);
  $('local-delete').hidden = !ready || busy;
  $('local-delete').textContent = `Delete ${selected.name}`;
  $('local-gpu').hidden = !gpu || gpu.ok;
  $('local-gpu').textContent = gpu && !gpu.ok ? gpu.reason : '';
  if (!busy && ready) setLocalStatus('ok', `✓ ${selected.name} is ready on this computer`);
  // A "downloading" or "ready" line that no longer applies goes away.
  else if (!busy && ['busy', 'ok'].includes($('local-status').dataset.state)) setLocalStatus('', '');
}

function showMeter(loaded, total) {
  $('local-meter').hidden = false;
  const pct = total ? Math.min(1, loaded / total) : 0;
  // Advance in 4% steps, like a pixel progress bar.
  $('local-meter-fill').style.width = `${Math.floor(pct * 25) * 4}%`;
  $('local-meter-text').textContent =
    pct >= 1 ? 'Downloaded. Loading the model…' : `${formatBytes(loaded)} of ${formatBytes(total)} (${Math.floor(pct * 100)}%)`;
}

function startDownload() {
  const selected = R.LOCAL_MODELS[settings.localModel.key];
  if (!selected || downloadPort) return;
  const port = ext.runtime.connect({ name: 'renard:local' });
  downloadPort = port;
  // Pings keep Firefox's background page awake for the whole download.
  const ping = setInterval(() => {
    try {
      port.postMessage({ type: 'ping' });
    } catch {
      clearInterval(ping);
    }
  }, 10000);
  const done = () => {
    clearInterval(ping);
    if (downloadPort === port) downloadPort = null;
    $('local-meter').hidden = true;
    renderLocal();
  };
  port.onMessage.addListener(async (m) => {
    if (m.type === 'progress') {
      showMeter(m.loaded, m.total);
    } else if (m.type === 'ready') {
      settings = await loadSettings();
      port.disconnect();
      done();
      // Said for the model that downloaded, even if another is now selected.
      setLocalStatus('ok', `✓ ${selected.name} is ready on this computer`);
    } else if (m.type === 'error') {
      port.disconnect();
      done();
      setLocalStatus('bad', `✗ The download didn't finish: ${m.message}`);
    }
  });
  port.onDisconnect.addListener(() => {
    if (downloadPort !== port) return;
    done();
    setLocalStatus('bad', "✗ The download stopped. Try again.");
  });
  setLocalStatus('busy', `Downloading ${selected.name}. Keep this page open until it finishes.`);
  showMeter(0, selected.sizes[(gpu && gpu.dtype) || 'q4']);
  renderLocal();
  port.postMessage({ type: 'prepare', key: selected.id });
}

async function deleteModel() {
  const selected = R.LOCAL_MODELS[settings.localModel.key];
  if (!selected) return;
  $('local-delete').disabled = true;
  setLocalStatus('busy', `Deleting ${selected.name}…`);
  let res;
  try {
    res = await ext.runtime.sendMessage({ type: 'renard:localRemove', key: selected.id });
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  } finally {
    $('local-delete').disabled = false;
  }
  if (!res || !res.ok) {
    setLocalStatus('bad', `✗ Couldn't delete it: ${(res && res.error) || 'no response'}`);
    return;
  }
  settings = await loadSettings();
  setLocalStatus('', `${selected.name} was deleted from this computer.`);
  renderLocal();
}

// A model counts as downloaded only while its files are still whole in the
// cache for this GPU. The background forgets one that isn't, and the storage
// change redraws this section.
function checkDownloads() {
  if (!gpu || !gpu.ok) return;
  for (const m of Object.values(R.LOCAL_MODELS)) {
    if (R.localReady(settings.localModel, m)) send('renard:localCheck', { key: m.id, dtype: gpu.dtype }).catch(() => {});
  }
}

function bindLocal() {
  $('local-download').addEventListener('click', startDownload);
  $('local-delete').addEventListener('click', deleteModel);
}

// ---- sites and access -------------------------------------------------------

function switchControl(id, checked, labelledBy) {
  const label = document.createElement('label');
  label.className = 'switch';
  const input = Object.assign(document.createElement('input'), { type: 'checkbox', id, checked });
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-labelledby', labelledBy);
  const track = document.createElement('span');
  track.className = 'switch-track';
  const thumb = document.createElement('span');
  thumb.className = 'switch-thumb';
  track.append(thumb);
  label.append(input, track);
  return { label, input };
}

// permissions.request() must run synchronously inside the click handler
// (Firefox drops the user gesture after an await), so origins are computed
// before the click.
function accessButton(origins, onDone, label = 'Allow access') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    ext.permissions.request({ origins }).then(onDone, onDone);
  });
  return btn;
}

// Several changes can arrive at once (adding a site fires a permission event
// and a storage change), and each render awaits permission checks. Build the
// rows first and let only the latest render replace the list, so rows are
// never added twice.
let sitesRender = 0;

async function renderSites() {
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
  // Websites added from the toolbar popup.
  for (const host of settings.otherSites) {
    const li = document.createElement('li');
    li.className = 'row';
    const text = document.createElement('div');
    text.className = 'row-text';
    const hint = Object.assign(document.createElement('span'), { className: 'hint', textContent: 'Added from the toolbar menu' });
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

async function renderAccess() {
  const provider = R.PROVIDERS[settings.provider];
  const granted = await hasOrigins(provider.origins);
  $('api-access').hidden = granted;
  if (granted) return;
  const host = new URL(provider.origins[0].replace('/*', '')).host;
  $('api-access-text').textContent = `Renard needs your permission to contact ${provider.name} at ${host}.`;
  const old = $('api-access-btn');
  const btn = accessButton(provider.origins, () => {
    renderAccess();
    checkKey();
  });
  btn.id = 'api-access-btn';
  old.replaceWith(btn);
}

// ---- screenshots ------------------------------------------------------------

// Firefox gives Renard's bubble no way to ask for permissions, so the
// bubble sends people here.
const ALL_SITES = ['<all_urls>'];

async function renderScreenshots() {
  const granted = await hasOrigins(ALL_SITES);
  $('shots-text').textContent = granted
    ? "Allowed. You can take it back in your browser's extension settings."
    : 'Not allowed yet. Pasting or dropping an image into the bubble works without it.';
  const old = $('shots-btn');
  const btn = accessButton(ALL_SITES, renderScreenshots, 'Allow screenshots');
  btn.id = 'shots-btn';
  btn.hidden = granted;
  old.replaceWith(btn);
}

// ---- display ----------------------------------------------------------------

const PREF_SWITCHES = { readable: 'readableText', sound: 'sound' };

function renderPrefs() {
  for (const [id, pref] of Object.entries(PREF_SWITCHES)) $(id).checked = Boolean(settings.prefs[pref]);
}

function bindPrefs() {
  renderPrefs();
  for (const [id, pref] of Object.entries(PREF_SWITCHES)) {
    const input = $(id);
    input.addEventListener('change', () => saveEntry('prefs', pref, input.checked));
  }
}

// ---- shortcuts --------------------------------------------------------------

async function renderShortcuts() {
  const list = $('shortcuts');
  let commands = [];
  try {
    commands = await ext.commands.getAll();
  } catch {
    // commands API unavailable
  }
  list.replaceChildren();
  for (const c of commands) {
    if (!c.description) continue;
    const li = document.createElement('li');
    li.className = 'row';
    const name = Object.assign(document.createElement('span'), { textContent: c.description });
    const key = c.shortcut ? Object.assign(document.createElement('kbd'), { textContent: c.shortcut }) : Object.assign(document.createElement('span'), { className: 'hint', textContent: 'Not set' });
    li.append(name, key);
    list.append(li);
  }
  const isFirefox = typeof ext.runtime.getBrowserInfo === 'function';
  $('shortcut-hint').textContent = isFirefox
    ? 'Change them in about:addons: open the gear menu and choose Manage Extension Shortcuts.'
    : 'Change them at chrome://extensions/shortcuts.';
}

// ---- header fox ---------------------------------------------------------------

function drawFox() {
  const canvas = $('fox');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = (sheet, fallback) => {
    const sprite = new R.Sprite(canvas, sheet, fallback);
    if (reduce) {
      sprite.hold('idle', 0);
    } else {
      sprite.play('idle');
      setInterval(() => {
        if (sprite.name === 'idle') sprite.play('look', { onEnd: () => sprite.play('idle') });
      }, 9000);
    }
    $('fox').closest('button').addEventListener('click', () => {
      if (!reduce) sprite.play('pounce', { onEnd: () => sprite.play('idle') });
    });
  };
  const img = new Image();
  img.onload = () => start(img, null);
  img.onerror = () => {
    $('sprite-missing').hidden = false;
    const icon = new Image();
    icon.onload = () => start(null, icon);
    icon.src = '../icons/icon-16.png';
  };
  img.src = '../assets/fox-sprite-sheet.png';
}

// ---- boot ----------------------------------------------------------------------

async function init() {
  settings = await loadSettings();
  // Controls work right away; the GPU check fills in the built-in section
  // when it's done, so nothing typed or clicked meanwhile is lost.
  renderProvider();
  bindAi();
  bindLocal();
  bindPrefs();
  drawFox();
  detectGpu().then((result) => {
    gpu = result;
    if (settings.provider === 'local') renderLocal();
    checkDownloads();
  });
  await Promise.all([renderSites(), renderAccess(), renderScreenshots(), renderShortcuts()]);
  checkKey();
  ext.permissions.onAdded.addListener(() => {
    renderSites();
    renderAccess();
    renderScreenshots();
    checkKey();
  });
  ext.permissions.onRemoved.addListener(() => {
    renderSites();
    renderAccess();
    renderScreenshots();
    checkKey();
  });
  addEventListener('online', () => checkKey());
  // Changes made elsewhere while this page is open: another settings tab,
  // the toolbar popup, a bubble's Read chat switch, a finished download.
  ext.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes).filter((k) => Object.prototype.hasOwnProperty.call(R.DEFAULTS, k));
    if (!keys.length) return;
    const fresh = await loadSettings(keys);
    const prev = { ...settings };
    if (stable(keys.map((k) => prev[k])) === stable(keys.map((k) => fresh[k]))) return; // this page's own save
    Object.assign(settings, fresh);
    const changed = (k) => keys.includes(k) && stable(prev[k]) !== stable(settings[k]);
    if (changed('sites') || changed('otherSites')) renderSites();
    if (changed('prefs')) renderPrefs();
    if (changed('provider')) {
      renderProvider();
      renderAccess();
      checkKey();
      return;
    }
    // The key field is left alone while someone is typing in it.
    if (changed('apiKeys') && settings.provider !== 'local' && document.activeElement !== $('key')) {
      $('key').value = settings.apiKeys[settings.provider] || '';
      checkKey();
    }
    if (changed('models')) renderModels();
    if (changed('localModel')) renderLocal();
  });
}

init();
