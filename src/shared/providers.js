// Anthropic, OpenAI, and Gemini clients over plain fetch: model listing and
// streamed answers. Used by the background script (answers) and the options
// page (model list, which doubles as the key check).
//
// Each provider's requests are in providers/<name>.js; what they share
// (errors, timeouts, the optional-field retry, the event stream reader) is
// in providers/http.js.
import * as anthropic from './providers/anthropic.js';
import * as openai from './providers/openai.js';
import * as gemini from './providers/gemini.js';
import { ProviderError, toProviderError } from './providers/http.js';

export { ANTHROPIC_VERSION } from './providers/anthropic.js';
export { isOpenAIChatModel } from './providers/openai.js';
export { isGeminiChatModel } from './providers/gemini.js';
export { TIMEOUTS, ProviderError, classifyHttpError, SSEParser } from './providers/http.js';

const CLIENTS = { anthropic, openai, gemini };

function client(provider) {
  if (!Object.prototype.hasOwnProperty.call(CLIENTS, provider)) throw new ProviderError('unknown', `Unknown provider: ${provider}`);
  return CLIENTS[provider];
}

// The models a key can use, newest first.
export async function listModels(provider, apiKey, { signal } = {}) {
  if (!apiKey) throw new ProviderError('keyMissing', 'No API key');
  return client(provider).listModels(apiKey, { signal });
}

// A rejected request that carried an image and names image support in its
// message ("image_url is only supported by certain models") comes from a
// model that can't read images.
function imageUnsupported(err) {
  return err.kind === 'unknown' && err.status === 400 && /support/i.test(err.message) && /image|vision|multimodal/i.test(err.message);
}

// Streams an answer, calling onDelta with each piece of text. params:
// { apiKey, model, system, user, images, signal, onDelta }, where an image
// is { mediaType, data } with the data in base64. Without images, every
// request keeps its plain-text shape.
export async function streamAnswer(provider, params) {
  if (!params.apiKey) throw new ProviderError('keyMissing', 'No API key');
  const images = Array.isArray(params.images) ? params.images : [];
  const args = { ...params, images };
  const stream = client(provider).streamAnswer;
  try {
    return await stream(args);
  } catch (err) {
    const e = toProviderError(err);
    if (images.length && imageUnsupported(e)) throw new ProviderError('imageUnsupported', e.message, { status: e.status });
    throw e;
  }
}
