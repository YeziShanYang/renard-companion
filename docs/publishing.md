# Publishing Renard

Renard ships to two stores from one codebase: addons.mozilla.org (AMO) for
Firefox and the Chrome Web Store (CWS). `npm run build` produces one zip for
each.

## Before submitting to either store

1. **Art permission.** Email Elthen (address on the license page) describing
   Renard and confirm the use. The packages include the sprite sheet and icons
   cut from it, which the license allows in a project; the repository itself
   must not contain them.
2. **Privacy policy at a public URL.** Fill in the contact line in
   [`PRIVACY.md`](../PRIVACY.md) and host it somewhere public: the repository
   once it is public, GitHub Pages, or a public gist. Both stores require the
   link.
3. **Version.** Bump `version` in `src/manifest.json` and `package.json` for
   every upload. Each store rejects a version it has already seen.
4. **Build.** With the sprite sheet in `src/assets/`, run:

   ```sh
   npm test
   npm run build
   ```

   This writes `dist/renard-firefox-<version>.zip` and
   `dist/renard-chrome-<version>.zip`, and lints the Firefox package.
5. **Listing assets.**
   - Icon: `src/icons/icon-128.png` (generated).
   - Screenshots: at least one 1280×800 (Chrome also accepts 640×400) showing
     the fox and an answer.
   - Chrome small promo tile: 440×280.
   - In screenshots and text, describe Renard as working with claude.ai and
     ChatGPT, but don't use those products' logos, and add a line such as
     "Renard is not affiliated with Anthropic, OpenAI, or Google."

## Firefox (addons.mozilla.org)

1. Sign in at https://addons.mozilla.org/developers/ with a Firefox account.
2. **Submit a New Add-on**, then choose distribution:
   - **On this site:** a public listing, reviewed by Mozilla.
   - **On your own:** signed automatically for your own installs, not
     listed (good for personal use before a public release).
3. Upload `dist/renard-firefox-<version>.zip`.
4. **Source code:** answer that no source submission is needed. Renard ships
   its code as written, without minifying, bundling, or transpiling.
5. **Listing details:** name (Renard), summary (250 characters or fewer), description,
   categories, support email or site, license, and the privacy policy URL.
6. **Data collection:** AMO shows the manifest's declaration
   (`websiteContent`, `personalCommunications`). Make sure the listing
   describes the same thing: the page's conversation is sent to the provider
   you choose when you ask with **Read chat** on.
7. Submit. The add-on ID `renard-companion@YeziShanYang` is permanent; later
   versions must keep it.

## Chrome Web Store

1. Register at https://chrome.google.com/webstore/devconsole: one-time US$5
   fee, 2-Step Verification on the Google account, a verified contact email, a
   publisher name, and the trader or non-trader declaration.
2. **New item:** upload `dist/renard-chrome-<version>.zip`.
3. **Store listing:** description, category (Productivity), language, icon,
   screenshots, and promo tile.
4. **Privacy practices:**
   - Single purpose: a companion on claude.ai and ChatGPT that answers your
     questions with your own AI provider key.
   - Permission justifications: `storage` (settings and key on the device);
     each host permission (the three chat sites, to show the fox and read the
     chat on request; the three API hosts, to send questions to the chosen
     provider).
   - Remote code: No.
   - Data usage: website content and personal communications (the chat, sent
     with your question when Read chat is on), and authentication information
     (the API key, stored locally and sent only to the provider). Certify the
     Limited Use statements.
   - Privacy policy URL.
5. **Distribution:** Public, or Unlisted (installable by link only).
6. Submit for review.

## Updating

Bump the version, run `npm run build`, and upload the new zip as a new version
in each dashboard. Listing text and screenshots carry over.

## Not covered

Safari (and the Mac App Store) need the extension wrapped in an app with
Xcode's Safari Web Extension converter and an Apple Developer Program
membership. Renard does not target Safari yet.
