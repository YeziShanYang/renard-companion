// Answering a question: one port per question, opened by the page. The
// answer streams back over it, and closing the port cancels the request.
import '../shared/constants.js';
import '../shared/image.js';
import { loadSettings, hasOrigins } from '../shared/settings.js';
import { listModels, streamAnswer, ProviderError } from '../shared/providers.js';
import { SYSTEM_PROMPT, localSystemPrompt, trimChat, trimPage, buildUserMessage, turnFilter, clipStart, aimedAtModels } from '../shared/prompt.js';
import { engineRequest } from './engine-client.js';
import { forgetLocal } from './local-models.js';
import { update } from './store.js';

const R = globalThis.Renard;

export function serveAsk(port) {
  const controller = new AbortController();
  let open = true;
  const post = (m) => {
    if (open) port.postMessage(m);
  };
  port.onDisconnect.addListener(() => {
    open = false;
    controller.abort();
  });
  let asked = false;
  port.onMessage.addListener((msg) => {
    // One question per port: a second would stream into the same answer.
    if (!msg || msg.type !== 'ask' || asked) return;
    asked = true;
    answer(msg, post, controller.signal).then(
      (result) => post({ type: 'done', limited: Boolean(result && result.stopReason === 'max_tokens') }),
      (err) => {
        const e = err instanceof ProviderError ? err : new ProviderError('unknown', String(err?.message || err));
        if (e.kind !== 'aborted') post({ type: 'error', kind: e.kind, message: e.message, status: e.status });
      },
    );
  });
}

async function answer(msg, post, signal) {
  const s = await loadSettings();
  const provider = R.own(R.PROVIDERS, s.provider) || R.PROVIDERS.anthropic;
  if (provider.id === 'local') return answerLocally(s, msg, post, signal);
  const apiKey = s.apiKeys[provider.id];
  if (!apiKey) throw new ProviderError('keyMissing', 'No API key set');
  if (!R.isApiKey(apiKey)) throw new ProviderError('keyInvalid', 'That API key has characters a key never has.');
  if (!(await hasOrigins(provider.origins))) {
    throw new ProviderError('permission', `Renard does not have access to ${provider.origins[0]}`);
  }

  let model = s.models[provider.id];
  if (!model) {
    const list = await listModels(provider.id, apiKey, { signal });
    if (!list.length) throw new ProviderError('modelUnavailable', 'No models are available for this key.');
    model = list[0];
    await update('models', (models) => ({ ...models, [provider.id]: models[provider.id] || model }));
  }

  const { chat, page } = context(msg, post);

  const question = clipStart(String(msg.question || ''), 20000);
  if (msg.image && !R.isAttachedImage(msg.image)) throw new ProviderError('unknown', "The attached image couldn't be read. Remove it and try again.");
  const images = msg.image ? [{ mediaType: msg.image.mediaType, data: msg.image.data }] : [];
  return streamAnswer(provider.id, {
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    user: buildUserMessage(question, chat, page, { screenshot: images.length > 0 }),
    images,
    signal,
    onDelta: (text) => post({ type: 'delta', text }),
  });
}

// The chat or page text sent with a question, trimmed to the budget. Tells
// the page how much was included, and whether the text addresses AI models
// (aimed), which the bubble warns about.
function context(msg, post, limits = R.LIMITS) {
  let chat = null;
  let page = null;
  if (msg.page) {
    page = trimPage(msg.page, limits.pageChars);
    if (page) {
      const aimed = aimedAtModels(`${page.title}\n${page.text}`);
      post({ type: 'context', page: true, included: page.text.length, total: page.total, partial: page.partial, aimed });
    }
  } else if (msg.chat && Array.isArray(msg.chat.turns)) {
    chat = { ...trimChat(msg.chat.turns, limits), siteName: String(msg.chat.siteName || '').slice(0, 100) };
    const aimed = chat.turns.some((t) => aimedAtModels(t.text));
    post({ type: 'context', included: chat.turns.length, total: chat.total, partial: chat.partial, aimed });
  }
  return { chat, page };
}

async function answerLocally(s, msg, post, signal) {
  // The bubble turns screenshots off for the built-in model.
  if (msg.image) throw new ProviderError('unknown', "The built-in model can't read images. Ask without the screenshot, or pick an API-key provider in settings.");
  const model = R.own(R.LOCAL_MODELS, s.localModel.key) || R.LOCAL_MODELS['gemma-3-1b'];
  if (!R.localReady(s.localModel, model)) throw new ProviderError('localMissing', `Download ${model.name} in settings first.`);
  // The question and the chat or page share one budget: past it, Firefox's
  // WebGPU run fails (see R.LIMITS).
  const question = clipStart(String(msg.question || ''), 20000);
  const room = R.LIMITS.localChatChars - question.length;
  if (room < 0) {
    throw new ProviderError(
      'unknown',
      `That question is too long for the built-in model, which reads about ${R.LIMITS.localChatChars.toLocaleString('en-US')} characters at a time. Shorten it, or pick an API-key provider in settings.`,
    );
  }
  const ask = async (chars) => {
    const { chat, page } = context(msg, post, {
      chatChars: chars,
      turnChars: Math.min(R.LIMITS.localTurnChars, chars),
      pageChars: Math.min(R.LIMITS.localPageChars, chars),
    });
    // Stops generation when the model starts writing a made-up next turn,
    // except in answers about an attached chat (see turnFilter).
    const done = new AbortController();
    const filter = turnFilter((text) => post({ type: 'delta', text }), () => done.abort(), { cut: !chat });
    try {
      const result = await engineRequest(
        { type: 'generate', key: model.id, system: localSystemPrompt(chat, page), user: buildUserMessage(question, chat, page), maxNewTokens: 1024 },
        {
          signal: AbortSignal.any([signal, done.signal]),
          onEvent: (e) => {
            if (e.type === 'delta') filter.push(e.text);
            else if (e.type === 'loading') post({ type: 'loading' });
          },
        },
      );
      filter.end();
      return { stopReason: result && result.limited ? 'max_tokens' : 'end_turn' };
    } catch (err) {
      // The answer ended where the made-up turn began.
      if (filter.stopped && !signal.aborted) return { stopReason: 'end_turn' };
      throw err;
    }
  };
  try {
    try {
      return await ask(room);
    } catch (err) {
      // Characters only estimate tokens (code has more per character than
      // prose), so a prompt can still be too long for this GPU. The engine
      // refuses it before it runs, and the chat or page is cut to fit.
      if (err.kind !== 'tooLong' || !(msg.chat || msg.page) || !(err.tokens > 0)) throw err;
      return await ask(Math.floor(room * (err.limit / err.tokens) * 0.85));
    }
  } catch (err) {
    // The engine found the download missing from the cache, so it isn't
    // ready any more.
    if (err.kind === 'localMissing') await forgetLocal(model.id);
    if (err.kind === 'tooLong') {
      const reading = msg.page ? 'Read page' : 'Read chat';
      throw new ProviderError('unknown', `That's more than the built-in model can read at once. Shorten the question, or turn ${reading} off.`);
    }
    throw err;
  }
}
