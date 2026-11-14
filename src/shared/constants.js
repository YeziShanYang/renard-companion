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
    gemini: { id: 'gemini', name: 'Gemini', origins: ['https://generativelanguage.googleapis.com/*'] },
    // Runs on this computer; model files come from Hugging Face once.
    local: { id: 'local', name: 'Built-in Gemma', origins: [] },
  };

  // Models for the built-in provider, run on the GPU with Transformers.js.
  // sizes are the download for each quantization (text parts only).
  R.LOCAL_MODELS = {
    'gemma-3-1b': {
      id: 'gemma-3-1b',
      name: 'Gemma 3 1B',
      repo: 'onnx-community/gemma-3-1b-it-ONNX',
      kind: 'text',
      sizes: { q4f16: 764e6, q4: 859e6 },
      blurb: 'Quick and light. Good for short questions and summaries.',
    },
    'gemma-4-e2b': {
      id: 'gemma-4-e2b',
      name: 'Gemma 4 E2B',
      repo: 'onnx-community/gemma-4-E2B-it-ONNX',
      kind: 'gemma4',
      sizes: { q4f16: 3111e6, q4: 3627e6 },
      blurb: 'Noticeably smarter. Needs about 5 GB of free memory.',
    },
  };

  // Quantization for this browser. Firefox's WebGPU rejects a shader in the
  // q4f16 builds, so it uses q4; Chrome uses the smaller, faster q4f16 when
  // the GPU supports 16-bit floats.
  R.localDtype = function (isFirefox, hasF16) {
    return !isFirefox && hasF16 ? 'q4f16' : 'q4';
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
    apiKeys: { anthropic: '', openai: '', gemini: '' },
    // Selected model per provider: { id, name, maxTokens, effortLow }, where
    // effortLow means the model accepts a low effort / thinking level.
    models: { anthropic: null, openai: null, gemini: null },
    sites: { claude: true, chatgpt: true },
    prefs: { readChat: true, readableText: false, sound: false },
    bubble: { width: 520, height: 0, expanded: false },
    // Built-in model: the one selected, and which have been downloaded
    // ({ [id]: { dtype, bytes, at } }).
    localModel: { key: 'gemma-3-1b', ready: {} },
    positions: {}, // per site: { edge: 'left' | 'right', y: 0..1 }
  };

  R.LIMITS = {
    chatChars: 40000, // most recent part of a long chat sent as context
    turnChars: 12000, // a single very long message is trimmed from its start
    // The built-in model reads long chats slowly on a laptop GPU.
    localChatChars: 12000,
    localTurnChars: 6000,
  };
})();
