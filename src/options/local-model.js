// The built-in model section: which Gemma model, downloading and deleting
// it, and whether this computer's GPU can run it.
import '../shared/constants.js';
import { ext, loadSettings } from '../shared/settings.js';
import { $, IS_FIREFOX, settings, saveEntry, send } from './page.js';

const R = globalThis.Renard;

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

export function renderLocal() {
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
      Object.assign(settings, await loadSettings());
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
  Object.assign(settings, await loadSettings());
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

export function bindLocal() {
  $('local-download').addEventListener('click', startDownload);
  $('local-delete').addEventListener('click', deleteModel);
}


// Finds out whether the GPU can run the built-in model, then shows that and
// checks the downloads for it.
export function checkGpu() {
  detectGpu().then((result) => {
    gpu = result;
    if (settings.provider === 'local') renderLocal();
    checkDownloads();
  });
}
