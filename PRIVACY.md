# Renard privacy policy

Last updated: November 16, 2026

Renard is a browser extension. It shows a pixel-art fox on claude.ai,
chatgpt.com, and websites you add (or every website, if you turn that on), and
answers your questions with your own AI provider account (Anthropic, OpenAI, or
Google Gemini) or with a built-in model on your computer.

Renard has no server. Nothing you type or read is sent to Renard's developer.

## What Renard sends

When you ask a question, it goes directly from your browser to the provider you
chose. If Read chat is on, the conversation on the page goes with it. On a
website you added, the same switch is called Read page. It sends the page's
visible text, its title, and its address without the query string, fragment,
or path parameters. Text the page hides from view and button labels are left
out. Renard trims long conversations to their most recent part and long pages
to their beginning, and tells you when it does.

Read chat starts on. You can turn it off in Renard's bubble, and Renard
remembers your choice.

You can also attach an image to a question: a screenshot of an area of the
page, taken with the camera button in the bubble, or a picture you paste or
drop into the question box. The image goes to the provider you chose with that
one question. Renard scales it down to at most 1568 pixels on its longest side
before sending it. The built-in model reads text only, so Renard doesn't
attach images while it's selected.

Renard reads the conversation or page text only at the moment you send a
question with Read chat on. It takes a screenshot only after you click the
camera button and choose an area, and it hides the fox and the bubble first so
they aren't in the image. It doesn't read pages in the background. It does
watch the page's layout and color theme, to keep out of the way of the site's
content and match its light or dark theme. That information is never sent
anywhere.

Your API key is sent only to its provider, to authenticate your requests.

With the built-in model, your questions and chats don't leave your computer at
all (see "Built-in model" below).

## What Renard keeps on your device

Your settings (provider, model, display options, the websites you added, where
the fox sits, and the bubble's size) are kept in your browser's extension
storage on your device and aren't sent anywhere. Built-in model files you
download are kept there too, until you delete them in settings or uninstall
Renard.

Your API key is also kept in extension storage, unencrypted. That's standard
for extensions where you bring your own key, but it means anyone with access to
your browser profile could read it.

Renard doesn't store your questions, the answers, page content, or images. A
question and its answer stay in the bubble until you clear them or reload the
page. An image you attached but haven't sent yet stays until you remove it,
clear the bubble, or reload the page.

## Built-in model

When you choose the built-in model, Renard runs Gemma on your computer's
graphics chip. Your questions, the conversation it reads, and its answers are
processed only on your device.

Renard downloads the model files once from Hugging Face (huggingface.co),
always at a fixed published version of each model. Hugging Face gets an
ordinary download request, as it would for any file you download, but none of
your questions or chats. Gemma models are provided by Google under their own
terms.

## AI providers

Requests to a provider fall under that provider's own terms and privacy policy:

- Anthropic: https://www.anthropic.com/legal/privacy
- OpenAI: https://openai.com/policies/privacy-policy
- Google Gemini API: https://ai.google.dev/gemini-api/terms

Renard asks OpenAI not to store responses (`store: false`).

On the Gemini API's free tier, Google's terms allow it to use the content you
send and the responses to improve its products, and human reviewers may read
them. Requests on a paid Gemini plan are not used for product improvement.

The site you're on and the provider you use are independent. A conversation
from chatgpt.com can be sent to Anthropic or Google, and one from claude.ai to
OpenAI or Google.

## What the website can see

Renard's bubble sits on the page, but your question, the answer, and the text
box are in a separate extension frame. Browsers don't let a website's scripts
read or control that frame, so the website can't see what you type into Renard
or the answers it shows. The website can tell that Renard is there and where
the fox and bubble are. While you choose an area for a screenshot, the website
can see the pointer move over Renard's overlay, as it can see any mouse
movement, but the screenshot itself goes from the browser to Renard and never
passes through the page. Your API key is never on the page.

## What Renard doesn't do

Renard has no analytics, tracking, or advertising. It doesn't sell, share, or
transfer your data to anyone other than the provider you choose, and then only
to answer your question.

It runs only on claude.ai, chatgpt.com, chat.openai.com, and secure (https)
websites you add one at a time, or on every secure website if you turn on
Every website in settings. On each of these, it runs only if you've turned it
on. Even on every website, it reads a page only when you send a question with
Read page on.

## Permissions

- Storage, to keep your settings and API key on your device.
- Unlimited storage, so the browser keeps the built-in model's files instead
  of clearing them when space runs low.
- Offscreen documents (Chrome only), to run the built-in model in a hidden
  extension page with access to the graphics chip.
- Access to claude.ai, chatgpt.com, and chat.openai.com, to show the fox and
  read the conversation when you ask with Read chat on.
- Scripting, active tab, and optional access to other websites. When you turn
  Renard on for a website from its toolbar menu, Renard asks your browser for
  access to that one site and shows the fox there. Removing the site gives the
  access back. If you turn on Every website in settings, Renard asks for
  access to all secure websites and shows the fox on each of them. Turning it
  off stops Renard on the sites you didn't add. Firefox also gets that access
  back. Chrome keeps it until you remove it in its extension settings.
- Access to api.anthropic.com, api.openai.com, and
  generativelanguage.googleapis.com, to send your question to the provider you
  chose.
- Optional access to all websites, which Renard asks for the first time you
  click the camera button. Browsers let an extension take a screenshot of a
  page only with this access. Renard uses it to capture the area you choose,
  when you choose it, and it doesn't make Renard run on any other site. You can
  take it back in your browser's extension settings. Pasting or dropping an
  image works without it.

## Removing your data

You can remove your API key, and delete downloaded model files, in Renard's
settings at any time. Uninstalling Renard deletes its settings and key from
your browser. Anything already sent to a provider is covered by that
provider's policy.

## Contact

If you have questions about this policy or how Renard handles data, open an
issue at https://github.com/YeziShanYang/renard-companion/issues.
