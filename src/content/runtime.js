// Renard's link to the rest of the extension, for its content scripts and
// the bubble's frame: the extension API, messages to the background script,
// and what marks Renard's element on a page.
(function () {
  const R = (globalThis.Renard = globalThis.Renard || {});

  R.ext = globalThis.browser ?? globalThis.chrome;

  // False once the extension has been reloaded, updated, or removed while
  // this page stayed open (runtime.id goes away for orphaned scripts).
  R.contextAlive = function () {
    try {
      return Boolean(R.ext.runtime && R.ext.runtime.id);
    } catch {
      return false;
    }
  };

  R.send = async function (type, payload = {}) {
    const res = await R.ext.runtime.sendMessage({ type, ...payload });
    if (!res || !res.ok) throw new Error((res && res.error) || 'No response from Renard');
    return res.result;
  };

  // Renard's element on the page. Older versions used a <renard-companion>
  // element, which the selector still finds so a new copy can clear it.
  R.HOST_ATTR = 'data-renard-companion';
  R.HOST_SELECTOR = `renard-companion, [${R.HOST_ATTR}]`;

  R.reducedMotion = () => globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The bytes of an asset the background script sent as base64.
  R.decodeBase64 = function (b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
})();
