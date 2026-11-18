// The fox in the toolbar popup's and the settings page's header, drawn from
// the sprite sheet, or from the toolbar icon when the sheet isn't there
// (onMissing is called then). With reduced motion it holds still.
// lively: it looks around now and then, and pounces when its button is
// clicked. Needs content/sprite.js on the page.
export function drawHeaderFox(canvas, { lively = false, onMissing = null } = {}) {
  const R = globalThis.Renard;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = (sheet, fallback) => {
    const sprite = new R.Sprite(canvas, sheet, fallback);
    if (reduce) {
      sprite.hold('idle', 0);
    } else {
      sprite.play('idle');
      if (lively) {
        setInterval(() => {
          if (sprite.name === 'idle') sprite.play('look', { onEnd: () => sprite.play('idle') });
        }, 9000);
      }
    }
    if (lively) {
      canvas.closest('button').addEventListener('click', () => {
        if (!reduce) sprite.play('pounce', { onEnd: () => sprite.play('idle') });
      });
    }
  };
  const img = new Image();
  img.onload = () => start(img, null);
  img.onerror = () => {
    if (onMissing) onMissing();
    const icon = new Image();
    icon.onload = () => start(null, icon);
    icon.src = '../icons/icon-16.png';
  };
  img.src = '../assets/fox-sprite-sheet.png';
}
