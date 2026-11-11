// The web UI's client code. Served from 'self' (script-src 'self'), so it can grow without the CSP
// changing. Every page loads it; each part does nothing when its elements are missing.
(() => {
  // Copy buttons ([data-copy] = id of the element to copy) and confirm prompts (form[data-confirm]).
  document.addEventListener('click', (e) => {
    const button = e.target.closest?.('[data-copy]');
    const target = button && document.getElementById(button.dataset.copy);
    if (!target) return;
    navigator.clipboard.writeText(target.textContent).then(() => {
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1500);
    });
  });
  document.addEventListener('submit', (e) => {
    const message = e.target.dataset?.confirm;
    if (message && !confirm(message)) e.preventDefault();
  });

  // The frame bridge: messages between this page and the artifact iframe, which runs untrusted code.
  // A sandboxed frame's origin is "null", so a message is only taken from the iframe's own window,
  // and only a type with a handler here is acted on. Treat every field as hostile input.
  const frame = document.querySelector('iframe.artifact');
  const handlers = new Map();
  const onFrameMessage = (type, handler) => handlers.set(type, handler);
  window.addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    handlers.get(data.type)?.(data);
  });
  // The frame's origin is opaque, so it can't be named. What goes here must be fine for the artifact
  // (or a page it navigated its frame to) to read.
  const toFrame = (message) => frame?.contentWindow?.postMessage(message, '*');

  // Comments.
  const LIMITS = { exact: 2000, context: 32, quotes: 200 };
  const panel = document.getElementById('comments');
  const form = document.getElementById('new-comment');
  const selectButton = document.getElementById('comment-on-selection');
  const quoteBox = document.getElementById('new-quote');
  const quoteText = document.getElementById('new-quote-text');
  const field = (name) => form?.elements.namedItem(name);

  if (panel && window.matchMedia?.('(max-width: 60rem)').matches && !location.hash) {
    panel.open = false;
  }
  const target = location.hash && document.getElementById(location.hash.slice(1));
  const resolved = target?.closest?.('details.resolved');
  if (resolved) resolved.open = true;

  const text = (value, max) => typeof value === 'string' && value.length <= max;
  let selection = null;

  onFrameMessage('aa:selection', (data) => {
    if (!selectButton || !form) return;
    if (
      !text(data.exact, LIMITS.exact) ||
      !text(data.prefix, LIMITS.context) ||
      !text(data.suffix, LIMITS.context)
    ) {
      return;
    }
    selection = data.exact.trim()
      ? { exact: data.exact, prefix: data.prefix, suffix: data.suffix }
      : null;
    selectButton.hidden = !selection;
  });

  const setQuote = (quote) => {
    for (const name of ['exact', 'prefix', 'suffix']) field(name).value = quote ? quote[name] : '';
    quoteText.textContent = quote ? quote.exact : '';
    quoteBox.hidden = !quote;
  };

  selectButton?.addEventListener('click', () => {
    if (!selection) return;
    setQuote(selection);
    selectButton.hidden = true;
    if (panel) panel.open = true;
    field('body').focus();
  });
  document.getElementById('new-quote-clear')?.addEventListener('click', () => setQuote(null));

  // Open text threads ask the frame to highlight their quotes; the quotes are the artifact's own text.
  const sendHighlights = () => {
    const quotes = [...document.querySelectorAll('[data-exact]')]
      .slice(0, LIMITS.quotes)
      .map((el) => ({
        exact: el.dataset.exact,
        prefix: el.dataset.prefix ?? '',
        suffix: el.dataset.suffix ?? '',
      }));
    if (quotes.length > 0) toFrame({ type: 'aa:highlight', quotes });
  };
  // The bridge says when it is listening; the frame may also have loaded before this script ran.
  onFrameMessage('aa:ready', sendHighlights);
  sendHighlights();
})();
