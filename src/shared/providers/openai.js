// The OpenAI API: model listing and streamed answers (Responses API).
import { ProviderError, classifyStreamError, request, sendWithOptional, readEvents, parseData, cutOff } from './http.js';

const BASE = 'https://api.openai.com';

function headers(apiKey) {
  return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
}

const INCLUDE = /^(gpt-|chatgpt-|o\d)/i;
const EXCLUDE =
  /(embedding|whisper|tts|dall-e|davinci|babbage|moderation|transcribe|realtime|audio|image|search|computer-use|instruct|sora|diarize)/i;

export function isOpenAIChatModel(id) {
  return INCLUDE.test(id) && !EXCLUDE.test(id);
}

function isReasoningModel(id) {
  return /^(o\d|gpt-5)/i.test(id) && !/chat/i.test(id);
}

export async function listModels(apiKey, { signal } = {}) {
  const body = await request(new URL('/v1/models', BASE), { headers: headers(apiKey), signal }, { json: true });
  return (body.data || [])
    .filter((m) => isOpenAIChatModel(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map((m) => ({ id: m.id, name: m.id, maxTokens: null, effortLow: false }));
}

// Images go before the question's text. Without images the input stays a
// plain string.
function input(user, images) {
  if (!images.length) return user;
  const parts = images.map((img) => ({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.data}` }));
  return [{ role: 'user', content: [...parts, { type: 'input_text', text: user }] }];
}

export async function streamAnswer({ apiKey, model, system, user, images, signal, onDelta }) {
  const base = { model: model.id, instructions: system, input: input(user, images), stream: true, store: false };
  const optional = {};
  if (isReasoningModel(model.id)) optional.reasoning = { effort: 'low' };

  const res = await sendWithOptional(
    (opts) =>
      request(new URL('/v1/responses', BASE), {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify({ ...base, ...opts }),
        signal,
      }),
    optional,
    /reasoning|effort/i,
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
      case 'response.incomplete': {
        const reason = (data.response && data.response.incomplete_details && data.response.incomplete_details.reason) || 'incomplete';
        // A filtered answer is a refusal; its partial text is discarded.
        if (reason === 'content_filter') throw new ProviderError('refused', 'The response was filtered.');
        stopReason = reason === 'max_output_tokens' ? 'max_tokens' : reason;
        break;
      }
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
  if (!stopReason) throw cutOff();
  return { stopReason };
}
