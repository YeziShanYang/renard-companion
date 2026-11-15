# Renard privacy policy

Last updated: November 14, 2026

Renard is a browser extension that shows a pixel-art fox on claude.ai,
chatgpt.com, and other websites you add, and answers questions using an AI provider account that you supply
(Anthropic, OpenAI, or Google Gemini) or a built-in model that runs on your own
computer. This policy describes what data Renard handles and where it goes.

## Summary

Renard has no server. Nothing you type or read is sent to the developer of
Renard. Your questions, and the page's conversation when you turn on **Read
chat**, go directly from your browser to the AI provider you chose. With the
built-in model, they never leave your computer.

## What Renard handles

| Data | When | Where it goes | Where it is kept |
| --- | --- | --- | --- |
| Your API key | When you enter it in Renard's settings | Sent only to your chosen provider, to authenticate each request | Your browser's extension storage, on your device, unencrypted |
| Your question | When you ask Renard something | Your chosen provider | Not stored; shown on the page until it is cleared or reloaded |
| The conversation on the page (chat messages and other page text) | Only when you send a question with **Read chat** on | Your chosen provider, with your question | Not stored |
| On a website you added: the page's visible text, title, and address (without its query string or fragment) | Only when you send a question with **Read page** on | Your chosen provider, with your question | Not stored |
| Websites you added | When you turn Renard on for a site in its toolbar menu | Nowhere | Your browser's extension storage, on your device |
| The provider's answer | When it arrives | Shown on the page | Not stored; shown until cleared or reloaded |
| Settings (provider, model, sites, display options, Renard's position and bubble size) | When you change them | Nowhere | Your browser's extension storage, on your device |
| Built-in model files | When you click Download in settings | Downloaded from Hugging Face (huggingface.co); no question or chat is sent | Your browser's extension storage, until you delete them in settings or uninstall |

**Read chat** (called **Read page** on websites you add) starts on. You can
turn it off in Renard's bubble, and Renard remembers your choice.

Long conversations are trimmed to their most recent part, and long pages to
their beginning, before they are sent, and Renard says when it did so.

## Third parties

Requests go to the provider you select, under that provider's own terms and
privacy policy:

- Anthropic: https://www.anthropic.com/legal/privacy
- OpenAI: https://openai.com/policies/privacy-policy (Renard asks OpenAI not to
  store responses, with `store: false`)
- Google Gemini API: https://ai.google.dev/gemini-api/terms

The site you are on and the provider are independent. A conversation from
chatgpt.com can be sent to Anthropic or Google, and one from claude.ai to
OpenAI or Google.

On the Gemini API's free tier, Google's terms allow it to use submitted content
and responses to improve its products, and human reviewers may read them.
Requests on a paid Gemini plan are not used for product improvement.

## What Renard does not do

- It has no analytics, tracking, or advertising.
- It does not sell, share, or transfer your data to anyone other than the
  provider you choose, and only to answer your question.
- It does not read pages in the background. It reads the conversation or page
  text only at the moment you send a question with **Read chat** on. (To stay
  out of the way, it does watch the page's layout and color theme, which it
  never sends anywhere.)
- It runs only on claude.ai, chatgpt.com, chat.openai.com, and secure (https)
  websites you add one at a time, and only on the sites you have turned on.

## What the website can see

Renard's bubble is drawn inside the page you are on. Like anything else typed
on that page, what you type into Renard and the answers it shows can be
observed by the website's own scripts. Your API key is never on the page. Add
Renard only to websites you trust with your questions.

## Built-in model

When you choose the built-in model, Renard runs Gemma on your computer's
graphics chip. Your questions, the conversation it reads, and its answers are
processed only on your device. The model files come from Hugging Face, pinned
to a fixed published version of each model, and Hugging Face
receives an ordinary download request (as for any file you download) but none
of your content. Gemma models are provided by Google under their own terms.

## Permissions

- **Storage:** to keep your settings and API key on your device.
- **Unlimited storage:** so the browser keeps the built-in model's files
  instead of clearing them when space runs low.
- **Offscreen documents (Chrome only):** to run the built-in model in a hidden
  extension page, which has access to the graphics chip.
- **Access to claude.ai, chatgpt.com, and chat.openai.com:** to show the fox and
  read the conversation when you ask with **Read chat** on.
- **Scripting, active tab, and optional access to other websites:** when you
  turn Renard on for a website in its toolbar menu, Renard asks your browser
  for access to that one site and shows the fox there. Removing the site
  gives the access back.
- **Access to api.anthropic.com, api.openai.com, and
  generativelanguage.googleapis.com:** to send your question to the provider
  you chose.

## Removing your data

Remove your API key in Renard's settings at any time. Uninstalling Renard
deletes its settings and key from your browser. Data already sent to a provider
is governed by that provider's policy.

## Contact

Questions about this policy or Renard's handling of data: open an issue at
https://github.com/YeziShanYang/renard-companion/issues.
