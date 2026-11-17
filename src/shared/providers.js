// Anthropic, OpenAI, and Gemini clients over plain fetch: model listing and
// streamed answers. Used by the background script (answers) and the options
// page (model list, which doubles as the key check).

export const ANTHROPIC_VERSION = '2026-10-21';
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const OPENAI_BASE = 'https://api.openai.com';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

// Gemini finish reasons that mean the output was blocked; partial text from
// such a response is discarded like any other refusal.
const GEMINI_BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

// Models that accept server-side refusal fallbacks. When their safety
// classifiers decline a request, the API retries it on the model Anthropic
// recommends for that category instead of returning a refusal.
const ANTHROPIC_FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-mythos-5-2',
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const MAX_OUTPUT_TOKENS = 16000;

export class ProviderError extends Error {
  // kind: keyMissing | keyInvalid | modelUnavailable | imageUnsupported
  //       | rateLimited | network | permission | refused | aborted | unknown
  constructor(kind, message, { status = 0 } = {}) {
    super(message || kind);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

export function classifyHttpError(status, body) {
  const err = (body && body.error) || {};
  const message = (typeof err === 'string' ? err : err.message) || '';
  const code = (typeof err === 'object' && (err.code || err.type)) || '';
  if (status === 401 || status === 402 || status === 403) return 'keyInvalid';
  if (status === 404) return 'modelUnavailable';
  if (status === 429) return code === 'insufficient_quota' ? 'keyInvalid' : 'rateLimited';
  // Gemini reports a bad key as 400 INVALID_ARGUMENT ("API key not valid").
  if (status === 400 && /credit balance|billing|quota|api key/i.test(message)) return 'keyInvalid';
  // Only a missing model; "X is not supported for this model" is about an
  // optional field and is handled by the retry in sendWithOptional.
  if (status === 400 && /model/i.test(message) && /not found|does not exist|invalid model/i.test(message)) {
    return 'modelUnavailable';
  }
  if (status >= 500) return 'network';
  return 'unknown';
}

// Error types from mid-stream error events: Anthropic `type`, OpenAI `code`,
// and Gemini (Google RPC) `status`.
function classifyStreamError(type) {
  switch (type) {
    case 'rate_limit_error':
    case 'rate_limit_exceeded':
    case 'RESOURCE_EXHAUSTED':
      return 'rateLimited';
    case 'overloaded_error':
    case 'api_error':
    case 'server_error':
    case 'UNAVAILABLE':
    case 'INTERNAL':
    case 'DEADLINE_EXCEEDED':
      return 'network';
    case 'authentication_error':
    case 'permission_error':
    case 'insufficient_quota':
    case 'UNAUTHENTICATED':
    case 'PERMISSION_DENIED':
      return 'keyInvalid';
    case 'not_found_error':
    case 'model_not_found':
    case 'NOT_FOUND':
      return 'modelUnavailable';
    default:
      return 'unknown';
  }
}

// Incremental Server-Sent Events parser. push() returns complete events.
export class SSEParser {
  constructor() {
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += chunk;
    // Hold back a trailing \r: it may be the first half of a \r\n pair.
    let text = this.buffer;
    let held = '';
    if (text.endsWith('\r')) {
      held = '\r';
      text = text.slice(0, -1);
    }
    text = text.replace(/\r\n?/g, '\n');
    const events = [];
    let idx;
    while ((idx = text.indexOf('\n\n')) !== -1) {
      const ev = parseEvent(text.slice(0, idx));
      if (ev) events.push(ev);
      text = text.slice(idx + 2);
    }
    this.buffer = text + held;
    return events;
  }

  flush() {
    const ev = parseEvent(this.buffer.replace(/\r\n?/g, '\n'));
    this.buffer = '';
    return ev ? [ev] : [];
  }
}

function parseEvent(raw) {
  let event = 'message';
  const data = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    yield* parser.push(decoder.decode(value, { stream: true }));
  }
  yield* parser.push(decoder.decode());
  yield* parser.flush();
}

function parseData(ev) {
  if (ev.data === '[DONE]') return null;
  try {
    return JSON.parse(ev.data);
  } catch {
    return null;
  }
}

function toProviderError(err) {
  if (err instanceof ProviderError) return err;
  if (err && err.name === 'AbortError') return new ProviderError('aborted', 'Request cancelled');
  return new ProviderError('network', (err && err.message) || 'Network error');
}

async function request(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw toProviderError(err);
  }
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON error body; fall back to the status line.
    }
    const message = (body && body.error && (body.error.message || body.error)) || res.statusText || `HTTP ${res.status}`;
    throw new ProviderError(classifyHttpError(res.status, body), String(message), { status: res.status });
  }
  return res;
}

// Sends with optional parameters first; if the provider rejects the request
// as malformed, retries once without them. Covers models that do not accept
// a given optional field (effort, reasoning, fallbacks).
async function sendWithOptional(send, optional) {
  try {
    return await send(optional);
  } catch (err) {
    if (err instanceof ProviderError && err.status === 400 && err.kind !== 'keyInvalid' && Object.keys(optional).length) {
      return send({});
    }
    throw err;
  }
}

function anthropicHeaders(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    // Required by the Anthropic API for requests that carry a browser Origin.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

function openaiHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
}

const OPENAI_INCLUDE = /^(gpt-|chatgpt-|o\d)/i;
const OPENAI_EXCLUDE =
  /(embedding|whisper|tts|dall-e|davinci|babbage|moderation|transcribe|realtime|audio|image|search|computer-use|instruct|sora|diarize)/i;

export function isOpenAIChatModel(id) {
  return OPENAI_INCLUDE.test(id) && !OPENAI_EXCLUDE.test(id);
}

function isOpenAIReasoningModel(id) {
  return /^(o\d|gpt-5)/i.test(id) && !/chat/i.test(id);
}

function geminiHeaders(apiKey) {
  // The key goes in a header, not the ?key= query parameter, so it stays out
  // of URLs.
  return { 'x-goog-api-key': apiKey, 'content-type': 'application/json' };
}

const GEMINI_EXCLUDE = /(embedding|image|tts|audio|live|robotics|computer-use|veo|imagen|aqa)/i;

// Text-generation Gemini models, from a Models API entry.
export function isGeminiChatModel(m) {
  const id = String((m && m.name) || '').replace(/^models\//, '');
  return /^gemini-/i.test(id) && !GEMINI_EXCLUDE.test(id) && ((m && m.supportedGenerationMethods) || []).includes('generateContent');
}

function geminiVersion(id) {
  const m = id.match(/^gemini-(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : 0;
}

export async function listModels(provider, apiKey, { signal } = {}) {
  if (!apiKey) throw new ProviderError('keyMissing', 'No API key');
  if (provider === 'anthropic') {
    const models = [];
    let after = null;
    for (let page = 0; page < 10; page++) {
      const url = new URL('/v1/models', ANTHROPIC_BASE);
      url.searchParams.set('limit', '1000');
      if (after) url.searchParams.set('after_id', after);
      const res = await request(url, { headers: anthropicHeaders(apiKey), signal });
      const body = await res.json();
      for (const m of body.data || []) {
        models.push({
          id: m.id,
          name: m.display_name || m.id,
          maxTokens: Number(m.max_tokens) || null,
          effortLow: Boolean(m.capabilities && m.capabilities.effort && m.capabilities.effort.low && m.capabilities.effort.low.supported),
        });
      }
      if (!body.has_more || !body.last_id) break;
      after = body.last_id;
    }
    return models; // newest first, as the API returns them
  }
  if (provider === 'openai') {
    const res = await request(new URL('/v1/models', OPENAI_BASE), { headers: openaiHeaders(apiKey), signal });
    const body = await res.json();
    return (body.data || [])
      .filter((m) => isOpenAIChatModel(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .map((m) => ({ id: m.id, name: m.id, maxTokens: null, effortLow: false }));
  }
  if (provider === 'gemini') {
    const models = [];
    let token = null;
    for (let page = 0; page < 10; page++) {
      const url = new URL('/v1beta/models', GEMINI_BASE);
      url.searchParams.set('pageSize', '1000');
      if (token) url.searchParams.set('pageToken', token);
      const res = await request(url, { headers: geminiHeaders(apiKey), signal });
      const body = await res.json();
      for (const m of body.models || []) {
        if (!isGeminiChatModel(m)) continue;
        const id = m.name.replace(/^models\//, '');
        models.push({
          id,
          name: m.displayName || id,
          maxTokens: Number(m.outputTokenLimit) || null,
          effortLow: m.thinking === true,
        });
      }
      if (!body.nextPageToken) break;
      token = body.nextPageToken;
    }
    // Newest family first (gemini-4 before gemini-3.5 before gemini-2.5);
    // within a family, keep the API's order.
    return models
      .map((m, i) => ({ m, i }))
      .sort((a, b) => geminiVersion(b.m.id) - geminiVersion(a.m.id) || a.i - b.i)
      .map((x) => x.m);
  }
  throw new ProviderError('unknown', `Unknown provider: ${provider}`);
}

// Each request puts the attached images before the question's text, the
// order Anthropic recommends. An image is { mediaType, data }, with the data
// in base64. Without images, every request keeps its plain-text shape.
function anthropicContent(user, images) {
  if (!images.length) return user;
  const parts = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }));
  return [...parts, { type: 'text', text: user }];
}

function openaiInput(user, images) {
  if (!images.length) return user;
  const parts = images.map((img) => ({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.data}` }));
  return [{ role: 'user', content: [...parts, { type: 'input_text', text: user }] }];
}

function geminiParts(user, images) {
  return [...images.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data } })), { text: user }];
}

async function streamAnthropic({ apiKey, model, system, user, images, signal, onDelta }) {
  const base = {
    model: model.id,
    max_tokens: Math.min(MAX_OUTPUT_TOKENS, model.maxTokens || 4096),
    system,
    messages: [{ role: 'user', content: anthropicContent(user, images) }],
    stream: true,
  };
  const optional = {};
  // A quick-help panel favors speed; low effort keeps answers prompt.
  if (model.effortLow) optional.output_config = { effort: 'low' };
  if (ANTHROPIC_FALLBACK_MODELS.has(model.id)) optional.fallbacks = 'default';

  const res = await sendWithOptional((opts) => {
    const headers = anthropicHeaders(apiKey);
    if (opts.fallbacks) headers['anthropic-beta'] = FALLBACK_BETA;
    return request(new URL('/v1/messages', ANTHROPIC_BASE), {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...base, ...opts }),
      signal,
    });
  }, optional);

  let stopReason = null;
  for await (const ev of readEvents(res)) {
    const data = parseData(ev);
    if (!data) continue;
    if (data.type === 'content_block_delta' && data.delta && data.delta.type === 'text_delta') {
      onDelta(data.delta.text);
    } else if (data.type === 'message_delta' && data.delta && data.delta.stop_reason) {
      stopReason = data.delta.stop_reason;
    } else if (data.type === 'error') {
      const e = data.error || {};
      throw new ProviderError(classifyStreamError(e.type), e.message || 'Stream error');
    }
  }
  // Text from a refused attempt is partial; the caller discards it.
  if (stopReason === 'refusal') throw new ProviderError('refused', 'The model declined this request.');
  return { stopReason };
}

async function streamOpenAI({ apiKey, model, system, user, images, signal, onDelta }) {
  const base = { model: model.id, instructions: system, input: openaiInput(user, images), stream: true, store: false };
  const optional = {};
  if (isOpenAIReasoningModel(model.id)) optional.reasoning = { effort: 'low' };

  const res = await sendWithOptional(
    (opts) =>
      request(new URL('/v1/responses', OPENAI_BASE), {
        method: 'POST',
        headers: openaiHeaders(apiKey),
        body: JSON.stringify({ ...base, ...opts }),
        signal,
      }),
    optional,
  );

  let stopReason = null;
  let gotText = false;
  let refused = false;
  for await (const ev of readEvents(res)) {
    const data = parseData(ev);
    if (!data) continue;
    switch (data.type) {
      case 'response.output_text.delta':
        if (data.delta) {
          gotText = true;
          onDelta(data.delta);
        }
        break;
      case 'response.refusal.delta':
        refused = true;
        break;
      case 'response.completed':
        stopReason = 'end_turn';
        break;
      case 'response.incomplete':
        stopReason = (data.response && data.response.incomplete_details && data.response.incomplete_details.reason) || 'incomplete';
        break;
      case 'response.failed': {
        const e = (data.response && data.response.error) || {};
        throw new ProviderError(classifyStreamError(e.code), e.message || 'The response failed.');
      }
      case 'error':
        throw new ProviderError(classifyStreamError(data.code || (data.error && data.error.code)), data.message || 'Stream error');
      default:
        break;
    }
  }
  if (refused && !gotText) throw new ProviderError('refused', 'The model declined this request.');
  return { stopReason };
}

async function streamGemini({ apiKey, model, system, user, images, signal, onDelta }) {
  const base = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: geminiParts(user, images) }],
  };
  const optional = {};
  if (model.effortLow) optional.generationConfig = { thinkingConfig: { thinkingLevel: 'low' } };

  const url = new URL(`/v1beta/models/${encodeURIComponent(model.id)}:streamGenerateContent`, GEMINI_BASE);
  url.searchParams.set('alt', 'sse');
  const res = await sendWithOptional(
    (opts) => request(url, { method: 'POST', headers: geminiHeaders(apiKey), body: JSON.stringify({ ...base, ...opts }), signal }),
    optional,
  );

  let finish = null;
  for await (const ev of readEvents(res)) {
    const data = parseData(ev);
    if (!data) continue;
    if (data.error) {
      throw new ProviderError(classifyStreamError(data.error.status), data.error.message || 'Stream error');
    }
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      throw new ProviderError('refused', `The request was blocked (${data.promptFeedback.blockReason}).`);
    }
    const candidate = data.candidates && data.candidates[0];
    if (!candidate) continue;
    for (const part of (candidate.content && candidate.content.parts) || []) {
      if (part.text && !part.thought) onDelta(part.text);
    }
    if (candidate.finishReason) finish = candidate.finishReason;
  }
  if (GEMINI_BLOCKED.has(finish)) throw new ProviderError('refused', `The response was blocked (${finish}).`);
  return { stopReason: finish === 'STOP' ? 'end_turn' : finish ? finish.toLowerCase() : null };
}

// A rejected request that carried an image and names image support in its
// message ("image_url is only supported by certain models") comes from a
// model that can't read images.
function imageUnsupported(err) {
  return err.kind === 'unknown' && err.status === 400 && /support/i.test(err.message) && /image|vision|multimodal/i.test(err.message);
}

export async function streamAnswer(provider, params) {
  if (!params.apiKey) throw new ProviderError('keyMissing', 'No API key');
  const images = Array.isArray(params.images) ? params.images : [];
  const args = { ...params, images };
  try {
    if (provider === 'anthropic') return await streamAnthropic(args);
    if (provider === 'openai') return await streamOpenAI(args);
    if (provider === 'gemini') return await streamGemini(args);
  } catch (err) {
    const e = toProviderError(err);
    if (images.length && imageUnsupported(e)) throw new ProviderError('imageUnsupported', e.message, { status: e.status });
    throw e;
  }
  throw new ProviderError('unknown', `Unknown provider: ${provider}`);
}
