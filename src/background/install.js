// Installs and updates. A first install opens settings, where the tour
// starts. An update from a version without the tour marks it done, so
// people who already use Renard aren't walked through it.
import { ext, loadSettings } from '../shared/settings.js';
import { update } from './store.js';

// The first version with the settings page's tour.
const TOUR_SINCE = '0.1.4';

// Whether dotted version a comes before b ("0.1.3" before "0.1.4").
export function versionBefore(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

export async function installed(details) {
  if (details.reason === 'update') {
    if (!details.previousVersion || versionBefore(details.previousVersion, TOUR_SINCE)) {
      await update('tourDone', (done) => (done ? undefined : true));
    }
    return;
  }
  if (details.reason !== 'install') return;
  // Reinstalling during development keeps storage in some browsers: with a
  // key saved and the tour done, another settings tab would only get in the
  // way.
  const s = await loadSettings(['apiKeys', 'tourDone']);
  if (!s.tourDone || !Object.values(s.apiKeys).some(Boolean)) await ext.runtime.openOptionsPage();
}
