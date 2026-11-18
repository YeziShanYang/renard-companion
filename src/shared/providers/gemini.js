// The Gemini API: model listing and streamed answers
// (streamGenerateContent with alt=sse).
import { ProviderError, classifyStreamError, request, sendWithOptional, readEvents, parseData, cutOff } from './http.js';

const BASE = 'https://generativelanguage.googleapis.com';

// Finish reasons that mean the output was blocked; partial text from such a
// response is discarded like any other refusal.
const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

function headers(apiKey) {
  // The key goes in a header, not the ?key= query parameter, so it stays out
  // of URLs.
  return { 'x-goog-api-key': apiKey, 'content-type': 'application/json' };
}

const EXCLUDE = /(embedding|image|tts|audio|live|robotics|computer-use|veo|imagen|aqa)/i;

// Text-generation Gemini models, from a Models API entry.
export function isGeminiChatModel(m) {
  const id = String((m && m.name) || '').replace(/^models\//, '');
  return /^gemini-/i.test(id) && !EXCLUDE.test(id) && ((m && m.supportedGenerationMethods) || []).includes('generateContent');
}

function version(id) {
  const m = id.match(/^gemini-(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : 0;
}

export async function listModels(apiKey, { signal } = {}) {
  const models = [];
  let token = null;
  for (let page = 0; page < 10; page++) {
    const url = new URL('/v1beta/models', BASE);
    url.searchParams.set('pageSize', '1000');
    if (token) url.searchParams.set('pageToken', token);
    const body = await request(url, { headers: headers(apiKey), signal }, { json: true });
    for (const m of body.models || []) {
      if (!isGeminiChatModel(m)) continue;
      const id = m.name.replace(/^models\//, '');
      models.push({
        id,
        name: m.displayName || id,
        maxTokens: Number(m.outputTokenLimit) || null,
        // thinkingLevel is for Gemini 3 and later; earlier thinking models
        // reject it.
        effortLow: m.thinking === true && version(id) >= 3,
      });
    }
    if (!body.nextPageToken) break;
    token = body.nextPageToken;
  }
  // Newest family first (gemini-4 before gemini-3.5 before gemini-2.5);
  // within a family, keep the API's order.
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => version(b.m.id) - version(a.m.id) || a.i - b.i)
    .map((x) => x.m);
}

// Images go before the question's text.
function parts(user, images) {
  return [...images.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data } })), { text: user }];
}

export async function streamAnswer({ apiKey, model, system, user, images, signal, onDelta }) {
  const base = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: parts(user, images) }],
  };
  const optional = {};
  if (model.effortLow) optional.generationConfig = { thinkingConfig: { thinkingLevel: 'low' } };

  const url = new URL(`/v1beta/models/${encodeURIComponent(model.id)}:streamGenerateContent`, BASE);
  url.searchParams.set('alt', 'sse');
  const res = await sendWithOptional(
    (opts) => request(url, { method: 'POST', headers: headers(apiKey), body: JSON.stringify({ ...base, ...opts }), signal }),
    optional,
    /thinking/i,
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
  if (BLOCKED.has(finish)) throw new ProviderError('refused', `The response was blocked (${finish}).`);
  if (!finish) throw cutOff();
  return { stopReason: finish === 'STOP' ? 'end_turn' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish.toLowerCase() };
}
