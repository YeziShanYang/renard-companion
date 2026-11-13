import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SSEParser,
  classifyHttpError,
  isOpenAIChatModel,
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
    return sse(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n']);
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
    return sse([]);
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
