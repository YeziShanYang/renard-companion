// The page's side of asking: reading what goes along with a question, the
// port its answer streams back over (background/ask.js serves it), and the
// words the bubble shows for what came back.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  // How each failure is shown: canned-line category, whether to offer the
  // settings button, and whether partial text is thrown away.
  const ERRORS = {
    keyMissing: { line: 'noKey', settings: true },
    permission: { line: 'noPermission', settings: true },
    keyInvalid: { line: 'keyInvalid', settings: true },
    modelUnavailable: { line: 'modelUnavailable', settings: true },
    imageUnsupported: { line: 'imageUnsupported', settings: true },
    rateLimited: { line: 'networkError' },
    network: { line: 'networkError' },
    refused: { line: 'refused', discard: true },
    localMissing: { line: 'localMissing', settings: true },
    noGpu: { line: 'noGpu', settings: true },
    unknown: { line: 'networkError' },
  };

  const UPDATED = 'Renard was updated. Reload the page to keep going.';

  // Provider error text shown on the page, minus anything shaped like a key.
  function scrubError(text) {
    return String(text)
      .replace(/\b(sk-[\w*.-]{4,}|AIza[\w-]{8,}|[A-Za-z0-9_-]{32,})/g, '[hidden]')
      .slice(0, 300);
  }

  R.answers = {
    scrubError,

    // How a failure of this kind is shown (see ERRORS).
    errorStyle(kind) {
      return ERRORS[kind] || ERRORS.unknown;
    },

    // The notice text for a failure. p: the provider's name.
    errorDetail(m, p) {
      switch (m.kind) {
        case 'keyMissing':
          return 'Connect a model in settings to keep going.';
        case 'permission':
          return `Allow Renard to reach ${p} in settings.`;
        case 'refused':
          return '';
        case 'rateLimited':
          return `${p} is rate limiting requests right now.`;
        case 'keyInvalid':
          // Fixed text: some providers echo part of the key in their message.
          return `${p} didn't accept the API key. Check it in settings.`;
        case 'modelUnavailable':
          return `That model isn't available for this ${p} key. Pick another in settings.`;
        case 'imageUnsupported':
          return `That ${p} model can't read images. Pick another in settings, or ask without the screenshot.`;
        case 'localMissing':
        case 'noGpu':
          return m.message;
        default:
          return m.message ? `${p}: ${scrubError(m.message)}` : '';
      }
    },

    // The note about what was read, from the background's context report.
    contextNote(m) {
      const notes = [];
      // The page or chat talks to AI models ("ignore the question"): a
      // model, especially the small built-in one, may do what it says.
      if (m.aimed) notes.push(`This ${m.page ? 'page' : 'chat'} has text aimed at AI assistants, such as instructions to ignore your question. The answer may follow it, so check it before acting on it.`);
      if (m.page && m.partial) notes.push(`Read the first part of this page (${m.included} of ${m.total} characters).`);
      else if (m.partial) notes.push(`Read the latest part of this chat (${m.included} of ${m.total} messages).`);
      return notes.join(' ');
    },

    // The note when the page or chat couldn't be read.
    unreadNote(reading) {
      return reading === 'page'
        ? "Couldn't find any text on this page, so this answer doesn't use it."
        : "Couldn't read the chat on this page, so this answer doesn't use it.";
    },

    // Added to the note when the answer is empty or was cut short.
    endNote(text, limited) {
      return !text ? 'Hmm, the answer came back empty. Try asking again?' : limited ? "This answer reached the model's length limit, so it ends early." : '';
    },
  };

  // The chat (chat sites) or page text (other sites) to send with a
  // question, read through the site's adapter. failed: it couldn't be read.
  R.readContext = function (adapter, siteName) {
    let chat = null;
    let page = null;
    try {
      if (adapter.kind === 'page') {
        page = adapter.readPage();
        if (!page.text) throw new Error('No text on this page');
      } else {
        const turns = R.adapterUtils.capTurns(adapter.readChat());
        if (turns.length) chat = { siteName, turns };
      }
      return { chat, page, failed: false };
    } catch {
      return { chat, page: null, failed: true };
    }
  };

  // Sends one question ({ question, chat, page, image }) to the background
  // script, which streams the answer back. on receives what happens:
  //   loading()           the built-in model is loading (before any text)
  //   context(m)          how much of the chat or page went along
  //   delta(piece)        the next piece of the answer
  //   done(text, limited) the whole answer; limited: cut at the length limit
  //   failed(m, text)     an error ({ kind, message }) and the text so far
  // Returns the request, whose cancel() stops it with no further calls, or
  // null when it couldn't be sent (failed has been called).
  R.sendQuestion = function (payload, on) {
    let port;
    try {
      port = R.ext.runtime.connect({ name: 'renard:ask' });
    } catch {
      // The extension was reloaded or updated since this page loaded.
      on.failed({ kind: 'network', message: UPDATED }, '');
      return null;
    }
    let live = true;
    let text = '';
    // Pings keep the background awake through a long answer (Firefox
    // otherwise suspends an idle background page after about 30 s).
    const keepAlive = setInterval(() => {
      try {
        port.postMessage({ type: 'ping' });
      } catch {
        clearInterval(keepAlive);
      }
    }, 10000);
    const end = () => {
      live = false;
      clearInterval(keepAlive);
      port.disconnect();
    };
    port.onMessage.addListener((m) => {
      if (!live || !m) return;
      if (m.type === 'loading') {
        if (!text) on.loading();
      } else if (m.type === 'context') {
        on.context(m);
      } else if (m.type === 'delta') {
        const piece = String(m.text || '');
        text += piece;
        on.delta(piece);
      } else if (m.type === 'done') {
        end();
        on.done(text, m.limited === true);
      } else if (m.type === 'error') {
        end();
        on.failed(m, text);
      }
    });
    port.onDisconnect.addListener(() => {
      clearInterval(keepAlive);
      if (!live) return;
      live = false;
      on.failed({ kind: 'network', message: 'Lost the connection to the extension. Try again.' }, text);
    });
    try {
      port.postMessage({ type: 'ask', ...payload });
    } catch {
      end();
      on.failed({ kind: 'network', message: UPDATED }, '');
      return null;
    }
    return {
      cancel() {
        if (live) end();
      },
    };
  };
})();
