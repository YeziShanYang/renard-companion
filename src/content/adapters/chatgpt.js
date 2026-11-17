// chatgpt.com adapter. ChatGPT marks each message with
// data-message-author-role, which has been stable across redesigns.
(function () {
  const R = globalThis.Renard;
  const U = R.adapterUtils;

  const MESSAGE = '[data-message-author-role]';
  const INPUT = ['#prompt-textarea', 'form [contenteditable="true"]', 'form textarea'].join(', ');

  R.adapters.chatgpt = {
    readChat() {
      const nodes = U.outermost(document.querySelectorAll(MESSAGE));
      const turns = U.readTurns(nodes, (el) => {
        const role = el.getAttribute('data-message-author-role');
        if (role !== 'user' && role !== 'assistant') return null;
        // A reply can hold more than one .markdown (a reasoning summary, say),
        // so the whole message is read, minus its buttons and hidden parts.
        const content = role === 'user' ? el.querySelector('.whitespace-pre-wrap') || el : el;
        return { role, text: U.messageText(content) };
      });
      if (turns.length === 0 && /\/c\/[\w-]+/.test(location.pathname)) {
        throw new Error('No messages found on this ChatGPT conversation page');
      }
      return turns;
    },

    composerRect() {
      const input = document.querySelector(INPUT);
      if (!input) return null;
      return U.visibleRect(input.closest('form') || input.parentElement);
    },

    theme() {
      return U.themeFromPage();
    },
  };
})();
