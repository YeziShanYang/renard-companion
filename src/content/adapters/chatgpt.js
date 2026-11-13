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
      const turns = U.mergeTurns(
        nodes
          .map((el) => {
            const role = el.getAttribute('data-message-author-role');
            const content = role === 'assistant' ? el.querySelector('.markdown') || el : el.querySelector('.whitespace-pre-wrap') || el;
            return { role, text: U.textOf(content) };
          })
          .filter((t) => t.role === 'user' || t.role === 'assistant'),
      );
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
