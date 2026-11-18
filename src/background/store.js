// Changes to stored settings, made one at a time.
import { loadSettings, saveSettings } from '../shared/settings.js';

let writes = Promise.resolve();

// Read-modify-write of one stored setting. change receives the current value
// and returns the next one, or undefined to leave it as it is. Two quick
// actions (two tabs saving a position, a site added then removed) each start
// from the other's result instead of overwriting it.
export function update(key, change) {
  const run = writes.then(async () => {
    const value = (await loadSettings([key]))[key];
    const next = await change(value);
    if (next !== undefined) await saveSettings({ [key]: next });
    return next;
  });
  writes = run.catch(() => {});
  return run;
}
