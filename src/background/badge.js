// The toolbar icon's "!" badge, shown while Renard lacks access it needs
// for the current settings.
import { ext, loadSettings, hasOrigins, requiredOrigins } from '../shared/settings.js';

export async function updateBadge() {
  const s = await loadSettings();
  const ok = await hasOrigins(requiredOrigins(s));
  const action = ext.action;
  await action.setBadgeText({ text: ok ? '' : '!' });
  if (!ok) await action.setBadgeBackgroundColor({ color: '#d67941' });
  await action.setTitle({ title: ok ? 'Renard' : 'Renard needs site access' });
}
