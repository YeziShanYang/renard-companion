# Releasing Renard

Renard ships to two stores from one codebase: addons.mozilla.org (AMO) for
Firefox and the Chrome Web Store (CWS). `npm run build` produces one zip for
each.

## Before each release

1. **Sprite sheet.** The store packages include Elthen's sprite sheet, which
   its license allows inside a project but not on its own, so it stays out of
   the repository. Put it at `src/assets/fox-sprite-sheet.png` before
   building. The toolbar icon is original art.
2. **Version.** Bump `version` in `src/manifest.json` and `package.json`.
   Each store rejects a version it has already seen.
3. **Build.**

   ```sh
   npm test
   npm run build
   ```

   This writes `dist/renard-firefox-<version>.zip` and
   `dist/renard-chrome-<version>.zip`, and lints the Firefox package.
4. **Listing assets.**
   - Icon: `src/icons/icon-128.png`.
   - Screenshots: at least one 1280×800 (Chrome also accepts 640×400) showing
     the fox and an answer.
   - Chrome small promo tile: 440×280.
   - Describe Renard as working with claude.ai and ChatGPT without using those
     products' logos, and state that Renard is not affiliated with Anthropic,
     OpenAI, or Google.
5. **Privacy policy.** Both stores ask for a public URL; use
   [`PRIVACY.md`](../PRIVACY.md) on GitHub.

## Listing text

Both stores can use the same copy.

**Name:** Renard: Pixel Fox Companion (the manifest's `name`; `short_name` is
Renard)

**Summary** (AMO's Summary field, under 250 characters; the Chrome Web Store
shows the manifest's 132-character description instead):

> A pixel-art fox that can answer questions about what you read and summarize
> webpages! It can run a model fully on your computer, without an API key, or
> use Anthropic, OpenAI, or Gemini with customizable model control.

**Description** (AMO renders a limited set of Markdown, so the `- ` lines
become bullets and need the blank line above them; the Chrome Web Store shows
plain text, where `• ` reads better than `- `):

```
Renard is a small pixel fox that sits in the margins of claude.ai, ChatGPT, and any other site you turn it on for! Click to ask about anything on the page, and the answer appears in a large, resizable reading panel. It wanders around and naps while it waits.

Important details:

- No API key needed! Renard can run Gemma, Google's open model, on your computer's graphics chip. Download it once in settings (about 0.8 GB) and it works offline: nothing you ask leaves your computer. This needs WebGPU: recent Chrome, or Firefox on Apple Silicon Macs and Windows.
- For a larger model, add an Anthropic, OpenAI, or Google Gemini API key. Questions go straight from your browser to that provider; there is no Renard server.
- With Read chat on, Renard includes the conversation on the page, so you can ask it to summarize the chat. On other websites it reads the page instead. You can turn this off at any time.
- Websites can't see your questions or Renard's answers: the panel is a separate extension frame that the site can't read.
- Drag the fox anywhere, resize the panel from any corner, and use Alt+Shift+F to open it or Alt+Shift+H to hide the fox.
- The toolbar menu shows or hides Renard everywhere, or turns it on for the site you're on.
- Open source under the GNU GPL v3: read the code, report issues, or build it yourself at https://github.com/YeziShanYang/renard-companion.

Renard is not affiliated with Anthropic, OpenAI, or Google. Fox art by Elthen ("2D Pixel Art Fox Sprites"); Silkscreen font under the SIL Open Font License.
```

**Category:** Productivity on the Chrome Web Store; the closest AMO category (such as Other).

**Support site:** https://github.com/YeziShanYang/renard-companion/issues

**Privacy policy:** https://github.com/YeziShanYang/renard-companion/blob/main/PRIVACY.md

## Firefox (addons.mozilla.org)

1. Sign in at https://addons.mozilla.org/developers/ and choose **Submit a New
   Add-on**.
2. Distribution: **On this site** for a public, reviewed listing, or **On your
   own** for a signed package that is not listed.
3. Upload `dist/renard-firefox-<version>.zip`.
4. **Source code:** no source submission is needed. Renard's own code ships as
   written, without minifying, bundling, or transpiling. The only minified
   files are third-party libraries copied unmodified from npm
   (`src/vendor/transformers/`: Transformers.js and ONNX Runtime Web, versions
   in its `NOTICE.md`). The linter's `eval` warnings come from those files;
   Renard's content security policy would block those code paths. The
   built-in model's files are pinned to a Hugging Face commit (`revision` in
   `src/shared/constants.js`).
   Platforms: Firefox only. Renard isn't built for Firefox for Android (the
   fox lives in desktop page margins, the shortcuts need a keyboard, and the
   built-in model needs WebGPU).

   **Notes to reviewer** (paste, updating versions and hashes if the
   libraries change):

   > The three linter warnings (eval / Function constructor / dynamic import)
   > are all inside unmodified third-party files in vendor/transformers/:
   > transformers.min.js is dist/transformers.min.js from the npm package
   > @huggingface/transformers 4.3.2, and ort-wasm-simd-threaded.asyncify.mjs
   > and .wasm are from dist/ of onnxruntime-web
   > 1.31.0-dev.20260914-8d85527a0 (the version Transformers.js 4.3.2 pins).
   > They are copied byte for byte by scripts/vendor.mjs; SHA-256s are listed
   > below. The extension's CSP (script-src 'self' 'wasm-unsafe-eval') does
   > not allow eval or new Function, and the one dynamic import loads the
   > bundled .mjs file from the extension itself (env.backends.onnx.wasm.wasmPaths
   > points at vendor/transformers/). No code is downloaded at run time; the
   > built-in model's weights are data files from Hugging Face, pinned to a
   > commit (revision in src/shared/constants.js). Full source:
   > https://github.com/YeziShanYang/renard-companion (GPL-3.0).
   >
   > SHA-256: transformers.min.js 8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb;
   > ort-wasm-simd-threaded.asyncify.mjs 0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611;
   > ort-wasm-simd-threaded.asyncify.wasm 49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082.

5. **Listing details:** name, summary (250 characters or fewer), description,
   categories, support site (the repository's issues page), license (GNU
   General Public License v3.0), and the privacy policy URL.
6. **Data collection:** AMO shows the manifest's declaration
   (`websiteContent`, `personalCommunications`). The listing should describe
   the same thing: the page's conversation (or, on a website the user added,
   the page's text, title, and address without its query string) is sent to
   the chosen provider when a question is asked with **Read chat** on.
7. The add-on ID `renard-companion@YeziShanYang` is permanent; every version
   must keep it.

## Chrome Web Store

1. A developer account at https://chrome.google.com/webstore/devconsole needs
   a one-time US$5 fee, 2-Step Verification, a verified contact email, a
   publisher name, and the trader or non-trader declaration.
2. **New item:** upload `dist/renard-chrome-<version>.zip`.
3. **Store listing:** description, category (Productivity), language, icon,
   screenshots, and promo tile.
4. **Privacy practices:**
   - Single purpose: a companion that helps users read and summarize the page
     they're on (claude.ai, ChatGPT, and websites they add), answering
     questions with an AI provider they connect or a built-in model.
   - Permission justifications: `storage` (settings and key on the device);
     `unlimitedStorage` (keeps the built-in model's files); `offscreen` (runs
     the built-in model in a hidden page with GPU access); `scripting` (shows
     Renard on websites the user adds, by registering its page script for
     those sites); `activeTab` (the toolbar menu reads the current tab's
     address to offer "On this site"); each host permission (the three chat
     sites, to show the fox and read the chat on request; the three API
     hosts, to send questions to the chosen provider); optional host access
     to `https://*/*` (requested for one site at a time, only when the user
     turns Renard on for it).
   - Remote code: none. The built-in model's engine ships in the package; only
     model weights (data files) are downloaded from Hugging Face.
   - Data usage: website content and personal communications (the chat, or an
     added site's page text, sent with a question when Read chat is on), and
     authentication information (the API key, stored locally and sent only to
     the provider). Certify the Limited Use statements.
   - Privacy policy URL.
5. **Distribution:** Public, or Unlisted (installable by link only).

## Updating a release

Bump the version, run `npm run build`, and upload the new zip as a new version
in each dashboard. Listing text and screenshots carry over.

## Not covered

Safari needs the extension wrapped in an app with Xcode's Safari Web
Extension converter and an Apple Developer Program membership. Renard does not
target Safari yet.
