import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SSEParser,
  classifyHttpError,
  isOpenAIChatModel,
  isGeminiChatModel,
  streamAnswer,
  listModels,
  ProviderError,
} from '../src/shared/providers.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A streaming Response whose body arrives in the given chunks.
function sse(chunks, init = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const anthropicModel = { id: 'claude-opus-5-5', maxTokens: 128000, effortLow: true };

test('SSE parser handles split chunks, CRLF, comments, and multi-line data', () => {
  const p = new SSEParser();
  const events = [
    ...p.push(': ping\r\nevent: a\r'),
    ...p.push('\ndata: one\r\n\r\nevent: b\ndata: x\ndata: y\n'),
    ...p.push('\n'),
  ];
  assert.deepEqual(events, [
    { event: 'a', data: 'one' },
    { event: 'b', data: 'x\ny' },
  ]);
  assert.deepEqual(p.flush(), []);
});

test('HTTP errors map to the cases Renard shows', () => {
  assert.equal(classifyHttpError(401, {}), 'keyInvalid');
  assert.equal(classifyHttpError(429, { error: { code: 'insufficient_quota' } }), 'keyInvalid');
  assert.equal(classifyHttpError(429, { error: { type: 'rate_limit_error' } }), 'rateLimited');
  assert.equal(classifyHttpError(400, { error: { message: 'Your credit balance is too low' } }), 'keyInvalid');
  assert.equal(classifyHttpError(404, {}), 'modelUnavailable');
  assert.equal(classifyHttpError(529, {}), 'network');
  assert.equal(classifyHttpError(400, { error: { message: 'max_tokens: bad' } }), 'unknown');
});

test('OpenAI model filter keeps chat models only', () => {
  for (const id of ['gpt-5', 'gpt-4o-mini', 'o3', 'chatgpt-4o-latest', 'gpt-5-codex']) assert.ok(isOpenAIChatModel(id), id);
  for (const id of ['text-embedding-3-small', 'whisper-1', 'gpt-image-1', 'tts-1', 'gpt-4o-realtime-preview', 'dall-e-3'])
    assert.ok(!isOpenAIChatModel(id), id);
});

test('Anthropic stream: text deltas, request shape, and headers', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), init, body: JSON.parse(init.body) };
    return sse([
      'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"te',
      'xt_delta","text":"lo"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
  };
  let out = '';
  const result = await streamAnswer('anthropic', {
    apiKey: 'k',
    model: anthropicModel,
    system: 'sys',
    user: 'hi',
    onDelta: (t) => (out += t),
  });
  assert.equal(out, 'Hello');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.init.headers['anthropic-version'], '2026-10-21');
  assert.equal(sent.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(sent.init.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(sent.body.max_tokens, 16000);
  assert.deepEqual(sent.body.output_config, { effort: 'low' });
  assert.equal(sent.body.fallbacks, 'default');
  assert.equal(sent.body.temperature, undefined);
});

test('Anthropic: a 400 from optional fields retries once without them', async () => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.output_config) return json(400, { error: { type: 'invalid_request_error', message: 'output_config: not supported' } });
    return sse(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n']);
  };
  let out = '';
  await streamAnswer('anthropic', { apiKey: 'k', model: anthropicModel, system: '', user: 'q', onDelta: (t) => (out += t) });
  assert.equal(out, 'ok');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].output_config, undefined);
  assert.equal(bodies[1].fallbacks, undefined);
});

test('Anthropic: refusal stop reason and stream errors become ProviderErrors', async () => {
  globalThis.fetch = async () =>
    sse(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"par"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n']);
  await assert.rejects(
    streamAnswer('anthropic', { apiKey: 'k', model: { id: 'claude-haiku-4-5' }, system: '', user: 'q', onDelta() {} }),
    (e) => e instanceof ProviderError && e.kind === 'refused',
  );
  globalThis.fetch = async () => sse(['event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n']);
  await assert.rejects(
    streamAnswer('anthropic', { apiKey: 'k', model: { id: 'claude-haiku-4-5' }, system: '', user: 'q', onDelta() {} }),
    (e) => e.kind === 'network' && e.message === 'Overloaded',
  );
});

test('Anthropic: unknown model limits fall back to a safe max_tokens and no optional fields', async () => {
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return sse(['data: {"type":"message_stop"}\n\n']);
  };
  await streamAnswer('anthropic', { apiKey: 'k', model: { id: 'claude-haiku-4-5' }, system: '', user: 'q', onDelta() {} });
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.output_config, undefined);
  assert.equal(body.fallbacks, undefined);
});

test('OpenAI stream: Responses API text deltas, store disabled, reasoning effort', async () => {
  let body;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.authorization, 'Bearer sk');
    body = JSON.parse(init.body);
    return sse([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi "}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"there"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n',
    ]);
  };
  let out = '';
  const r = await streamAnswer('openai', { apiKey: 'sk', model: { id: 'gpt-5' }, system: 'sys', user: 'q', onDelta: (t) => (out += t) });
  assert.equal(out, 'Hi there');
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(body.store, false);
  assert.equal(body.instructions, 'sys');
  assert.deepEqual(body.reasoning, { effort: 'low' });
});

test('OpenAI: failed responses and refusals', async () => {
  globalThis.fetch = async () =>
    sse(['data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"boom"}}}\n\n']);
  await assert.rejects(
    streamAnswer('openai', { apiKey: 'sk', model: { id: 'gpt-4o' }, system: '', user: 'q', onDelta() {} }),
    (e) => e.kind === 'network' && e.message === 'boom',
  );
  globalThis.fetch = async () => sse(['data: {"type":"response.refusal.delta","delta":"no"}\n\ndata: {"type":"response.completed"}\n\n']);
  await assert.rejects(
    streamAnswer('openai', { apiKey: 'sk', model: { id: 'gpt-4o' }, system: '', user: 'q', onDelta() {} }),
    (e) => e.kind === 'refused',
  );
});

test('network failures and aborts', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(
    streamAnswer('openai', { apiKey: 'sk', model: { id: 'gpt-4o' }, system: '', user: 'q', onDelta() {} }),
    (e) => e.kind === 'network',
  );
  globalThis.fetch = async () => {
    throw new DOMException('The operation was aborted.', 'AbortError');
  };
  await assert.rejects(
    streamAnswer('openai', { apiKey: 'sk', model: { id: 'gpt-4o' }, system: '', user: 'q', onDelta() {} }),
    (e) => e.kind === 'aborted',
  );
});

test('listModels: Anthropic pagination and capability mapping', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    if (!new URL(url).searchParams.get('after_id')) {
      return json(200, {
        data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_tokens: 128000, capabilities: { effort: { supported: true, low: { supported: true } } } }],
        has_more: true,
        last_id: 'claude-opus-5-5',
      });
    }
    return json(200, { data: [{ id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', max_tokens: 64000, capabilities: { effort: { supported: false, low: { supported: false } } } }], has_more: false });
  };
  const list = await listModels('anthropic', 'k');
  assert.deepEqual(list, [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', maxTokens: 128000, effortLow: true },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', maxTokens: 64000, effortLow: false },
  ]);
  assert.equal(urls[1].searchParams.get('after_id'), 'claude-opus-5-5');
});

test('listModels: invalid key surfaces as keyInvalid', async () => {
  globalThis.fetch = async () => json(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  await assert.rejects(listModels('anthropic', 'bad'), (e) => e.kind === 'keyInvalid' && e.status === 401);
});

// ---- Gemini ------------------------------------------------------------------

const gem = (name, extra = {}) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent', 'countTokens'], ...extra });

test('Gemini model filter keeps text-generation Gemini models only', () => {
  for (const name of ['gemini-2.5-flash', 'gemini-3.1-pro-preview', 'gemini-4-hydrogen']) assert.ok(isGeminiChatModel(gem(name)), name);
  for (const name of ['gemini-embedding-001', 'gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts', 'gemini-live-2.5-flash', 'gemma-3-27b-it', 'imagen-4.0-generate-001'])
    assert.ok(!isGeminiChatModel(gem(name)), name);
  assert.ok(!isGeminiChatModel({ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['embedContent'] }));
});

test('listModels: Gemini pagination, header auth, newest family first', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ u, headers: init.headers });
    if (!u.searchParams.get('pageToken')) {
      return json(200, {
        models: [
          gem('gemini-2.5-flash', { displayName: 'Gemini 2.5 Flash', outputTokenLimit: 65536, thinking: true }),
          gem('gemini-embedding-001'),
          gem('gemini-2.0-flash', { displayName: 'Gemini 2.0 Flash', outputTokenLimit: 8192 }),
        ],
        nextPageToken: 'p2',
      });
    }
    return json(200, { models: [gem('gemini-3.5-flash', { displayName: 'Gemini 3.5 Flash', outputTokenLimit: 65536, thinking: true })] });
  };
  const list = await listModels('gemini', 'g-key');
  assert.deepEqual(list, [
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', maxTokens: 65536, effortLow: true },
    // thinkingLevel is for Gemini 3 and later.
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', maxTokens: 65536, effortLow: false },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', maxTokens: 8192, effortLow: false },
  ]);
  assert.equal(calls[0].u.pathname, '/v1beta/models');
  assert.equal(calls[0].headers['x-goog-api-key'], 'g-key');
  assert.equal(calls[0].u.searchParams.get('key'), null);
  assert.equal(calls[1].u.searchParams.get('pageToken'), 'p2');
});

test('Gemini stream: text deltas, thought parts skipped, request shape', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url: new URL(url), init, body: JSON.parse(init.body) };
    return sse([
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"plan","thought":true}]}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}\r\n\r\ndata: {"candidates":[{"content":{"ro',
      'le":"model","parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{}}\r\n\r\n',
    ]);
  };
  let out = '';
  const r = await streamAnswer('gemini', {
    apiKey: 'g-key',
    model: { id: 'gemini-3.5-flash', effortLow: true },
    system: 'sys',
    user: 'hi',
    onDelta: (t) => (out += t),
  });
  assert.equal(out, 'Hello');
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(sent.url.pathname, '/v1beta/models/gemini-3.5-flash:streamGenerateContent');
  assert.equal(sent.url.searchParams.get('alt'), 'sse');
  assert.equal(sent.init.headers['x-goog-api-key'], 'g-key');
  assert.deepEqual(sent.body.systemInstruction, { parts: [{ text: 'sys' }] });
  assert.deepEqual(sent.body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  assert.deepEqual(sent.body.generationConfig, { thinkingConfig: { thinkingLevel: 'low' } });
});

test('Gemini: non-thinking models get no thinking config; unsupported level retries without it', async () => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.generationConfig) return json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Thinking level is not supported for this model.' } });
    return sse(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n']);
  };
  let out = '';
  await streamAnswer('gemini', { apiKey: 'k', model: { id: 'gemini-2.0-flash', effortLow: false }, system: '', user: 'q', onDelta: (t) => (out += t) });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].generationConfig, undefined);
  await streamAnswer('gemini', { apiKey: 'k', model: { id: 'gemini-x', effortLow: true }, system: '', user: 'q', onDelta: (t) => (out += t) });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].generationConfig, undefined);
  assert.equal(out, 'okok');
});

test('Gemini: blocked prompts and responses are refusals', async () => {
  globalThis.fetch = async () => sse(['data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n']);
  await assert.rejects(
    streamAnswer('gemini', { apiKey: 'k', model: { id: 'gemini-2.5-flash' }, system: '', user: 'q', onDelta() {} }),
    (e) => e.kind === 'refused',
  );
  globalThis.fetch = async () => sse(['data: {"candidates":[{"content":{"parts":[{"text":"par"}]},"finishReason":"SAFETY"}]}\n\n']);
  await assert.rejects(
    streamAnswer('gemini', { apiKey: 'k', model: { id: 'gemini-2.5-flash' }, system: '', user: 'q', onDelta() {} }),
    (e) => e.kind === 'refused',
  );
});

test('Gemini: bad key, quota, and stream errors map to Renard states', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } });
  };
  await assert.rejects(
    streamAnswer('gemini', { apiKey: 'bad', model: { id: 'gemini-2.5-flash', effortLow: true }, system: '', user: 'q', onDelta() {} }),
    (e) => e.kind === 'keyInvalid',
  );
  assert.equal(calls, 1, 'a bad key is not retried');
  globalThis.fetch = async () => json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.' } });
  await assert.rejects(listModels('gemini', 'k'), (e) => e.kind === 'rateLimited');
  globalThis.fetch = async () => sse(['data: {"error":{"code":503,"status":"UNAVAILABLE","message":"The model is overloaded."}}\n\n']);
  await assert.rejects(
    streamAnswer('gemini', { apiKey: 'k', model: { id: 'gemini-2.5-flash' }, system: '', user: 'q', onDelta() {} }),
    (e) => e.kind === 'network' && e.message === 'The model is overloaded.',
  );
});

test('an attached image goes before the text in each provider request', async () => {
  const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
  const bodies = {};
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const name = u.includes('anthropic') ? 'anthropic' : u.includes('openai') ? 'openai' : 'gemini';
    bodies[name] = JSON.parse(init.body);
    if (name === 'anthropic') return sse(['data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n']);
    if (name === 'openai') return sse(['data: {"type":"response.completed","response":{}}\n\n']);
    return sse(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n']);
  };
  const common = { apiKey: 'k', system: 'sys', user: 'what is this?', images: [image], onDelta: () => {} };
  await streamAnswer('anthropic', { ...common, model: { id: 'claude-x', maxTokens: 4096 } });
  await streamAnswer('openai', { ...common, model: { id: 'gpt-4o' } });
  await streamAnswer('gemini', { ...common, model: { id: 'gemini-x' } });

  assert.deepEqual(bodies.anthropic.messages, [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        { type: 'text', text: 'what is this?' },
      ],
    },
  ]);
  assert.deepEqual(bodies.openai.input, [
    {
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
        { type: 'input_text', text: 'what is this?' },
      ],
    },
  ]);
  assert.deepEqual(bodies.gemini.contents, [
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, { text: 'what is this?' }] },
  ]);
});

test('without images, each request keeps its plain-text shape', async () => {
  const bodies = {};
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    bodies[u.includes('anthropic') ? 'anthropic' : 'openai'] = JSON.parse(init.body);
    return sse(['data: {"type":"response.completed","response":{}}\n\ndata: {"type":"message_stop"}\n\n']);
  };
  const common = { apiKey: 'k', system: 'sys', user: 'q', images: [], onDelta: () => {} };
  await streamAnswer('anthropic', { ...common, model: { id: 'claude-x' } });
  await streamAnswer('openai', { ...common, model: { id: 'gpt-4o' } });
  assert.deepEqual(bodies.anthropic.messages, [{ role: 'user', content: 'q' }]);
  assert.equal(bodies.openai.input, 'q');
});

test('a model that rejects images reports imageUnsupported; other 400s stay as they were', async () => {
  const image = { mediaType: 'image/png', data: 'AAAA' };
  const call = (message, images) => {
    globalThis.fetch = async () => json(400, { error: { message, type: 'invalid_request_error' } });
    return streamAnswer('openai', { apiKey: 'k', model: { id: 'gpt-4o' }, system: '', user: 'q', images, onDelta: () => {} });
  };
  await assert.rejects(call('Invalid content type. image_url is only supported by certain models.', [image]), { kind: 'imageUnsupported' });
  await assert.rejects(call('Image exceeds the 5 MB maximum.', [image]), { kind: 'unknown' });
  await assert.rejects(call('Invalid content type. image_url is only supported by certain models.', []), { kind: 'unknown' });
});

test('a stream that ends before the provider finishes is reported as cut off', async () => {
  const cases = [
    ['anthropic', { id: 'claude-x' }, 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Half an ans"}}\n\n'],
    ['openai', { id: 'gpt-4o' }, 'data: {"type":"response.output_text.delta","delta":"Half an ans"}\n\n'],
    ['gemini', { id: 'gemini-x' }, 'data: {"candidates":[{"content":{"parts":[{"text":"Half an ans"}]}}]}\n\n'],
  ];
  for (const [provider, model, body] of cases) {
    globalThis.fetch = async () => sse([body]);
    let out = '';
    await assert.rejects(
      streamAnswer(provider, { apiKey: 'k', model, system: '', user: 'q', onDelta: (t) => (out += t) }),
      (e) => e.kind === 'network' && /cut off/.test(e.message),
      provider,
    );
    assert.equal(out, 'Half an ans', provider);
  }
});

test('an answer that hits the output limit says so; a filtered one is a refusal', async () => {
  const run = (provider, model, body) => {
    globalThis.fetch = async () => sse([body]);
    return streamAnswer(provider, { apiKey: 'k', model, system: '', user: 'q', onDelta() {} });
  };
  assert.equal(
    (await run('anthropic', { id: 'claude-x' }, 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\ndata: {"type":"message_stop"}\n\n')).stopReason,
    'max_tokens',
  );
  assert.equal(
    (await run('openai', { id: 'gpt-4o' }, 'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n')).stopReason,
    'max_tokens',
  );
  assert.equal((await run('gemini', { id: 'gemini-x' }, 'data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"MAX_TOKENS"}]}\n\n')).stopReason, 'max_tokens');
  await assert.rejects(
    run('openai', { id: 'gpt-4o' }, 'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}\n\n'),
    { kind: 'refused' },
  );
  await assert.rejects(run('anthropic', { id: 'claude-x' }, 'event: error\ndata: upstream connect error\n\n'), (e) => e.kind === 'network' && e.message === 'upstream connect error');
});

test('a 400 is retried without optional fields only when it names one', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json(400, { error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } });
  };
  await assert.rejects(streamAnswer('anthropic', { apiKey: 'k', model: anthropicModel, system: '', user: 'q', onDelta() {} }), { status: 400 });
  assert.equal(calls, 1);
});

test('error text never shows as [object Object], and a Gemini error array is read', async () => {
  globalThis.fetch = async () => json(500, { error: { code: 'server_error' } });
  await assert.rejects(streamAnswer('openai', { apiKey: 'k', model: { id: 'gpt-4o' }, system: '', user: 'q', onDelta() {} }), (e) => !/object Object/.test(e.message));
  globalThis.fetch = async () => json(400, [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }]);
  await assert.rejects(streamAnswer('gemini', { apiKey: 'k', model: { id: 'gemini-x' }, system: '', user: 'q', onDelta() {} }), { kind: 'keyInvalid' });
});

test('a provider that stalls before or during an answer times out with an error', async () => {
  const { TIMEOUTS } = await import('../src/shared/providers.js');
  const saved = { ...TIMEOUTS };
  Object.assign(TIMEOUTS, { firstByteMs: 50, idleMs: 50 });
  try {
    // No response at all.
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    await assert.rejects(streamAnswer('anthropic', { apiKey: 'k', model: { id: 'claude-x' }, system: '', user: 'q', onDelta() {} }), (e) => e.kind === 'network' && /respond/.test(e.message));
    // Headers and one piece, then nothing.
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hal"}}\n\n'));
          },
        }),
        { status: 200 },
      );
    let out = '';
    await assert.rejects(streamAnswer('anthropic', { apiKey: 'k', model: { id: 'claude-x' }, system: '', user: 'q', onDelta: (t) => (out += t) }), (e) => e.kind === 'network' && /stopped arriving/.test(e.message));
    assert.equal(out, 'Hal');
    // The user's own Stop is still an abort, not a timeout.
    const ctl = new AbortController();
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    setTimeout(() => ctl.abort(), 10);
    await assert.rejects(streamAnswer('anthropic', { apiKey: 'k', model: { id: 'claude-x' }, system: '', user: 'q', signal: ctl.signal, onDelta() {} }), { kind: 'aborted' });
  } finally {
    Object.assign(TIMEOUTS, saved);
  }
});
