// What every provider client shares: errors, requests with timeouts, the
// retry without optional fields, and reading a streamed answer.

// How long to wait for a provider: for the response to start, and between
// two pieces of a streamed answer. A stalled connection otherwise leaves the
// bubble thinking forever. (Exported so tests can shorten them.)
export const TIMEOUTS = { firstByteMs: 60000, idleMs: 90000 };

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
export function classifyStreamError(type) {
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

export function toProviderError(err) {
  if (err instanceof ProviderError) return err;
  if (err && err.name === 'AbortError') return new ProviderError('aborted', 'Request cancelled');
  return new ProviderError('network', (err && err.message) || 'Network error');
}

// The error in a failed response's body: { error: { message } } from all
// three providers, sometimes inside an array from Gemini, or a bare string.
function errorOf(body) {
  const b = Array.isArray(body) ? body[0] : body;
  return (b && typeof b === 'object' && b.error) || null;
}

// The response to a request, or with { json: true } its parsed body. The
// first-byte timer also covers reading an error body or a JSON body, which
// can stall too: aborting the signal cuts the read off.
export async function request(url, init, { json = false } = {}) {
  const late = new AbortController();
  const timer = setTimeout(() => late.abort(), TIMEOUTS.firstByteMs);
  const signal = init.signal ? AbortSignal.any([init.signal, late.signal]) : late.signal;
  const timedOut = () => late.signal.aborted && !(init.signal && init.signal.aborted);
  try {
    let res;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      if (timedOut()) throw new ProviderError('network', "The provider didn't respond within a minute. Try again.");
      throw toProviderError(err);
    }
    if (res.ok) {
      if (!json) return res;
      try {
        return await res.json();
      } catch (err) {
        if (timedOut()) throw new ProviderError('network', "The provider didn't respond within a minute. Try again.");
        throw toProviderError(err);
      }
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON or cut-off error body; fall back to the status line.
    }
    const err = errorOf(body);
    const text = typeof err === 'string' ? err : err && typeof err.message === 'string' ? err.message : '';
    const message = text || res.statusText || `HTTP ${res.status}`;
    throw new ProviderError(classifyHttpError(res.status, err ? { error: err } : null), message, { status: res.status });
  } finally {
    clearTimeout(timer);
  }
}

// Sends with optional parameters first. If the provider rejects the request
// with a message that names one of them (mentions), retries once without
// them. Covers models that do not accept a given optional field (effort,
// reasoning, fallbacks); any other 400 would only fail again.
export async function sendWithOptional(send, optional, mentions) {
  try {
    return await send(optional);
  } catch (err) {
    if (
      err instanceof ProviderError &&
      err.status === 400 &&
      err.kind !== 'keyInvalid' &&
      Object.keys(optional).length &&
      mentions.test(err.message)
    ) {
      return send({});
    }
    throw err;
  }
}

// ---- streamed answers (Server-Sent Events) ---------------------------------------

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

// The events of a streamed response as they arrive. Fails when the stream
// stalls.
export async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  for (;;) {
    let timer;
    const stalled = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ProviderError('network', 'The answer stopped arriving. Try again.')), TIMEOUTS.idleMs);
    });
    let chunk;
    try {
      chunk = await Promise.race([reader.read(), stalled]);
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const { value, done } = chunk;
    if (done) break;
    yield* parser.push(decoder.decode(value, { stream: true }));
  }
  yield* parser.push(decoder.decode());
  yield* parser.flush();
}

// An event's JSON data, or null for "[DONE]" and data that isn't JSON.
export function parseData(ev) {
  if (ev.data === '[DONE]') return null;
  try {
    return JSON.parse(ev.data);
  } catch {
    // An error event whose data isn't JSON still ends the answer.
    if (ev.event === 'error') throw new ProviderError('network', ev.data.slice(0, 300) || 'Stream error');
    return null;
  }
}

// A stream that ends before the provider says the answer is finished was
// cut off on the way (a dropped connection or a proxy timeout).
export function cutOff() {
  return new ProviderError('network', 'The answer was cut off before it finished. Try again.');
}
