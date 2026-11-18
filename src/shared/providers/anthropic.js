// The Anthropic API: model listing and streamed answers (Messages API).
import { ProviderError, classifyStreamError, request, sendWithOptional, readEvents, parseData, cutOff } from './http.js';

export const ANTHROPIC_VERSION = '2026-10-21';
const BASE = 'https://api.anthropic.com';

// Models that accept server-side refusal fallbacks. When their safety
// classifiers decline a request, the API retries it on the model Anthropic
// recommends for that category instead of returning a refusal.
const FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-mythos-5-2',
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const MAX_OUTPUT_TOKENS = 16000;

function headers(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    // Required by the Anthropic API for requests that carry a browser Origin.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

export async function listModels(apiKey, { signal } = {}) {
  const models = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const url = new URL('/v1/models', BASE);
    url.searchParams.set('limit', '1000');
    if (after) url.searchParams.set('after_id', after);
    const body = await request(url, { headers: headers(apiKey), signal }, { json: true });
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

// Images go before the question's text, the order Anthropic recommends.
// Without images the content stays a plain string.
function content(user, images) {
  if (!images.length) return user;
  const parts = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }));
  return [...parts, { type: 'text', text: user }];
}

export async function streamAnswer({ apiKey, model, system, user, images, signal, onDelta }) {
  const base = {
    model: model.id,
    max_tokens: Math.min(MAX_OUTPUT_TOKENS, model.maxTokens || 4096),
    system,
    messages: [{ role: 'user', content: content(user, images) }],
    stream: true,
  };
  const optional = {};
  // A quick-help panel favors speed; low effort keeps answers prompt.
  if (model.effortLow) optional.output_config = { effort: 'low' };
  if (FALLBACK_MODELS.has(model.id)) optional.fallbacks = 'default';

  const res = await sendWithOptional((opts) => {
    const h = headers(apiKey);
    if (opts.fallbacks) h['anthropic-beta'] = FALLBACK_BETA;
    return request(new URL('/v1/messages', BASE), {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ ...base, ...opts }),
      signal,
    });
  }, optional, /effort|output_config|fallback/i);

  let stopReason = null;
  let finished = false;
  for await (const ev of readEvents(res)) {
    const data = parseData(ev);
    if (!data) continue;
    if (data.type === 'content_block_delta' && data.delta && data.delta.type === 'text_delta') {
      onDelta(data.delta.text);
    } else if (data.type === 'message_delta' && data.delta && data.delta.stop_reason) {
      stopReason = data.delta.stop_reason;
    } else if (data.type === 'message_stop') {
      finished = true;
    } else if (data.type === 'error') {
      const e = data.error || {};
      throw new ProviderError(classifyStreamError(e.type), e.message || 'Stream error');
    }
  }
  // Text from a refused attempt is partial; the caller discards it.
  if (stopReason === 'refusal') throw new ProviderError('refused', 'The model declined this request.');
  if (!finished) throw cutOff();
  return { stopReason: stopReason === 'max_tokens' ? 'max_tokens' : stopReason };
}
