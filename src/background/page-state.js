// What a page's copy of Renard needs to know about its site and the
// settings. It never includes the API keys.
import '../shared/constants.js';
import { ext, loadSettings, hasOrigins, siteIsOn } from '../shared/settings.js';
import { foxReturning } from './session.js';

const R = globalThis.Renard;

// mount: the page is about to show the fox. tabId: the tab asking.
export async function publicState(site, { tabId, mount = false } = {}) {
  const s = await loadSettings();
  const key = site.key || site.id;
  const on = await siteIsOn(s, site);
  const provider = R.PROVIDERS[s.provider] || R.PROVIDERS.anthropic;
  const local = provider.id === 'local' ? R.own(R.LOCAL_MODELS, s.localModel.key) || R.LOCAL_MODELS['gemma-3-1b'] : null;
  const model = local || s.models[provider.id];
  const returning = await foxReturning(tabId, key, { out: s.spawned !== false && on, mount });
  return {
    site: site.id,
    returning,
    spawned: s.spawned !== false,
    enabled: s.spawned !== false && on,
    provider: provider.id,
    providerName: provider.name,
    // For the built-in provider, "has a key" means the model is downloaded.
    hasKey: local ? Boolean(R.localReady(s.localModel, local)) : Boolean(s.apiKeys[provider.id]),
    modelName: model ? model.name : null,
    apiPermission: await hasOrigins(provider.origins),
    prefs: s.prefs,
    bubble: s.bubble,
    position: s.positions[key] || null,
    shortcuts: await shortcutStrings(),
  };
}

// Current bindings ("Alt+Shift+F"), which the user may have changed, so the
// page can recognize them when a focused text field swallows the key.
async function shortcutStrings() {
  const out = {};
  try {
    for (const c of await ext.commands.getAll()) out[c.name] = c.shortcut || '';
  } catch {
    // commands API unavailable
  }
  return out;
}
