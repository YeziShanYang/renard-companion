// Matching Renard's keyboard shortcuts inside the page.
//
// The browser normally handles them as extension commands, but a focused
// text field can swallow the key first: on macOS, Option+Shift+F types "Ï"
// in a text box, so the command never fires while the bubble's input has
// focus. The content script therefore also recognizes the configured
// shortcuts itself.
//
// A letter or digit is matched by the character the key types, as the
// browsers match their own shortcuts, so on Dvorak or AZERTY the key
// labelled F is F. When a modifier changes that character (Option on
// macOS) or the layout isn't Latin, the physical key that types it is used
// instead: from the keyboard layout where the browser reports it (Chrome),
// otherwise the key in the US position.
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
    // Chrome's macOS names for these keys.
    '↑': 'ArrowUp',
    '↓': 'ArrowDown',
    '←': 'ArrowLeft',
    '→': 'ArrowRight',
    '↖': 'Home',
    '↘': 'End',
    '⇞': 'PageUp',
    '⇟': 'PageDown',
    '⌦': 'Delete',
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

  // { command: shortcut string } as parsed shortcuts, leaving out any that
  // can't be recognized.
  R.parseShortcuts = function (strings) {
    const out = {};
    for (const [cmd, text] of Object.entries(strings || {})) {
      const parsed = R.parseShortcut(text);
      if (parsed) out[cmd] = parsed;
    }
    return out;
  };

  // The current keyboard layout, code -> character, where the browser
  // reports it (Chrome's Keyboard API, in a top-level page or a frame
  // allowed keyboard-map), or null. Kept on R, so a second copy of this
  // file in the same page (injected again) shares it.
  const keyboard = (R.keyboard = R.keyboard || { layout: null, loadedAt: 0 });
  async function loadLayout() {
    keyboard.loadedAt = Date.now();
    try {
      keyboard.layout = new Map(await globalThis.navigator.keyboard.getLayoutMap());
    } catch {
      keyboard.layout = null;
    }
  }
  // Reads the layout now and again later. Chrome doesn't announce a
  // layout switch, so it's read again when the page gets focus back, and
  // at most once a second on a key pressed with a modifier, which then
  // applies from the next shortcut on. Called on every mount: a page that
  // rewrites itself (document.open) drops the listeners, and adding the
  // same listener twice does nothing.
  R.watchKeyboardLayout = function () {
    if (!(globalThis.navigator && navigator.keyboard)) return;
    if (!keyboard.onFocus) {
      keyboard.onFocus = () => loadLayout();
      keyboard.onKey = (e) => {
        if ((e.altKey || e.ctrlKey || e.metaKey) && Date.now() - keyboard.loadedAt > 1000) loadLayout();
      };
      loadLayout();
    }
    addEventListener('focus', keyboard.onFocus);
    addEventListener('keydown', keyboard.onKey, true);
  };
  // For tests: a Map or [code, character] pairs, or null.
  R.setKeyboardLayout = function (map) {
    keyboard.layout = map ? new Map(map) : null;
  };

  // The physical key that types this letter or digit in the current layout.
  function physicalCode(char, fallback) {
    if (keyboard.layout) {
      const lower = char.toLowerCase();
      for (const [code, value] of keyboard.layout) if (value === lower) return code;
    }
    return fallback;
  }

  R.matchesShortcut = function (event, shortcut) {
    if (
      !shortcut ||
      event.altKey !== shortcut.alt ||
      event.shiftKey !== shortcut.shift ||
      event.ctrlKey !== shortcut.ctrl ||
      event.metaKey !== shortcut.meta
    ) {
      return false;
    }
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(shortcut.code);
    if (!m) return event.code === shortcut.code;
    const char = m[1] || m[2];
    if (typeof event.key === 'string' && /^[A-Za-z0-9]$/.test(event.key)) return event.key.toUpperCase() === char;
    return event.code === physicalCode(char, shortcut.code);
  };
})();
