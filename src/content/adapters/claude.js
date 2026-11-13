// claude.ai adapter. Selectors are listed newest-first with fallbacks; when
// none match on a chat page, readChat() throws and Renard says so.
(function () {
  const R = globalThis.Renard;
  const U = R.adapterUtils;

  const USER = '[data-testid="user-message"]';
  const ASSISTANT = ['.font-claude-response', '.font-claude-message', '[data-testid="assistant-message"]'].join(', ');
  const INPUT = [
    '[data-testid="chat-input"]',
    'div.ProseMirror[contenteditable="true"]',
    'fieldset [contenteditable="true"]',
    'fieldset textarea',
  ].join(', ');

  R.adapters.claude = {
    readChat() {
      const nodes = U.outermost(document.querySelectorAll(`${USER}, ${ASSISTANT}`));
      const turns = U.mergeTurns(
        nodes.map((el) => ({ role: el.matches(USER) ? 'user' : 'assistant', text: U.textOf(el) })),
      );
      if (turns.length === 0 && /^\/chat\//.test(location.pathname)) {
        throw new Error('No messages found on this claude.ai chat page');
      }
      return turns;
    },

    composerRect() {
      const input = document.querySelector(INPUT);
      if (!input) return null;
      return U.visibleRect(input.closest('fieldset') || input.closest('form') || input.parentElement);
    },

    theme() {
      return U.themeFromPage();
    },
  };
})();
