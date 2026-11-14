// Matching Renard's keyboard shortcuts inside the page.
//
// The browser normally handles them as extension commands, but a focused
// text field can swallow the key first: on macOS, Option+Shift+F types "Ï"
// in a text box, so the command never fires while the bubble's input has
// focus. The content script therefore also recognizes the configured
// shortcuts itself, by physical key (KeyboardEvent.code, which Option does
// not change).
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  const IS_MAC = /Mac|iPhone|iPad/i.test((globalThis.navigator && (navigator.platform || navigator.userAgent)) || '');
  const SYMBOLS = { '⌥': 'Alt', '⇧': 'Shift', '⌘': 'Command', '⌃': 'MacCtrl' };
  const NAMED = {
    Comma: 'Comma',
    ',': 'Comma',
    Period: 'Period',
    '.': 'Period',
    Space: 'Space',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Delete: 'Delete',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
  };

  function keyToCode(key) {
    if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    if (/^F([1-9]|1[0-2])$/.test(key)) return key;
    return NAMED[key] || null;
  }

  // Parses a commands API shortcut string: "Alt+Shift+F", "MacCtrl+Shift+F",
  // "Ctrl+Shift+Y", or Chrome's macOS form "⌥⇧F". In both browsers "Ctrl"
  // means Command on macOS and "MacCtrl" means Control.
  R.parseShortcut = function (text, mac = IS_MAC) {
    const s = String(text || '').trim();
    if (!s) return null;
    let parts;
    if (s.includes('+')) {
      parts = s.split('+').map((p) => p.trim());
    } else {
      parts = [];
      const chars = Array.from(s);
      let i = 0;
      while (i < chars.length && SYMBOLS[chars[i]]) parts.push(SYMBOLS[chars[i++]]);
      parts.push(chars.slice(i).join(''));
    }
    const code = keyToCode(parts.pop());
    if (!code) return null;
    const mods = { alt: false, shift: false, ctrl: false, meta: false };
    for (const p of parts.map((x) => x.toLowerCase())) {
      if (p === 'alt' || p === 'option') mods.alt = true;
      else if (p === 'shift') mods.shift = true;
      else if (p === 'command' || p === 'cmd' || p === 'meta') mods.meta = true;
      else if (p === 'macctrl') mods.ctrl = true;
      else if (p === 'ctrl' || p === 'control') {
        if (mac) mods.meta = true;
        else mods.ctrl = true;
      }
    }
    return { ...mods, code };
  };

  R.matchesShortcut = function (event, shortcut) {
    return Boolean(
      shortcut &&
        event.code === shortcut.code &&
        event.altKey === shortcut.alt &&
        event.shiftKey === shortcut.shift &&
        event.ctrlKey === shortcut.ctrl &&
        event.metaKey === shortcut.meta,
    );
  };
})();
