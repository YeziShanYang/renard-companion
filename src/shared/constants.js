// Shared constants. Written without import/export so the same file runs as a
// classic content script and as a side-effect import from ES modules
// (background, options page). Everything hangs off globalThis.Renard.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  R.SITES = {
    claude: { id: 'claude', name: 'Claude', hosts: ['claude.ai'], origins: ['https://claude.ai/*'] },
    chatgpt: {
      id: 'chatgpt',
      name: 'ChatGPT',
      hosts: ['chatgpt.com', 'chat.openai.com'],
      origins: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    },
  };

  R.PROVIDERS = {
    anthropic: { id: 'anthropic', name: 'Anthropic', origins: ['https://api.anthropic.com/*'] },
    openai: { id: 'openai', name: 'OpenAI', origins: ['https://api.openai.com/*'] },
  };

  R.siteForHost = function (hostname) {
    for (const site of Object.values(R.SITES)) {
      if (site.hosts.some((h) => hostname === h || hostname.endsWith('.' + h))) return site;
    }
    return null;
  };

  // Everything in storage.local except the API keys, which only the
  // background script and options page ever read.
  R.DEFAULTS = {
    provider: 'anthropic',
    apiKeys: { anthropic: '', openai: '' },
    // Selected model per provider: { id, name, maxTokens, effortLow }
    models: { anthropic: null, openai: null },
    sites: { claude: true, chatgpt: true },
    prefs: { readChat: true, readableText: false, sound: false },
    bubble: { width: 420, height: 0, expanded: false },
    positions: {}, // per site: { edge: 'left' | 'right', y: 0..1 }
  };

  R.LIMITS = {
    chatChars: 40000, // most recent part of a long chat sent as context
    turnChars: 12000, // a single very long message is trimmed from its start
  };
})();
