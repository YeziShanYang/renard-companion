// The Keyboard shortcuts section: the current bindings, and where to change
// them.
import { ext } from '../shared/settings.js';
import { $, IS_FIREFOX } from './page.js';

export async function renderShortcuts() {
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
  $('shortcut-hint').textContent = IS_FIREFOX
    ? 'Change them in about:addons: open the gear menu and choose Manage Extension Shortcuts.'
    : 'Change them at chrome://extensions/shortcuts.';
}
