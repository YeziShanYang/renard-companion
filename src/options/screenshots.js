// The Screenshots section: access to all websites, which browsers require
// before an extension can capture a tab.
import { hasOrigins } from '../shared/settings.js';
import { $, accessButton } from './page.js';

// Firefox gives Renard's bubble no way to ask for permissions, so the
// bubble sends people here.
const ALL_SITES = ['<all_urls>'];

export async function renderScreenshots() {
  const granted = await hasOrigins(ALL_SITES);
  const text = $('shots-text');
  text.textContent = granted
    ? "Allowed. You can take it back in your browser's extension settings."
    : 'Not allowed yet. Pasting or dropping an image into the bubble works without it.';
  const old = $('shots-btn');
  const hadFocus = document.activeElement === old;
  const btn = accessButton(ALL_SITES, renderScreenshots, 'Allow screenshots');
  btn.id = 'shots-btn';
  btn.hidden = granted;
  old.replaceWith(btn);
  // Keyboard focus stays in the section: on the new button, or on the text
  // once the button is gone.
  if (hadFocus) (granted ? text : btn).focus();
}
