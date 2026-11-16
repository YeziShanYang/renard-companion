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

  // Any other website the user adds from the toolbar popup. Its id is 'web';
  // settings and the remembered position are kept per host name.
  R.webSite = function (host) {
    return { id: 'web', key: `web:${host}`, name: host, hosts: [host], origins: [R.originFor(host)], generic: true };
  };

  // HTTPS only: on a plain-HTTP page, anyone on the network could rewrite
  // the page Renard runs on.
  R.originFor = (host) => `https://${host}/*`;

  // What an API key can look like: one line of printable ASCII, no spaces,
  // short enough for a request header. Anything else never leaves the page.
  R.isApiKey = (key) => typeof key === 'string' && /^[\x21-\x7e]{1,512}$/.test(key);

  // Own-property lookup, so names like "__proto__" or "constructor" in a
  // message never match a built-in object member.
  R.own = (obj, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);

  // Host names Renard accepts as added sites (what URL.hostname produces):
  // not the built-in chat sites, and not the providers' API hosts, whose
  // access is granted in settings for another reason.
  R.isWebHost = (host) =>
    typeof host === 'string' &&
    host.length <= 253 &&
    /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) &&
    !R.siteForHost(host) &&
    !Object.values(R.PROVIDERS).some((p) => p.origins.includes(`https://${host}/*`));

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
      // Pinned commit: an update to the repository can't change what Renard
      // downloads and runs until this is bumped.
      revision: 'a58439f40017d3b99c7d378ff525e54e0ba08ebf',
      kind: 'text',
      sizes: { q4f16: 764e6, q4: 859e6 },
      blurb: 'Quick and light. Good for short questions and summaries.',
    },
    'gemma-4-e2b': {
      id: 'gemma-4-e2b',
      name: 'Gemma 4 E2B',
      repo: 'onnx-community/gemma-4-E2B-it-ONNX',
      revision: '6f21c99d7e18237f8d2ce92aadfdbfeba877f63a',
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
    // Whether the fox is out at all (the toolbar popup's switch).
    spawned: true,
    provider: 'anthropic',
    apiKeys: { anthropic: '', openai: '', gemini: '' },
    // Selected model per provider: { id, name, maxTokens, effortLow }, where
    // effortLow means the model accepts a low effort / thinking level.
    models: { anthropic: null, openai: null, gemini: null },
    sites: { claude: true, chatgpt: true },
    // Other websites the user added, by host name ("example.com").
    otherSites: [],
    prefs: { readChat: true, readableText: false, sound: false },
    bubble: { width: 520, height: 0, expanded: false },
    // Built-in model: the one selected, and which have been downloaded
    // ({ [id]: { dtype, bytes, at } }).
    localModel: { key: 'gemma-3-1b', ready: {} },
    positions: {}, // per site: { edge: 'left' | 'right', y: 0..1 }
  };

  // The download record for a built-in model, if it matches the pinned
  // revision (an older download has to be fetched again).
  R.localReady = (localModel, model) => {
    const r = model && localModel && localModel.ready && R.own(localModel.ready, model.id);
    return r && r.revision === model.revision ? r : null;
  };

  R.LIMITS = {
    chatChars: 40000, // most recent part of a long chat sent as context
    turnChars: 12000, // a single very long message is trimmed from its start
    // The built-in model reads long input slowly on a laptop GPU, and in
    // Firefox its WebGPU run fails past about 2,000 tokens (a Gemma 3 1B
    // prompt of 12,000 characters failed, 10,000 of plain prose passed; page
    // text has more tokens per character).
    localChatChars: 6000,
    localTurnChars: 3000,
    // Text of another website's page, kept from its start.
    pageChars: 40000,
    localPageChars: 6000,
  };
})();
