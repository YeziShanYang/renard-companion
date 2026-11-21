// The settings page. Each section is a module of its own:
//   provider.js     AI provider, API key, model, and access to the API
//   local-model.js  the built-in model (shown in place of the key)
//   sites.js        where Renard runs
//   screenshots.js  access for screenshots
//   display.js      readable text and sound
//   shortcuts.js    keyboard shortcuts
// page.js holds what they share, including the settings themselves.
import '../shared/constants.js';
import { ext, loadSettings, changedSettings } from '../shared/settings.js';
import { drawHeaderFox } from '../shared/header-fox.js';
import { $, settings, stable } from './page.js';
import { renderProvider, renderModels, checkKey, bindAi, renderAccess, keyChanged } from './provider.js';
import { renderLocal, bindLocal, checkGpu } from './local-model.js';
import { renderSites } from './sites.js';
import { renderScreenshots } from './screenshots.js';
import { renderPrefs, bindPrefs } from './display.js';
import { renderShortcuts } from './shortcuts.js';
import { bindTour, maybeStartTour, tourDoneElsewhere } from './tour.js';

async function init() {
  Object.assign(settings, await loadSettings());
  // Controls work right away; the GPU check fills in the built-in section
  // when it's done, so nothing typed or clicked meanwhile is lost.
  renderProvider();
  bindAi();
  bindLocal();
  bindPrefs();
  bindTour();
  drawHeaderFox($('fox'), {
    lively: true,
    onMissing: () => {
      $('sprite-missing').hidden = false;
    },
  });
  checkGpu();
  await Promise.all([renderSites(), renderAccess(), renderScreenshots(), renderShortcuts()]);
  checkKey();
  // First visit after installing: the fox shows the page around.
  maybeStartTour();
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
    const keys = changedSettings(changes);
    if (!keys.length) return;
    const fresh = await loadSettings(keys);
    const prev = { ...settings };
    if (stable(keys.map((k) => prev[k])) === stable(keys.map((k) => fresh[k]))) return; // this page's own save
    Object.assign(settings, fresh);
    const changed = (k) => keys.includes(k) && stable(prev[k]) !== stable(settings[k]);
    if (['sites', 'otherSites', 'allSites', 'skippedSites'].some(changed)) renderSites();
    if (changed('tourDone') && settings.tourDone) tourDoneElsewhere();
    if (changed('prefs')) renderPrefs();
    if (changed('provider')) {
      renderProvider();
      renderAccess();
      checkKey();
      return;
    }
    if (changed('apiKeys')) keyChanged();
    if (changed('models')) renderModels();
    if (changed('localModel')) renderLocal();
  });
}

init();
