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
  const hint = KEY_HINTS[settings.provider];
  const link = Object.assign(document.createElement('a'), { href: hint.url, target: '_blank', rel: 'noopener noreferrer', textContent: hint.text });
  $('key-hint').replaceChildren('Stored only in this browser. ', link, '.');
}

function renderModels() {
  const select = $('model');
  select.replaceChildren();
  if (!models.length) {
    select.append(new Option('Connect a key to load models'));
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
  if (settings.provider === 'local') return;
  const provider = R.PROVIDERS[settings.provider];
  const key = settings.apiKeys[provider.id];
  models = [];
  if (!key) {
    setStatus('', 'Paste a key to connect.');
    renderModels();
    return;
  }
  if (!(await hasOrigins(provider.origins))) {
    // The access box under the key explains it and offers the button.
    setStatus('', '');
    renderModels();
    return;
  }
  const controller = new AbortController();
  checkController = controller;
  setStatus('busy', 'Checking…');
  try {
    const list = await listModels(provider.id, key, { signal: controller.signal });
    if (controller.signal.aborted) return;
    models = list;
    if (!list.length) {
      setStatus('bad', 'Connected, but no models are available for this key.');
    } else {
      setStatus('ok', '✓ Connected');
      const current = settings.models[provider.id];
      const match = current && list.find((m) => m.id === current.id);
      // Keep the chosen model (refreshing its limits); otherwise take the newest.
      const chosen = match || list[0];
      if (!current || JSON.stringify(current) !== JSON.stringify(chosen)) {
        await save({ models: { ...settings.models, [provider.id]: chosen } });
      }
    }
  } catch (err) {
    if (controller.signal.aborted || (err instanceof ProviderError && err.kind === 'aborted')) return;
    setStatus('bad', `✗ ${describeError(err, provider.name)}`);
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
      await save({ provider: radio.value });
      renderProvider();
      renderAccess();
      checkKey();
    });
  }

  $('key').addEventListener('input', () => {
    clearTimeout(keyTimer);
    keyTimer = setTimeout(async () => {
      const value = $('key').value.trim();
      await save({ apiKeys: { ...settings.apiKeys, [settings.provider]: value } });
      checkKey();
    }, 500);
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
    if (chosen) save({ models: { ...settings.models, [settings.provider]: chosen } });
  });
}

// ---- built-in model ------------------------------------------------------------

const IS_FIREFOX = typeof ext.runtime.getBrowserInfo === 'function';
let gpu = null; // { ok, f16, dtype } or { ok: false, reason }
let downloadPort = null;

function formatBytes(n) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
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
  list.replaceChildren(
    ...Object.values(R.LOCAL_MODELS).map((m) => {
      const ready = lm.ready[m.id];
      const label = document.createElement('label');
      label.className = 'model-choice';
      const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'local-model', value: m.id, checked: lm.key === m.id });
      input.addEventListener('change', async () => {
        if (!input.checked) return;
        await save({ localModel: { ...settings.localModel, key: m.id } });
        setLocalStatus('', '');
        renderLocal();
      });
      const dot = Object.assign(document.createElement('span'), { className: 'model-dot' });
      dot.setAttribute('aria-hidden', 'true');
      const name = Object.assign(document.createElement('span'), { className: 'model-name', textContent: m.name });
      const size = Object.assign(document.createElement('span'), {
        className: ready ? 'model-state' : 'model-size',
        textContent: ready ? `Downloaded · ${formatBytes(ready.bytes)}` : `${formatBytes(m.sizes[dtype])} download`,
      });
      const blurb = Object.assign(document.createElement('span'), { className: 'model-blurb', textContent: m.blurb });
      label.append(input, dot, name, size, blurb);
      return label;
    }),
  );

  const selected = R.LOCAL_MODELS[lm.key] || R.LOCAL_MODELS['gemma-3-1b'];
  const ready = lm.ready[selected.id];
  const busy = Boolean(downloadPort);
  $('local-download').hidden = Boolean(ready);
  $('local-download').textContent = `Download ${selected.name} (${formatBytes(selected.sizes[dtype])})`;
  $('local-download').disabled = busy || (gpu && !gpu.ok);
  $('local-delete').hidden = !ready || busy;
  $('local-delete').textContent = `Delete ${selected.name}`;
  $('local-gpu').hidden = !gpu || gpu.ok;
  $('local-gpu').textContent = gpu && !gpu.ok ? gpu.reason : '';
  if (!busy && ready) setLocalStatus('ok', `✓ ${selected.name} is ready on this computer`);
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
  const res = await ext.runtime.sendMessage({ type: 'renard:localRemove', key: selected.id });
  $('local-delete').disabled = false;
  if (!res || !res.ok) {
    setLocalStatus('bad', `✗ Couldn't delete it: ${(res && res.error) || 'no response'}`);
    return;
  }
  settings = await loadSettings();
  setLocalStatus('', `${selected.name} was deleted from this computer.`);
  renderLocal();
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
function accessButton(origins, onDone) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary';
  btn.textContent = 'Allow access';
  btn.addEventListener('click', () => {
    ext.permissions.request({ origins }).then(onDone, onDone);
  });
  return btn;
}

async function renderSites() {
  const list = $('sites');
  list.replaceChildren();
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
    if (enabled && !(await hasOrigins(site.origins))) {
      actions.append(
        accessButton(site.origins, () => {
          renderSites();
        }),
      );
    }
    const { label, input } = switchControl(`site-${site.id}`, enabled, title.id);
    input.addEventListener('change', async () => {
      await save({ sites: { ...settings.sites, [site.id]: input.checked } });
      renderSites();
    });
    actions.append(label);
    li.append(text, actions);
    list.append(li);
  }
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

// ---- display ----------------------------------------------------------------

function bindPrefs() {
  for (const key of ['readable', 'sound']) {
    const input = $(key);
    const pref = key === 'readable' ? 'readableText' : 'sound';
    input.checked = Boolean(settings.prefs[pref]);
    input.addEventListener('change', () => save({ prefs: { ...settings.prefs, [pref]: input.checked } }));
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
  gpu = await detectGpu();
  renderProvider();
  bindAi();
  bindLocal();
  bindPrefs();
  drawFox();
  await Promise.all([renderSites(), renderAccess(), renderShortcuts()]);
  checkKey();
  ext.permissions.onAdded.addListener(() => {
    renderSites();
    renderAccess();
    checkKey();
  });
  ext.permissions.onRemoved.addListener(() => {
    renderSites();
    renderAccess();
  });
}

init();
