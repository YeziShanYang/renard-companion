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
  const provider = R.PROVIDERS[settings.provider];
  const key = settings.apiKeys[provider.id];
  models = [];
  if (!key) {
    setStatus('', 'Paste a key to connect.');
    renderModels();
    return;
  }
  if (!(await hasOrigins(provider.origins))) {
    setStatus('bad', `Renard needs access to ${provider.name} first (see Sites below).`);
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
  $('api-access-text').textContent = `Renard needs permission to reach ${provider.origins[0].replace('/*', '')} to answer with ${provider.name}.`;
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
  renderProvider();
  bindAi();
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
