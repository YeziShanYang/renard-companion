# Project Brief: Renard 🦊

## Overview

**Renard** (French for "fox") is a cute pixel-art fox that lives at the edge of the browser window on **claude.ai** and **chatgpt.com**. It idles, wanders, naps, and reacts with pre-written lines and animations. Click it, type a question, and it fetches an answer from the user's own AI provider (Anthropic or OpenAI) and shows it in a large, readable answer box. It can optionally read the current conversation on the page, so questions like "summarize this chat" work.

Renard is a **scripted character**: its personality comes from hand-written lines and animations. The AI is only the answer engine behind it and has no persona of its own.

The name nods to Reynard the Fox, the clever trickster of medieval European fables, and to Claude being a French name, without borrowing anyone's branding.

**Primary browser:** Firefox (built and tested there first), kept compatible with Chrome.
**Initial use:** personal, loaded locally. Public publishing may come later.

## Project Identity

| Item | Value |
|---|---|
| Name | Renard |
| GitHub repo | `renard-companion` |
| Repo description | 🦊 Renard: a pixel-art fox companion for claude.ai and ChatGPT that answers your questions using your own Anthropic or OpenAI API key. |
| Repo topics | `firefox-extension`, `chrome-extension`, `webextension`, `pixel-art`, `ai-assistant`, `claude`, `chatgpt` |
| Firefox add-on ID (`gecko.id`) | `renard-companion@<github-username>` (keep stable forever) |
| Store name (if published) | e.g. "Renard: a pixel fox for claude.ai and ChatGPT" |

## Key Decisions

| Area | Decision |
|---|---|
| Where it runs | claude.ai and chatgpt.com (v1), each toggleable |
| Browsers | Firefox first, Chrome-compatible from one codebase |
| AI providers | Anthropic or OpenAI, user's choice (independent of which site it's on) |
| API key | User pastes their own; stored on device only |
| Model | User selects from a list fetched from the provider |
| Conversation style | Single question and answer (no running history) |
| Chat awareness | Can read the current chat on the page, controlled by a small toggle |
| Fox personality | Pre-canned lines and animations, not AI-generated |
| Answer display | Large box, normal readable font |
| Everything else | Pixel-art aesthetic |
| Sprite art | Elthen's "2D Pixel Art Fox Sprites" |
| Distribution | Personal use first; publishing later is optional |

## Core Experience

1. On page load (on a supported, enabled site), Renard pounces in and settles at the edge of the screen.
2. It idles: standing, occasionally looking around, eventually napping if ignored.
3. The user can drag it anywhere; on release it walks to the nearest edge and tucks partly out of view.
4. Clicking Renard opens a pixel-styled speech bubble with a random canned greeting and a text input.
5. The user types a question. A small "Read chat" toggle controls whether the current conversation on the page is included.
6. Renard shows a "thinking" animation and canned line while waiting.
7. The answer streams into a large answer panel in a normal, readable font, with the user's question shown above it.
8. Renard does a happy pounce. The answer stays visible until the next question.

## Fox Behavior

All canned text is short and shown in a pixel font. Each trigger draws randomly from a small pool of lines, avoiding back-to-back repeats. All lines live in a single editable JSON file.

| Trigger | Animation | Canned text (examples) |
|---|---|---|
| Page loads | Pounce in (row 4), then idle | "Hi there!" |
| Idle | Standing loop (row 1) | — |
| Every 20–40 sec while idle | Looks around (row 2) | — |
| Hover | Perks up, glances toward cursor | — |
| Click (opens bubble) | Idle, facing user | "What's up?" / "Ask me anything!" / "Need a hand?" |
| Being dragged | Startled (row 5) | "Whoa!" |
| Released after drag | Walks to nearest edge (row 3) | — |
| Question sent, waiting | Looks around (row 2) | "Hmm, let me think…" / "Sniffing out an answer…" |
| Answer arrives | Quick pounce (row 4) | "Got it!" |
| ~5 min without interaction | Curls up asleep (row 6) | "Zzz…" |
| Clicked while asleep | Wakes up | "Oh! I'm up!" |
| No API key set | Stays asleep (row 6) | "I need an API key to wake up!" + **Open settings** |
| Site access not granted (Firefox) | Asleep or startled | "I need permission to visit this site!" + **Open settings** |
| Key invalid / out of credits | Startled (row 5) | "Hmm, that key isn't working." + **Open settings** |
| Rate limited / network error | Startled (row 5) | "Something went wrong. Try again in a moment?" |
| Couldn't read the chat | Startled (row 5) | "I couldn't read this chat, but you can still ask me!" |
| Hidden by the user | Curls up, slides off-screen | "See you later!" |
| Clicked 10 times rapidly | Falls over (row 7) | "Okay, okay, I'm dizzy!" (easter egg) |

## Sprite Sheet

- **Source:** "2D Pixel Art Fox Sprites" by Elthen (itch.io).
- **Layout:** appears to be 32×32 frames in a 14-column × 7-row grid; confirm exact dimensions during build.
- **Facing:** the fox faces one direction; flip with CSS (`scaleX(-1)`) so it always faces into the page and walks the right way.
- **Display:** integer scaling only (2x = 64px or 3x = 96px) with `image-rendering: pixelated`.

| Row | Frames | Likely original animation | Renard use |
|---|---|---|---|
| 1 | 5 | Idle | Default idle loop |
| 2 | 14 | Long idle / looking around | Idle flourish, thinking |
| 3 | 8 | Walk / run | Moving to an edge |
| 4 | 11 | Pounce / leap | Entrance, answer arrived |
| 5 | 5 | Startled / hurt | Dragged, errors |
| 6 | 6 | Lie down / sleep | Napping, no API key, hiding |
| 7 | 7 | Fall over / death | Dizzy easter egg |

### License

- Assets acquired after Nov 1, 2025 fall under **Elthen's Common Sense License 1.0**.
- **Allowed:** personal and commercial projects; editing and modifying the art.
- **Not allowed:** reselling or redistributing the assets themselves (even modified); any blockchain/crypto use; using the assets to train AI models.
- **Credit:** optional, but planned anyway ("Fox art by Elthen" on the settings page and in the README).
- **Before publishing:** email Elthen (address on the license page) describing Renard and confirm the use is fine.

## Speech Bubble & Answer Box

- **Size:** ~420px wide by default (flexes ~320–480px, never over 90% of screen width).
- **Answer panel:** grows with content up to ~60% of window height, then scrolls. Body text 15–16px, normal line height.
- **Expand mode:** pixel button toggles a larger reading view (~640px wide, ~80% of window height).
- **Resize handle:** pixel grip in the corner; size is remembered.
- **Placement:** opens from Renard toward the center of the screen, stays fully on-screen, and avoids covering the current site's message input (location provided by each site adapter).
- **Contents:** canned fox line (pixel font) → user's question in a small line → answer panel (normal font) → input box and "Read chat" toggle.
- **Single Q&A:** each question is independent. The last answer persists when the bubble is closed and reopened; a new question replaces it. The previous question is pre-filled in the input for easy tweaking and re-asking.
- **Answer formatting:** lists, bold, links, and code blocks rendered normally for readability; small pixel **copy** button.
- **Closing:** Esc key or pixel ✕ button.

## Visual Design

- **Pixel aesthetic everywhere except the answer text.**
- **Fonts (bundled, Open Font License):**
  - Pixel UI font (e.g. Press Start 2P or Silkscreen) for canned lines, buttons, labels.
  - Answer text in a clean, normal font for readability.
- **Bubble:** stepped (non-rounded) corners, 2–3px dark outline, solid offset drop shadow, pixel tail pointing at Renard that flips sides with it. No gradients or blur.
- **Palette:** drawn from the fox (orange, cream, dark brown outline) plus one accent color; light and dark variants matching each site's current theme.
- **Controls:** chunky square buttons that shift down 2px when pressed; boxed input with a blinking block cursor; tiny pixel checkbox/switch with icon for "Read chat."
- **Canned text effect:** RPG-style character-by-character reveal. Optional soft "blip" sound, **off by default**.
- **Settings page:** same pixel styling.

## Supported Sites

| Site | Domains | Notes |
|---|---|---|
| Claude | `claude.ai` | Single-page app |
| ChatGPT | `chatgpt.com`, `chat.openai.com` (legacy, redirects) | Single-page app |

- Each site can be turned on or off separately in settings.
- Renard's position (edge and height) is remembered **per site**.
- Behavior, look, and settings are otherwise identical across sites.

## Chat Awareness

- A small **"Read chat"** toggle in the bubble controls whether the current conversation is included (proposed default: on).
- The chat is read **only when a question is sent**, never in the background, and never saved.
- Messages are separated into user vs. assistant turns.
- **Long chats:** only the most recent portion is sent, up to a set limit; Renard notes when it's seeing only part of the chat.
- **Navigation:** both sites are single-page apps; the extension watches URL changes so it always reads the chat currently on screen.

### Site adapters

Each supported site has its own small **adapter** module. Everything else (fox, bubble, settings, API) is shared. An adapter provides:

- How to read the current conversation (user and assistant messages).
- Where the site's message input sits, so the bubble avoids covering it.
- How to detect the site's light/dark theme.
- How to detect navigation between chats.

Benefits: if one site changes its page structure, only that adapter needs fixing; adding a new site later (e.g. Gemini) means writing one new adapter. On any adapter failure, Renard says it couldn't read the chat and keeps working as a standalone assistant.

## Settings

Opened from the toolbar icon, the extension's options page, or Renard's "Open settings" button.

- **Provider:** Anthropic or OpenAI.
- **API key:** password-style field with show/hide toggle.
- **Model:** dropdown populated by fetching the provider's available models once a key is entered. This doubles as a key check ("✓ Connected" / "✗ That key didn't work").
- **Sites:** on/off toggle for claude.ai and for ChatGPT.
- **Site access (Firefox):** detects whether access to each enabled site has been granted and shows an "Allow access" button if not.
- **Readable text option** for anyone who finds pixel fonts tiring (affects UI text; answer text is always readable).
- **Sound** on/off (off by default).
- **Credits:** "Fox art by Elthen."

## AI Behavior

- **No persona.** A neutral system prompt asks for clear, reasonably concise answers suited to a quick-help panel.
- **Request contents:** the user's question, plus the current conversation from the page when the toggle is on.
- **Streaming** responses so text appears progressively.
- The chosen provider is independent of the site: e.g. Anthropic can answer questions on ChatGPT, and OpenAI on claude.ai.

## Other Behavior

- **Position memory:** per site, across reloads and restarts.
- **Keyboard shortcuts:** one to open/close the bubble (e.g. Alt+Shift+F), one to hide/show Renard. User-changeable in browser settings.

## Technical Approach

### Architecture

- **WebExtension, Manifest V3**, one codebase for Firefox and Chrome.
- **Content script** (supported sites only) injects Renard and the bubble.
  - Loads the matching **site adapter** for the current domain.
  - All UI inside a **Shadow DOM** to avoid style conflicts with the host site.
  - `position: fixed`; pointer events for dragging; CSS transitions for edge-snapping; CSS sprite animation by stepping frames.
  - Never has access to the API key.
- **Background script** handles all API calls and reads the key from storage.
  - Manifest declares **both** `background.scripts` (Firefox event page) and `background.service_worker` (Chrome).
- **Options page** for settings.
- **Storage:** `storage.local` (stays on device; not `storage.sync`) for the API key, provider, model, per-site positions and toggles, bubble size, and preferences.
- **Canned lines:** single JSON file.
- **Fonts and sprite sheet:** bundled with the extension, not loaded from the web.

### Permissions

- Host access:
  - Sites: `https://claude.ai/*`, `https://chatgpt.com/*`, `https://chat.openai.com/*`
  - APIs: `https://api.anthropic.com/*`, `https://api.openai.com/*`
- `storage`.
- Keep the permission list minimal.

### Firefox-specific notes

- Manifest includes `browser_specific_settings.gecko.id` = `renard-companion@<github-username>`.
- Host permissions are optional in Firefox MV3: the user must grant access to each site, so the extension checks and prompts for it.
- Firefox accepts the `chrome.*` namespace; `browser.*` with promises is also available.
- Develop with Mozilla's **web-ext** tool (auto-reload, linting, packaging).

## Privacy

- Questions (and chat content, when the toggle is on) go **directly from the user's browser to their chosen provider**, and nowhere else.
- Because the site and provider are independent, a conversation from one company's site may be sent to the other company (e.g. a ChatGPT conversation sent to Anthropic). This will be clearly disclosed.
- Chat content is sent only when the user asks a question with "Read chat" on, and is never stored.
- The developer never sees, collects, or stores any data.
- The API key is stored locally and unencrypted, as is standard for bring-your-own-key extensions; anyone with access to the browser profile could read it. This will be stated plainly.

## Distribution

### Phase 1: Personal use (now)

- **Firefox:** temporary loading via about:debugging is for development only (removed on restart). For permanent install, either:
  - sign it privately through addons.mozilla.org as an **unlisted** (self-distributed) add-on (free, automated, not public), then install the signed file from about:addons; or
  - use **Firefox Developer Edition** with `xpinstall.signatures.required` set to false.
- **Chrome:** "Load unpacked" in developer mode.

### Phase 2: Public release (optional, later)

- **Firefox Add-ons (AMO):** free to publish; listed add-ons go through review. No existing "Renard" extension found (only a few old themes).
- **Chrome Web Store:** one-time $5 developer fee; 2-Step Verification required; verified contact email, publisher name, trader/non-trader declaration.
- **Both:** hosted privacy policy; declare reading of website content in the store's privacy section.
- **Branding:** name and icon must stand on their own and not resemble an official Anthropic or OpenAI product. The description may say it works with claude.ai and ChatGPT.
- **Art:** confirm the use with Elthen before publishing.

## Out of Scope (v1)

- Sites other than claude.ai and ChatGPT.
- Running conversation / follow-up history.
- AI-generated fox personality.
- Voice input or text-to-speech.
- Syncing settings across devices.
- Safari support.
- Public store listings.

## Open Questions

- "Read chat" toggle default: on (proposed) or off?
- Exact sprite frame dimensions (confirm from the file).
- Character limit for how much of a long chat is sent.
- Final keyboard shortcut choices.
- Final canned line wording.

## Build Plan

1. Create the `renard-companion` repo; confirm sprite sheet dimensions and slice the animation rows.
2. Set up the extension skeleton: cross-browser manifest, content script, background script, options page, web-ext workflow.
3. Settings page: provider, key, model fetching and validation, site toggles, local storage, Firefox site-access checks.
4. Renard on the page: sprite animations, idle behavior, dragging, edge-snapping, flipping, per-site position memory.
5. Speech bubble: pixel styling, canned lines system, input, toggle, sizing, expand/resize.
6. AI connection: background API calls for both providers, streaming into the answer panel.
7. Site adapters: claude.ai first, then ChatGPT; chat reading, input location, theme detection, navigation handling, graceful failure.
8. Error and empty states wired to animations and canned lines.
9. Polish: sleep timer, easter egg, keyboard shortcuts, optional sound, readable-text option, light/dark themes.
10. Sign for personal Firefox install; test in Chrome.
