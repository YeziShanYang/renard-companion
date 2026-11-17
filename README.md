# Renard

## Introduction

<!-- Introduction: to be written by the owner -->

## What it does

![Renard's answer bubble open beside the fox on a dark page, answering "why 256 per token vector"](docs/screenshot.webp)

Renard puts a pixel-art fox in the side margins of claude.ai and chatgpt.com,
and you can turn it on for other sites too, one at a time or all at once. Click
the fox to ask about the page, and the answer streams into a large reading
panel. Between questions it wanders around and eventually naps.

You don't need an API key. Renard can run Gemma, Google's open model, on your
graphics chip. After a one-time download in settings it works offline, and your
questions never leave your computer. For a bigger model, add an Anthropic,
OpenAI, or Gemini key instead.

With Read chat on (the default), the conversation on the page goes along with
your question, for requests like "summarize this chat". On other sites the same
switch is called Read page and sends the page's text. Most text a page hides
from view is left out. If what's sent has text aimed at AI assistants, such as
"ignore the user's question", the bubble says so, because models (the small
built-in one especially) can follow it.

To ask about something on screen, click the camera in the bubble and drag over
that area, or paste or drop an image into the question box. The image goes
with your next question, with or without the chat. The first camera click asks
your browser for access to all websites, which browsers require before an
extension can take a screenshot. Images work with the Anthropic, OpenAI, and
Gemini models. The built-in model reads text only.

The fox's lines (`src/lines.json`) and animations are scripted. The model only
writes answers and has no persona.

Renard runs in Firefox, its main target, and in Chrome. It isn't on the add-on
stores yet, so for now you load it from source.

## Setup

You need Node.js 20 or later. Renard runs in Firefox 142 or later and in
Chrome 116 or later (or another Chromium-based browser of that version).

```sh
npm install
```

`npm install` also copies the built-in model's engine (Transformers.js and ONNX
Runtime Web, about 28 MB) into the git-ignored `src/vendor/`, along with KaTeX
and highlight.js (under 1 MB), which format math and code in answers. Renard doesn't
need any dependency's install scripts. To skip them, run
`npm ci --ignore-scripts && npm run vendor` instead.

### Sprite sheet

The fox art is "2D Pixel Art Fox Sprites" by Elthen. The sheet isn't in this
repo because its license doesn't allow redistributing the art. Get the pack
from Elthen's itch.io page and save the sheet as
`src/assets/fox-sprite-sheet.png`. It should be 448×224 px, with 32×32 frames in
14 columns and 7 rows and the fox facing right. Without the sheet, Renard still
works and shows a static placeholder fox.

The toolbar icon doesn't come from the sheet. `scripts/make-icons.mjs` draws an
original fox head for it, and the generated icons are committed. Run
`npm run icons` after editing that art.

### Firefox

```sh
npm start
```

This opens Firefox with Renard loaded through `web-ext` and reloads the
extension when files change. To load it into your own profile instead, open
`about:debugging#/runtime/this-firefox`, click Load Temporary Add-on, and pick
`src/manifest.json`. Firefox removes it on restart.

Firefox treats host access as optional for Manifest V3 extensions. If the
toolbar icon has a `!` badge, open Renard's settings and click Allow access for
each site and for the API.

### Chrome

Chrome can't load `src/` directly because its manifest is written for Firefox.
Build a Chrome copy first:

```sh
npm run build:chrome
```

Then open `chrome://extensions`, turn on Developer mode, click Load unpacked,
and choose `dist/chrome/`. After changing files, run `npm run build:chrome`
again and click reload. `npm run start:chrome` builds it and opens a fresh
Chrome profile with Renard loaded.

### First run

Settings opens when you install, and you can reopen it from the toolbar menu.
To use an API, pick a provider and paste a key. Renard checks the key by
loading the provider's model list, and then you choose a model. To skip the
key, pick Built-in and download Gemma.

## Built-in model

The Built-in provider runs Gemma on your graphics chip through WebGPU. The
model downloads once from Hugging Face into the browser's extension storage and
works offline after that. Settings shows how much space it takes and can delete
it.

There are two models:

- Gemma 3 1B (default): 0.8 GB in Chrome, 0.9 GB in Firefox. Quick and light,
  good for short questions and summaries.
- Gemma 4 E2B: 3.1 GB in Chrome, 3.6 GB in Firefox. Noticeably smarter, but it
  needs about 5 GB of free memory.

WebGPU is required. That means Chrome 116 or later, or Firefox 147 or later on
Apple Silicon Macs and Windows. Firefox doesn't support WebGPU on Intel Macs or
Linux yet.

The Firefox downloads are larger because Firefox gets the `q4` builds. Its
WebGPU rejects a shader in the `q4f16` builds that Chrome uses.

In testing on an Apple Silicon Mac, Gemma 3 1B started answering in about half a
second and wrote about 8 tokens per second in Firefox. Chrome was faster. Read
chat sends less of the conversation to the built-in model than to the API
providers.

## Using Renard

    Click the fox     open the bubble
    Enter             ask
    Shift+Enter       new line
    Esc or ✕          close the bubble
    Alt+Shift+F       open or close the bubble
    Alt+Shift+H       hide or show Renard

The expand button opens a larger reading view. Drag any corner of the bubble to
resize it, and Renard remembers the size. Copy and Clear buttons appear once
there's an answer.

You can drag the fox anywhere. When you let go, it runs back to the nearest side
margin. Renard keeps track of the side and height for each site.

Clicking the toolbar icon opens a small menu:

- Show Renard sends the fox home on every tab, or brings it back. It's on by
  default.
- On this site turns Renard on or off for the site in the current tab. The
  first time, the browser asks for access to just that site. Renard then shows
  up right away and on every later visit. Only https sites can be added, and
  you can remove them in settings under Sites.
- Open settings goes to the settings page.

To have Renard on every https site, turn on Every website in settings under
Sites. The browser asks once for access to all websites. While it's on, the On
this site switch turns Renard off for just that site. Turning Every website off
stops Renard on the sites you didn't add. Firefox also gets the access back. In
Chrome it stays granted until you remove it in the browser's extension
settings, because Chrome can't take back access to all websites without taking
back claude.ai and the AI providers too.

On macOS, Alt is Option. To change the shortcuts, go to `about:addons` → gear
menu → Manage Extension Shortcuts in Firefox, or to
`chrome://extensions/shortcuts` in Chrome. Renard picks up the new keys.

The shortcuts also work while you're typing in the bubble or in the site's
message box. A focused text field would normally take the key first, so Renard
listens for the keys itself.

## Privacy

There's no Renard server. Questions go straight from your browser to the
provider you picked, and with the built-in model they don't leave your
computer. The page's chat or text is read only when you send a question with
Read chat on, and a screenshot is taken only when you click the camera and pick
an area. Neither is stored.

API keys are stored unencrypted in an IndexedDB database of the extension's own
origin, which Renard's page scripts and the pages themselves can't open. Only
the background script and the settings page read them. See
[PRIVACY.md](PRIVACY.md) for the full policy.

## How it works

```
src/
  manifest.json          MV3, written for Firefox; the Chrome build swaps in a service worker
  background/            API calls, settings, asset delivery, badge, shortcuts
  shared/                constants, settings access, provider clients, prompt, image scaling
  engine/                built-in model (Transformers.js on WebGPU)
  content/               on-page UI: the fox, the bubble's outline, the screenshot picker (closed Shadow DOM)
    adapters/            per-site chat reading, composer location, theme; web.js reads any other page
  bubble/                the bubble's contents, in an extension frame
  popup/                 toolbar menu (show Renard, this site, settings)
  options/               settings page
  lines.json             canned fox lines
  fonts/                 Silkscreen (SIL Open Font License)
  icons/                 toolbar icons (original fox head, from scripts/make-icons.mjs)
  vendor/                Transformers.js, ONNX Runtime Web, KaTeX, highlight.js (copied on npm install)
scripts/                 icon generator, engine vendoring, store packaging
test/                    unit tests (node --test)
```

The content script draws the fox and the bubble's outline inside a closed
Shadow DOM to keep the site's CSS and Renard's apart. The background script
sends it the sprite, fonts, and stylesheet as bytes, and the sprite is drawn on
a canvas. Since none of them load from an extension URL, the page's Content
Security Policy can't block them.

The question, answer, and text box are in `bubble/`, an extension page loaded
in an iframe inside the bubble. The site can't read or script that frame, and
it doesn't appear in the page's `window.frames`.

The content script and the frame talk over a `MessageChannel`. To accept it,
the frame needs a one-time key from the background script. Pages can't reach
the background script, so a site that gets hold of the frame still can't open a
channel of its own. Since keystrokes in the frame never reach the page, the
frame handles Esc and the shortcuts itself.

The adapters in `content/adapters/` are the only site-specific code. Each chat
adapter reads the user and assistant turns, finds the message box so the bubble
can avoid covering it, and reports the page theme. If an adapter can't find the messages on a chat
page, Renard says so and answers without the chat. `web.js` handles every other
site by reading its largest main or article region. Both read text the way
`messageText()` in `common.js` does: without buttons, and without text the page
hides from view, which a page could otherwise use to slip instructions to the
model.

For other websites, Renard asks for optional host access one site at a time
from the toolbar menu. The background script then registers the same content
scripts for each site with `scripting.registerContentScripts` and injects them
into open tabs. With Every website on, one registration matches every https
page instead, and a site turned off from the menu gets the script but stays
hidden. Firefox drops these registrations when the extension updates,
and the background script rebuilds them at startup. Styles are added with a
constructed stylesheet where the browser supports it, because some pages'
security policies block inline styles.

The background script makes the API calls. Each question opens a port to it,
and the answer streams back over that port. Closing the port cancels the
request.

The built-in engine in `engine/` runs Transformers.js on WebGPU. Firefox's
background page hosts it directly. Chrome's service worker can't host it, and
Chrome runs it in an offscreen document reached over a port instead. Firefox
suspends an idle background page after about 30 seconds, so the page and
settings ping the background during answers and downloads. The engine's code
ships in the package. Only the model weights are downloaded.

`shared/providers.js` calls the APIs with `fetch` and parses their SSE streams.
It uses the Anthropic Messages API (`anthropic-version: 2026-10-21`), the
OpenAI Responses API, and the Gemini API's `streamGenerateContent` with
`alt=sse`. Gemini keys go in the `x-goog-api-key` header, never in the URL.
When a model supports them, requests include optional fields: low effort,
refusal fallbacks, reasoning effort, and Gemini's thinking level. If the model
rejects one, the request is retried once without them.

A screenshot starts in `content/region.js`, which dims the page and returns the
area the user drags over. The background script captures the visible tab with
`tabs.captureVisibleTab`, and `shared/image.js` crops it and scales it to at
most 1568 pixels on the long edge and 1.15 megapixels. Pasted and dropped
images are scaled the same way in the frame. Each provider gets the image
before the question's text, as an Anthropic image block, an OpenAI
`input_image`, or a Gemini `inlineData` part.

## Development

```sh
npm test         # unit tests
npm run lint     # web-ext lint (Mozilla's add-on linter)
npm run icons    # regenerate src/icons/
npm run build    # store zips in dist/
```

Release steps for addons.mozilla.org and the Chrome Web Store are in
[docs/publishing.md](docs/publishing.md).

For a permanent Firefox install, sign the build as an unlisted add-on on
addons.mozilla.org. Signing is free and automatic, and unlisted add-ons don't
appear on the site. Firefox Developer Edition also works with
`xpinstall.signatures.required` set to `false`.

The Firefox add-on ID is `renard-companion@YeziShanYang`. Every version has to
keep it, so don't change it.

## License

Copyright (C) 2026 YeziShanYang. Renard's code is licensed under the GPL,
version 3 only. See [LICENSE](LICENSE).

These parts have their own terms:

- Fox art: "2D Pixel Art Fox Sprites" by Elthen, licensed separately and not
  included in this repo.
- Silkscreen font by The Silkscreen Project Authors, under the SIL Open Font
  License (`src/fonts/OFL.txt`).
- Transformers.js by Hugging Face (Apache 2.0), ONNX Runtime Web by Microsoft
  (MIT), KaTeX (MIT), and highlight.js (BSD 3-Clause), copied into
  `src/vendor/` on install.
- Gemma models are by Google and are downloaded from Hugging Face under the
  terms on each model's page.
