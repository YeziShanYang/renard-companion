// The image that goes with the next question: the screenshot button, a
// picture pasted or dropped into the bubble, and the chip that shows it.
// The content script keeps the image (it sends it with the question); this
// frame scales pasted and dropped pictures and shows what's attached.
(function () {
  const R = globalThis.Renard;
  const { h } = R;
  const ext = R.ext;

  // Pasted or dropped files: images within this size are scaled down and
  // attached. The thumbnail fits in this many CSS pixels.
  const MAX_FILE_BYTES = 40e6;
  const THUMB_WIDTH = 96;
  const THUMB_HEIGHT = 48;
  const NO_CAPTURE =
    'Screenshots need access to all websites, which the browser asks for. You can still paste or drop an image into the question box.';
  const WRONG_TYPE = 'Renard can attach PNG, JPEG, WebP or GIF images.';

  function hasFiles(dataTransfer) {
    return Boolean(dataTransfer) && Array.from(dataTransfer.types || []).includes('Files');
  }

  // The first image file in a paste or drop, if any.
  function imageFile(dataTransfer) {
    if (!dataTransfer) return null;
    return Array.from(dataTransfer.files || []).find((f) => f.type.startsWith('image/')) || null;
  }

  R.Attachments = class {
    // post: sends a message to the content script. notice: shows a notice
    // in the bubble (or clears it with null).
    constructor({ post, notice }) {
      this.post = post;
      this.notice = notice;
      this.enabled = true;
      this.why = '';
      this.button = R.iconButton('camera', 'Add a screenshot', () => this.requestCapture());
      // A thumbnail (drawn on a canvas, since this page's CSP allows no
      // data: images), its size, and a button that removes it.
      this.thumb = h('canvas', { class: 'attachment-thumb', 'aria-hidden': 'true' });
      this.text = h('span', { class: 'attachment-text' });
      this.row = h('div', { class: 'attachment', hidden: true }, [
        this.thumb,
        this.text,
        R.iconButton('close', 'Remove the screenshot', () => post({ type: 'detach' })),
      ]);
    }

    // A pasted image file is attached; pasted text is left alone.
    takePastes(input) {
      input.addEventListener('paste', (e) => {
        const file = imageFile(e.clipboardData);
        if (!file) return;
        e.preventDefault();
        this.attachFile(file);
      });
    }

    // A dropped image file is attached. Any other dropped file is refused,
    // rather than opened in place of the bubble. panel shows that a drop is
    // coming (data-dropping).
    takeDrops(panel) {
      document.addEventListener('dragover', (e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = this.enabled ? 'copy' : 'none';
        panel.dataset.dropping = 'true';
      });
      document.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget) delete panel.dataset.dropping;
      });
      document.addEventListener('drop', (e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        delete panel.dataset.dropping;
        const file = imageFile(e.dataTransfer);
        if (file) this.attachFile(file);
        else this.notice({ text: WRONG_TYPE });
      });
    }

    // Whether images can be attached (not with the built-in model), and why
    // not when they can't.
    setEnabled(enabled, why) {
      this.enabled = enabled;
      this.why = why;
      this.button.disabled = !enabled;
      this.button.title = enabled ? 'Add a screenshot' : why;
    }

    // Browsers screenshot a page only for an extension with access to all
    // websites. Chrome lets this frame ask for it on the first click; the
    // request has to start inside the click itself, so it runs before
    // anything is awaited, and once granted it resolves at once with no
    // prompt. Firefox gives a frame on a web page no permissions API, so
    // there the content script checks access and points to settings.
    requestCapture() {
      if (!ext.permissions || typeof ext.permissions.request !== 'function') {
        this.post({ type: 'capture' });
        return;
      }
      let granted;
      try {
        granted = ext.permissions.request({ origins: ['<all_urls>'] });
      } catch (err) {
        granted = Promise.reject(err);
      }
      granted.then(
        (ok) => (ok ? this.post({ type: 'capture' }) : this.notice({ text: NO_CAPTURE })),
        () => this.notice({ text: NO_CAPTURE }),
      );
    }

    // A pasted or dropped image file, scaled here and handed to the content
    // script, which keeps it for the next question.
    async attachFile(file) {
      if (!this.enabled) {
        this.notice({ text: this.why });
        return;
      }
      if (!R.IMAGE_INPUT_TYPES.includes(file.type)) {
        this.notice({ text: WRONG_TYPE });
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        this.notice({ text: 'That image is too large to attach (over 40 MB).' });
        return;
      }
      // A slow earlier paste mustn't replace a later one.
      const token = (this.attachToken = {});
      try {
        const image = await R.prepareImage(file);
        if (token === this.attachToken) this.post({ type: 'attach', image });
      } catch (err) {
        if (token !== this.attachToken) return;
        this.notice({ text: err && err.code === 'tooLarge' ? 'That image is too large to attach (over 50 megapixels).' : "Couldn't read that image." });
      }
    }

    // Shows the attached image, or hides the chip for null.
    async show(image) {
      const token = (this.showToken = {});
      if (!image) {
        this.row.hidden = true;
        return;
      }
      this.text.textContent = `Screenshot · ${image.width}×${image.height}`;
      this.row.hidden = false;
      try {
        const bitmap = await createImageBitmap(R.base64Blob(image.data, image.mediaType));
        if (token !== this.showToken) return bitmap.close();
        // Drawn at twice its displayed size, for sharp high-DPI screens.
        const scale = Math.min(1, (THUMB_HEIGHT * 2) / bitmap.height, (THUMB_WIDTH * 2) / bitmap.width);
        this.thumb.width = Math.max(1, Math.round(bitmap.width * scale));
        this.thumb.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = this.thumb.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, this.thumb.width, this.thumb.height);
        bitmap.close();
      } catch {
        // The size text still shows that an image is attached.
      }
    }
  };
})();
