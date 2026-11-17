// Adapter for any other website the user added. Instead of chat turns it
// reads the page's visible text: the largest main/article region when there
// is one, otherwise the whole body.
(function () {
  const R = globalThis.Renard;
  const U = R.adapterUtils;

  // More than this is never useful; the background trims to its own limit.
  const MAX_CHARS = 200000;

  R.adapters.web = {
    kind: 'page',

    readPage() {
      let best = null;
      let bestLength = 0;
      for (const el of document.querySelectorAll('main, article, [role="main"]')) {
        const length = (el.innerText || '').length;
        if (length > bestLength) {
          best = el;
          bestLength = length;
        }
      }
      const body = document.body;
      // A tiny <main> (a cookie banner, an app shell) is not the page.
      const bodyLength = body ? (body.innerText || '').length : 0;
      const root = best && bestLength >= bodyLength * 0.25 ? best : body;
      // Read like a chat message: without buttons, and without text the
      // page hides from the user (which can still carry instructions aimed
      // at the model).
      const text = root ? U.messageText(root, MAX_CHARS, { page: true }).slice(0, MAX_CHARS) : '';
      // The URL without its query, fragment or ;parameters (a session id,
      // say), which can carry tokens.
      return { title: document.title.slice(0, 300), url: location.origin + location.pathname.replace(/;[^/]*/g, ''), text };
    },

    composerRect() {
      return null;
    },

    theme() {
      return U.themeFromPage();
    },
  };
})();
