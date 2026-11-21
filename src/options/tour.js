// The first-run tour on the settings page. The fox runs into a frame under
// the header, says hello, and goes through the page a section at a time. A
// step about a section pins the frame to the top of the window, scrolls the
// section in below it, and makes the section a little bigger. Finishing or
// skipping stores tourDone, so the tour runs once. The footer's button plays
// it again.
//
// Space, Next or a click on the frame's buttons moves on. While a line is
// still typing out, the first press finishes it. Escape skips the tour.
import '../shared/constants.js';
import { ext, saveSettings } from '../shared/settings.js';
import { $, settings } from './page.js';

const R = globalThis.Renard;

const GEMINI_KEYS = 'https://aistudio.google.com/apikey';
// Where the pinned frame sits, and the room left between it and the section
// it points at (the arrow goes there).
const PIN_TOP = 14;
const PIN_GAP = 30;
// How much the section a step is about grows (.tour-target in options.css).
const TARGET_SCALE = 1.02;
// The page's grid gap, which goes too when the frame is removed.
const PAGE_GAP = 26;
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const TYPE_MS = 32;

const motionOk = () => matchMedia('(prefers-reduced-motion: no-preference)').matches;
const scrollBehavior = () => (motionOk() ? 'smooth' : 'auto');

let tour = null;

// ---- steps ------------------------------------------------------------------------

// say: the fox's line, typed out. detail: what's under it, as strings and
// { kbd } keys. target: the id of the heading of the section it's about.
// extra: buttons or links for the step.
async function buildSteps() {
  const gemma = R.LOCAL_MODELS['gemma-3-1b'];
  const gb = (gemma.sizes.q4f16 / 1e9).toFixed(1);
  return [
    {
      say: "Oh, hi! I'm Renard.",
      detail: ["I'm a pixel fox who helps you make sense of what you're reading. Want a quick look around? It takes about a minute."],
    },
    {
      say: 'I live in the margins.',
      detail: ['On claude.ai and ChatGPT I sit at the edge of the page. Click me to ask about what you see, and my answer opens in a big reading panel. You can drag me anywhere.'],
    },
    {
      target: 'ai-title',
      say: 'First, I need a brain.',
      detail: [`Built-in runs a small model on this computer. You don't need a key, and nothing you ask leaves the computer. It downloads once, about ${gb} GB.`],
      extra: 'builtin',
    },
    {
      target: 'ai-title',
      say: 'Or bring an API key.',
      detail: [
        'For a bigger model, paste an Anthropic, OpenAI, or Gemini key. Gemini has a free plan, so you can get a key without paying. On the free plan, Google may use what you send to improve its products.',
      ],
      extra: 'gemini',
    },
    {
      target: 'sites-title',
      say: 'Want me somewhere else?',
      detail: ['Open any https site, click my icon in the toolbar, and turn on On this site. To have me on every site, turn on Every website here.'],
    },
    {
      target: 'shots-title',
      say: 'Show me what you mean.',
      detail: ['The camera in my bubble attaches part of the page to your question. Your browser asks for permission the first time.'],
    },
    { target: 'keys-title', say: 'Need me fast?', detail: await shortcutDetail() },
    {
      say: "That's the tour!",
      detail: ['Pick a brain above, then come find me on claude.ai or ChatGPT. The button at the bottom of this page plays the tour again.'],
    },
  ];
}

// The current bindings, which the user may have changed.
async function shortcutDetail() {
  let commands = [];
  try {
    commands = await ext.commands.getAll();
  } catch {
    // commands API unavailable
  }
  const key = (name) => (commands.find((c) => c.name === name) || {}).shortcut;
  const open = key('toggle-bubble');
  const hide = key('toggle-visibility');
  if (!open || !hide) return ['My keyboard shortcuts are listed here, along with where to change them.'];
  const mac = /Mac/.test(navigator.platform) ? ' On a Mac, Alt is Option.' : '';
  return [{ kbd: open }, ' opens my bubble and ', { kbd: hide }, ` hides me. They work even while you're typing.${mac}`];
}

function extraFor(kind) {
  if (kind === 'builtin' && settings.provider !== 'local') return [actionButton('Use Built-in', () => chooseProvider('local'))];
  if (kind === 'gemini') {
    const link = Object.assign(document.createElement('a'), { className: 'btn', href: GEMINI_KEYS, target: '_blank', rel: 'noopener noreferrer', textContent: 'Get a free Gemini key' });
    return settings.provider === 'gemini' ? [link] : [link, actionButton('Use Gemini', () => chooseProvider('gemini'))];
  }
  return [];
}

function actionButton(label, onclick) {
  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: label });
  btn.addEventListener('click', onclick);
  return btn;
}

// Selects a provider through its radio, as a click on it would.
function chooseProvider(id) {
  const radio = document.querySelector(`input[name="provider"][value="${id}"]`);
  if (radio && !radio.checked) radio.click();
  if (!tour) return;
  const hadFocus = $('tour-extra').contains(document.activeElement);
  $('tour-extra').replaceChildren(...extraFor(tour.steps[tour.index].extra));
  if (hadFocus) $('tour-next').focus({ preventScroll: true });
}

// ---- the fox ------------------------------------------------------------------------

let spriteReady = null;

function foxSprite() {
  spriteReady =
    spriteReady ||
    new Promise((resolve) => {
      const canvas = $('tour-fox');
      const sheet = new Image();
      sheet.onload = () => resolve(new R.Sprite(canvas, sheet, null));
      sheet.onerror = () => {
        const icon = new Image();
        icon.onload = () => resolve(new R.Sprite(canvas, null, icon));
        icon.onerror = () => resolve(new R.Sprite(canvas, null, null));
        icon.src = '../icons/icon-16.png';
      };
      sheet.src = '../assets/fox-sprite-sheet.png';
    });
  return spriteReady;
}

function idle() {
  if (tour) tour.sprite.play('idle');
}

// ---- starting and ending ------------------------------------------------------------

// Runs the tour on a first visit, until it's finished or skipped.
export function maybeStartTour() {
  if (!settings.tourDone) startTour();
}

// replay: started from the footer's button.
export async function startTour({ replay = false } = {}) {
  if (tour) return;
  const steps = await buildSteps();
  const sprite = await foxSprite();
  if (tour) return;
  tour = { steps, index: 0, replay, sprite, typing: null, entering: null, ending: false };
  const t = tour;
  if (replay && scrollY > 0) await scrollHome();
  if (tour !== t) return;
  const root = $('tour');
  root.dataset.steps = String(steps.length);
  // One fox at a time: the header's steps out while this one gives the tour.
  document.querySelector('.page').dataset.touring = '';
  root.hidden = false;
  document.addEventListener('keydown', onKey);
  show(0, { type: false });
  $('tour-next').focus({ preventScroll: true });
  await enter(t);
}

// The frame appears and the fox runs in. Then it starts talking.
async function enter(t) {
  const card = $('tour').querySelector('.tour-card');
  const canvas = $('tour-fox');
  const say = $('tour').querySelector('.tour-say');
  if (!motionOk()) {
    card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear' });
    t.sprite.play('idle');
    typeLine();
    return;
  }
  card.animate([{ opacity: 0, translate: '0 12px' }, { opacity: 1, translate: '0 0' }], { duration: 300, easing: 'ease-out' });
  say.style.opacity = '0';
  t.sprite.play('walk', { ms: 55 });
  t.entering = canvas.animate([{ translate: '-110% 0' }, { translate: '0 0' }], { duration: 800, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' });
  await t.entering.finished.catch(() => {});
  t.entering = null;
  if (tour !== t || t.ending) return;
  t.sprite.play('idle');
  say.style.opacity = '';
  say.animate(
    [
      { opacity: 0, translate: '0 12px', filter: 'blur(4px)' },
      { opacity: 1, translate: '0 0', filter: 'blur(0px)' },
    ],
    { duration: 300, easing: 'ease-out' },
  );
  typeLine();
}

// Finished or skipped. The fox runs back out the way it came, the frame
// fades, and the page goes back to how it was.
export async function endTour() {
  const t = tour;
  if (!t || t.ending) return;
  t.ending = true;
  if (t.entering) t.entering.finish();
  if (t.typing) t.typing();
  document.removeEventListener('keydown', onKey);
  if (!settings.tourDone) {
    settings.tourDone = true;
    saveSettings({ tourDone: true }).catch(() => {});
  }
  const root = $('tour');
  const card = root.querySelector('.tour-card');
  const canvas = $('tour-fox');
  const hadFocus = root.contains(document.activeElement);
  point(null);
  if (motionOk()) {
    canvas.style.scale = '-1 1';
    t.sprite.play('walk', { ms: 55 });
    await canvas.animate([{ translate: '0 0' }, { translate: '-110% 0' }], { duration: 450, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
    await card
      .animate(
        [
          { opacity: 1, translate: '0 0' },
          { opacity: 0, translate: '0 -12px' },
        ],
        { duration: 150, easing: 'ease-out', fill: 'forwards' },
      )
      .finished.catch(() => {});
  } else {
    await card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'linear', fill: 'forwards' }).finished.catch(() => {});
  }
  // Taking the frame out moves the page up by its height. If it's above the
  // window, scroll by as much, so what's on screen stays where it is.
  const rect = root.getBoundingClientRect();
  const shift = rect.bottom <= 0 ? rect.height + PAGE_GAP : 0;
  root.hidden = true;
  pin(false, { animate: false });
  if (shift) scrollBy({ top: -shift, behavior: 'instant' });
  for (const a of [...canvas.getAnimations(), ...card.getAnimations()]) a.cancel();
  canvas.style.scale = '';
  // Ended while the fox was still running in, before the bubble showed.
  root.querySelector('.tour-say').style.opacity = '';
  t.sprite.stop();
  delete document.querySelector('.page').dataset.touring;
  tour = null;
  if (hadFocus) {
    const next = t.replay ? $('tour-replay') : document.querySelector('input[name="provider"]:checked');
    if (next) next.focus({ preventScroll: true });
  }
}

// Another settings tab finished the tour.
export function tourDoneElsewhere() {
  if (tour && !tour.replay) endTour();
}

// ---- moving between steps -------------------------------------------------------------

function next() {
  const t = tour;
  if (!t || t.ending) return;
  if (t.entering) {
    t.entering.finish();
    return;
  }
  if (t.typing) {
    t.typing();
    return;
  }
  if (t.index === t.steps.length - 1) endTour();
  else show(t.index + 1);
}

function back() {
  const t = tour;
  if (!t || t.ending || t.index === 0) return;
  if (t.entering) t.entering.finish();
  show(t.index - 1);
}

// type: type the line out (the first step waits for the fox to arrive).
function show(i, { type = true } = {}) {
  const t = tour;
  if (t.typing) t.typing();
  t.index = i;
  const step = t.steps[i];
  const last = i === t.steps.length - 1;
  const root = $('tour');
  root.dataset.step = String(i);
  $('tour-count').textContent = `${i + 1} / ${t.steps.length}`;
  $('tour-next').textContent = last ? 'Done' : 'Next';
  // A button about to hide hands keyboard focus to Next.
  for (const [id, hide] of [
    ['tour-back', i === 0],
    ['tour-skip', last],
  ]) {
    if (hide && document.activeElement === $(id)) $('tour-next').focus({ preventScroll: true });
    $(id).hidden = hide;
  }
  $('tour-detail').replaceChildren(...step.detail.map((part) => (typeof part === 'string' ? part : Object.assign(document.createElement('kbd'), { textContent: part.kbd }))));
  $('tour-extra').replaceChildren(...extraFor(step.extra));
  $('tour-live').textContent = `${step.say} ${$('tour-detail').textContent}`;

  const target = step.target ? $(step.target).closest('.card') : null;
  pin(Boolean(target));
  point(target);
  if (target) {
    // The section grows from its center (TARGET_SCALE), so its top edge
    // rises by half of what it gains.
    const grow = motionOk() ? (target.offsetHeight * (TARGET_SCALE - 1)) / 2 : 0;
    const top = target.offsetTop - grow - (PIN_TOP + root.querySelector('.tour-card').offsetHeight + PIN_GAP);
    scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
  } else if (scrollY > 0) {
    scrollTo({ top: 0, behavior: scrollBehavior() });
  }

  if (type) {
    typeLine();
    if (last) t.sprite.play('pounce', { onEnd: idle });
    else if (target) t.sprite.play('look', { onEnd: idle });
    else t.sprite.play('idle');
  }
}

// Types the current step's line out, RPG style. Every character is in place
// from the start, the untyped ones hidden.
function typeLine() {
  const t = tour;
  const text = t.steps[t.index].say;
  const root = $('tour');
  const shown = document.createElement('span');
  const rest = Object.assign(document.createElement('span'), { className: 'tour-untyped', textContent: text });
  $('tour-text').replaceChildren(shown, rest);
  delete $('tour-more').dataset.shown;
  const done = () => {
    shown.textContent = text;
    rest.textContent = '';
    delete root.dataset.typing;
    $('tour-more').dataset.shown = '';
    t.typing = null;
  };
  if (!motionOk()) {
    done();
    return;
  }
  const chars = Array.from(text);
  let n = 0;
  root.dataset.typing = '';
  const timer = setInterval(() => {
    n++;
    shown.textContent = chars.slice(0, n).join('');
    rest.textContent = chars.slice(n).join('');
    if (n >= chars.length) {
      clearInterval(timer);
      done();
    }
  }, TYPE_MS);
  t.typing = () => {
    clearInterval(timer);
    done();
  };
}

// ---- layout ----------------------------------------------------------------------------

// Pins the frame to the top of the window, or puts it back in the page. The
// frame glides between the two places.
function pin(on, { animate = true } = {}) {
  const root = $('tour');
  if (on === root.hasAttribute('data-pinned')) return;
  const card = root.querySelector('.tour-card');
  const before = card.getBoundingClientRect().top;
  if (on) {
    root.style.height = `${root.offsetHeight}px`;
    root.dataset.pinned = '';
  } else {
    delete root.dataset.pinned;
    root.style.height = '';
  }
  const after = card.getBoundingClientRect().top;
  if (animate && motionOk() && Math.abs(before - after) > 1) {
    card.animate([{ translate: `0 ${before - after}px` }, { translate: '0 0' }], { duration: 300, easing: EASE_OUT });
  }
}

// Marks the section a step is about, which fades the rest back.
function point(target) {
  for (const el of document.querySelectorAll('.tour-target')) if (el !== target) el.classList.remove('tour-target');
  const page = document.querySelector('.page');
  if (target) {
    target.classList.add('tour-target');
    page.dataset.tourFocus = '';
  } else {
    delete page.dataset.tourFocus;
  }
}

// Scrolls to the top, for a replay from the footer, and waits until it's
// there (or long enough).
function scrollHome() {
  return new Promise((resolve) => {
    if (!motionOk()) {
      scrollTo({ top: 0, behavior: 'auto' });
      resolve();
      return;
    }
    const done = () => {
      removeEventListener('scrollend', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    addEventListener('scrollend', done);
    scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ---- keys --------------------------------------------------------------------------------

function onKey(e) {
  if (!tour || tour.ending || e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
  const el = e.target instanceof Element ? e.target : null;
  if (e.key === 'Escape') {
    // Escape in a text field or menu is for that field.
    if (el && el.closest('input:not([type="radio"]):not([type="checkbox"]), textarea, select, [contenteditable]')) return;
    e.preventDefault();
    endTour();
    return;
  }
  // Buttons, links and form fields keep their own keys: Space on Next
  // presses Next.
  if (el && el.closest('input, textarea, select, button, a, [contenteditable]')) return;
  if (e.key === ' ' || e.key === 'ArrowRight') {
    e.preventDefault();
    next();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    back();
  }
}

export function bindTour() {
  $('tour-next').addEventListener('click', next);
  $('tour-back').addEventListener('click', back);
  $('tour-skip').addEventListener('click', () => endTour());
  $('tour-replay').addEventListener('click', () => startTour({ replay: true }));
}
