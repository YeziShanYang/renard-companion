// The AI provider section: which provider, its API key and model, and
// access to its API. Built-in models have their own section
// (local-model.js), shown in this one's place.
import '../shared/constants.js';
import { ext, loadSettings, hasOrigins } from '../shared/settings.js';
import { listModels, ProviderError } from '../shared/providers.js';
import { $, settings, save, saveEntry, stable, accessButton } from './page.js';
import { renderLocal } from './local-model.js';

const R = globalThis.Renard;

const KEY_HINTS = {
  anthropic: { text: 'Create a key in the Claude Console', url: 'https://platform.claude.com/settings/keys' },
  openai: { text: 'Create a key on the OpenAI platform', url: 'https://platform.openai.com/api-keys' },
  gemini: { text: 'Get a free key in Google AI Studio', url: 'https://aistudio.google.com/apikey' },
};

let models = [];
let checkController = null;
let keyTimer = 0;

// Characters a copied key can pick up: spaces, line breaks, and invisible
// formatting characters such as zero-width spaces.
const KEY_JUNK = /[\s\p{Cf}]+/gu;
let refusedKey = null;

function setStatus(state, text) {
  const el = $('key-status');
  el.dataset.state = state || '';
  el.textContent = text || '';
}

export function renderProvider() {
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
  // Gemini's API has a free plan, so it's mentioned whichever provider is
  // picked, along with Built-in, which needs no key.
  const free =
    settings.provider === 'gemini'
      ? ' On the free plan, Google may use what you send to improve its products.'
      : ' No key? Built-in needs none, and Gemini has a free plan.';
  $('key-hint').replaceChildren('Stored only in this browser. ', link, '.', free);
}

export function renderModels() {
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
export async function checkKey() {
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

export function bindAi() {
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
    // Sent without waiting for a reply: there may be no time for a round
    // trip, and the background script does the write.
    ext.runtime.sendMessage({ type: 'renard:setEntry', key: 'apiKeys', entry: pendingKey.provider, value }).catch(() => {});
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

export async function renderAccess() {
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


// Another page saved a key: it shows here, unless someone is typing in the
// field.
export function keyChanged() {
  if (settings.provider === 'local' || document.activeElement === $('key')) return;
  $('key').value = settings.apiKeys[settings.provider] || '';
  checkKey();
}
