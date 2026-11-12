// The web UI's client code. Served from 'self' (script-src 'self'), so it can grow without the CSP
// changing. Every page loads it; each part does nothing when its elements are missing.
// Everything works without it: it only saves reloads and adds keyboard shortcuts.
(() => {
  const root = document.documentElement;
  root?.classList.add('js');
  const narrow = () => window.matchMedia?.('(max-width: 900px)').matches;

  /** Preferences live in cookies, so the server renders them without a flash. */
  const remember = (name, value) => {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API isn't in every browser yet
    document.cookie = `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  };

  // Menus (<details class="menu">): one open at a time, closed by a click elsewhere or Escape.
  const menus = () => document.querySelectorAll('details.menu[open]');
  const closeMenus = (except) => {
    for (const menu of menus()) if (menu !== except) menu.open = false;
  };
  const side = document.getElementById('side');
  const toggleSide = (open) => {
    if (!side) return;
    side.classList.toggle('open', open);
    document.querySelector('[data-menu]')?.setAttribute('aria-expanded', String(open));
  };

  document.addEventListener('click', (e) => {
    const target = e.target;
    closeMenus(target.closest?.('details.menu'));

    // Copy buttons: [data-copy] is the id of the element to copy.
    const button = target.closest?.('[data-copy]');
    const source = button && document.getElementById(button.dataset.copy);
    if (source) {
      navigator.clipboard.writeText(source.textContent).then(() => {
        button.textContent = 'Copied';
        setTimeout(() => {
          button.textContent = 'Copy';
        }, 1500);
      });
      return;
    }
    // The sidebar's menu button on narrow screens.
    if (target.closest?.('[data-menu]')) {
      e.preventDefault();
      toggleSide(!side?.classList.contains('open'));
      return;
    }
    // A thread's Reply button first opens its reply box.
    const reply = target.closest?.('[data-reply]');
    if (reply?.form && !reply.form.classList.contains('replying')) {
      e.preventDefault();
      reply.form.classList.add('replying');
      reply.form.elements.namedItem('body')?.focus();
      return;
    }
    panelClick(e);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenus();
      toggleSide(false);
      return;
    }
    // "/" focuses the search box, unless the reader is typing somewhere.
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const search = document.querySelector('[data-search]');
      if (search) {
        e.preventDefault();
        search.focus();
        search.select();
      }
    }
  });

  document.addEventListener('submit', (e) => {
    const message = e.target.dataset?.confirm;
    if (message && !confirm(message)) {
      e.preventDefault();
      return;
    }
    if (e.target.matches?.('[data-theme-form]') && e.submitter?.value) {
      e.preventDefault();
      setTheme(e.submitter.value);
    }
  });

  // Forms that go as soon as a choice changes: the compare page's version pickers.
  document.addEventListener('change', (e) => {
    const form = e.target.closest?.('form[data-autosubmit]');
    if (form && e.target.matches('select')) form.requestSubmit();
  });

  // Theme: light, dark or system. The server reads the cookie; the frame hears it over its port.
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const theme = () => root?.dataset?.theme || (media?.matches ? 'dark' : 'light');
  const themeListeners = [];
  const setTheme = (choice) => {
    if (!['light', 'dark', 'system'].includes(choice)) return;
    remember('aa_theme', choice);
    if (choice === 'system') delete root.dataset.theme;
    else root.dataset.theme = choice;
    for (const b of document.querySelectorAll('[data-theme-form] button[name="theme"]')) {
      b.setAttribute('aria-pressed', String(b.value === choice));
    }
    for (const listener of themeListeners) listener();
  };
  media?.addEventListener?.('change', () => {
    for (const listener of themeListeners) listener();
  });

  // The artifact page's side panel: tabs are links (?panel=<tab>), shown here without a reload.
  const panel = document.getElementById('panel');
  const vbody = document.querySelector('.vbody');
  const panelToggle = document.querySelector('[data-panel-toggle]');
  let activeTab = document.querySelector('[data-tab][aria-selected="true"]')?.dataset.tab;
  const setUrl = (value) => {
    history.replaceState(null, '', `${location.pathname}?panel=${value}`);
  };
  const openPanel = (open) => {
    if (!panel) return;
    panel.hidden = !open;
    vbody?.classList.toggle('closed', !open);
    panelToggle?.setAttribute('aria-expanded', String(open));
    remember('aa_panel', open ? activeTab : 'closed');
    setUrl(open ? activeTab : 'closed');
  };
  const showTab = (name) => {
    if (!panel) return;
    activeTab = name;
    for (const tab of document.querySelectorAll('[data-tab]')) {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('on', on);
      tab.setAttribute('aria-selected', String(on));
    }
    for (const pane of document.querySelectorAll('[data-pane]')) {
      pane.hidden = pane.dataset.pane !== name;
    }
    openPanel(true);
    if (narrow()) panel.scrollIntoView({ block: 'start' });
  };
  const panelClick = (e) => {
    if (!panel) return;
    const link = e.target.closest?.('[data-tab], [data-tab-link]');
    if (link) {
      e.preventDefault();
      closeMenus();
      showTab(link.dataset.tab ?? link.dataset.tabLink);
      if (link.dataset.tabLink === 'details') document.querySelector('#rename input')?.focus();
    } else if (e.target.closest?.('[data-panel-close]')) {
      e.preventDefault();
      openPanel(false);
    } else if (e.target.closest?.('[data-panel-toggle]')) {
      e.preventDefault();
      openPanel(panel.hidden);
    }
  };

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
  // '*' because the sandboxed frame's origin is opaque and can't be named. So whatever is sent here may
  // be read by the artifact, or by any page it navigated its own frame to. That is acceptable for what
  // we send: comment quotes, which are the artifact's own text. Never send comment bodies, authors or
  // anything else from the app through this.
  const toFrame = (message) => frame?.contentWindow?.postMessage(message, '*');

  // Comments.
  const LIMITS = { exact: 2000, context: 32, quotes: 200 };
  const form = document.getElementById('new-comment');
  const selectButton = document.getElementById('comment-on-selection');
  const quoteBox = document.getElementById('new-quote');
  const quoteText = document.getElementById('new-quote-text');
  const field = (name) => form?.elements.namedItem(name);

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
    if (activeTab !== 'comments' || panel?.hidden) showTab('comments');
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
  // Live pages: window.openArtifacts in the frame calls the data API through this page, which holds
  // the session; the frame never sees a cookie or token. The artifact id comes from this page (the
  // iframe's data-artifact, set by the server), never from a message.
  //
  // Why a MessageChannel: answers carry the artifact's data, and the viewer's email. A message to
  // the frame's window must be posted with '*' (its origin is opaque), so it reaches whichever
  // document the frame shows when it is delivered: after a link click, some other site. A port
  // belongs to the one document it was transferred to and dies with it. So the frame gets one port,
  // in answer to the first aa:ready from the frame's window, and every call and answer goes over
  // it; only the transfer, which carries no data, uses '*'.
  //
  // One port per artifact page: a later aa:ready means the frame now shows another document (it
  // navigated, or reloaded itself), which gets aa:no-port. The first one is the document this page
  // put there: its bridge says ready as it loads, before the reader can click anything, and only
  // the artifact's own script could navigate away sooner, which could read its own data anyway.
  // The server checks the capability again on every call; the check here only saves a request.
  const artifactId = frame?.dataset.artifact;
  const json = (value, fallback) => {
    try {
      return JSON.parse(value ?? '') ?? fallback;
    } catch {
      return fallback;
    }
  };
  const capabilities = json(frame?.dataset.capabilities, {});
  const viewer = json(frame?.dataset.viewer, null);
  const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
  let channel = null;

  const fail = (code, message) => ({ code, message });
  const doc = (id) => {
    if (typeof id !== 'string' || !DOC_ID.test(id)) {
      throw fail('invalid_input', 'A document id is 1 to 128 characters of A-Z, a-z, 0-9, _ and -');
    }
    return `/data/${encodeURIComponent(id)}`;
  };
  const options = (value) => (value && typeof value === 'object' ? value : {});
  const search = (params) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    return `/data?${query}`;
  };
  // op -> [method, path, body, what of the answer the page gets]
  const OPS = new Map([
    ['get', ([id]) => ['GET', doc(id), null, (r) => r.doc]],
    ['set', ([id, data]) => ['PUT', doc(id), { data }, (r) => r.doc]],
    ['update', ([id, fields]) => ['PATCH', doc(id), { fields }, (r) => r.doc]],
    ['delete', ([id]) => ['DELETE', doc(id), null, (r) => r.deleted]],
    [
      'list',
      ([o]) => ['GET', search({ cursor: options(o).cursor, limit: options(o).limit }), null],
    ],
    ['query', ([o]) => ['POST', '/query', options(o), (r) => r.items]],
    ['changes', ([since]) => ['GET', search({ since: Number(since) }), null]],
  ]);

  const run = async (op, args) => {
    if (!capabilities.db) {
      throw fail('forbidden', "This artifact doesn't declare the db capability");
    }
    const [method, path, body, pick = (r) => r] = OPS.get(op)(args);
    let res;
    try {
      res = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        redirect: 'error',
      });
    } catch {
      throw fail('unavailable', 'Could not reach the app; reload the page to sign in again');
    }
    const answer = await res.json().catch(() => null);
    if (!res.ok) {
      throw fail(String(answer?.error ?? 'error'), String(answer?.message ?? `HTTP ${res.status}`));
    }
    return pick(answer);
  };

  const onCall = (port, data) => {
    if (!data || typeof data !== 'object' || !Number.isSafeInteger(data.id)) return;
    const reply = (message) => port.postMessage({ type: 'result', id: data.id, ...message });
    if (typeof data.op !== 'string' || !OPS.has(data.op) || !Array.isArray(data.args)) {
      reply({ ok: false, error: fail('invalid_input', 'Unknown call') });
      return;
    }
    run(data.op, data.args).then(
      (value) => reply({ ok: true, value }),
      (error) => reply({ ok: false, error: error?.code ? error : fail('error', String(error)) }),
    );
  };

  const grantPort = () => {
    if (!artifactId || !frame.contentWindow) return;
    if (channel) {
      toFrame({ type: 'aa:no-port' });
      return;
    }
    channel = new MessageChannel();
    const port = channel.port1;
    port.onmessage = (event) => onCall(port, event.data);
    frame.contentWindow.postMessage({ type: 'aa:port' }, '*', [channel.port2]);
    port.postMessage({ type: 'init', theme: theme(), viewer: capabilities.viewer ? viewer : null });
  };
  // The theme as the app shows it: the reader's choice, or the system's.
  themeListeners.push(() => channel?.port1.postMessage({ type: 'theme', theme: theme() }));

  // The bridge says when it is listening. The frame may also have loaded before this script ran,
  // so ask it to say so again.
  onFrameMessage('aa:ready', () => {
    sendHighlights();
    grantPort();
  });
  sendHighlights();
  toFrame({ type: 'aa:ping' });
})();
