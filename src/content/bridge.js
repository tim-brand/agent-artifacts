// The bridge, the one script the content host adds to a page. It does two things:
// - It defines `window.openArtifacts`, the runtime of live pages (see /docs/runtime in the app).
// - In the app's frame, it tells the app about the reader's text selection and highlights the
//   quotes the app sends back, for comments.
// The artifact shares this realm: it can replace anything here and post any message itself, so the
// app treats every message from the frame as untrusted and the server checks every data call.
(() => {
  const APP_ORIGIN = '__APP_ORIGIN__';
  const CONTEXT = 32;
  const MAX_EXACT = 2000;
  const MAX_QUOTES = 200;
  const MARK = 'data-aa-highlight';
  const POLL_MS = 3000;
  /** In the frame, ready resolves without a port after this long: db calls then reject. */
  const PORT_WAIT_MS = 5000;
  // Outside the app's frame (its own tab, or a public link) there is no shell to talk to.
  const framed = window.parent !== window;

  const whenLoaded = (fn) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else fn();
  };
  const report = (error) => console.error('openArtifacts:', error);

  // ---- window.openArtifacts ----
  // Every call goes over a MessagePort the app hands over once (see aa:port below), numbered so
  // each answer finds its promise.
  const fail = (code, message) => Object.assign(new Error(message), { code });
  let port = null;
  let settle;
  let nextId = 1;
  const pending = new Map();
  const themeListeners = new Set();
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)');

  const runtime = {
    ready: new Promise((resolve) => {
      settle = resolve;
    }),
    theme: dark?.matches ? 'dark' : 'light',
    /** { email, name } once ready, with the viewer capability; else null. */
    viewer: null,
    onTheme(cb) {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },
  };

  const setTheme = (theme) => {
    if ((theme !== 'light' && theme !== 'dark') || theme === runtime.theme) return;
    runtime.theme = theme;
    for (const cb of themeListeners) {
      try {
        cb(theme);
      } catch (error) {
        report(error);
      }
    }
  };

  const call = async (op, ...args) => {
    await runtime.ready;
    if (!port) {
      throw fail('no_shell', 'Live data works only when this page is opened in Agent Artifacts');
    }
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        port.postMessage({ id, op, args });
      } catch (error) {
        pending.delete(id);
        reject(fail('invalid_input', `Can't send that: ${error.message}`));
      }
    });
  };

  // subscribe(cb) calls cb({ docs, deleted, reset }) with every document first (reset: true), then
  // every 3 s while the tab is visible with what changed. Resolves to an unsubscribe function, after
  // the first call; rejects like any db call.
  const subscribe = async (cb) => {
    let rev = 0;
    let stopped = false;
    let busy = false;
    const deliver = (change) => {
      if (stopped) return;
      try {
        cb(change);
      } catch (error) {
        report(error);
      }
    };
    const readAll = async () => {
      const docs = [];
      let cursor;
      do {
        const page = await call('list', { cursor });
        docs.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return docs;
    };
    const poll = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        let more = true;
        while (more && !stopped) {
          const changes = await call('changes', rev);
          more = changes.more;
          if (changes.reset) {
            // Writes made while reading come again in the next poll; applying them twice is fine.
            deliver({ docs: await readAll(), deleted: [], reset: true });
          } else {
            const docs = changes.items.filter((item) => item.data !== null);
            const deleted = changes.items.filter((item) => item.data === null).map((i) => i.id);
            if (docs.length || deleted.length) deliver({ docs, deleted, reset: false });
          }
          rev = changes.rev;
        }
      } finally {
        busy = false;
      }
    };
    await poll();
    const tick = () => {
      if (document.visibilityState !== 'hidden') poll().catch(report);
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  };

  runtime.db = {
    get: (id) => call('get', id),
    set: (id, doc) => call('set', id, doc),
    update: (id, fields) => call('update', id, fields),
    delete: (id) => call('delete', id),
    list: (options = {}) => call('list', options),
    query: (options = {}) => call('query', options),
    subscribe,
  };
  window.openArtifacts = runtime;

  if (!framed) {
    dark?.addEventListener?.('change', (event) => setTheme(event.matches ? 'dark' : 'light'));
    settle();
    return;
  }
  setTimeout(settle, PORT_WAIT_MS);

  const onPortMessage = (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'init') {
      setTheme(data.theme);
      const v = data.viewer;
      runtime.viewer = v ? Object.freeze({ email: String(v.email), name: String(v.name) }) : null;
      settle();
    } else if (data.type === 'theme') {
      setTheme(data.theme);
    } else if (data.type === 'result' && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) resolve(data.value);
      else reject(fail(String(data.error?.code ?? 'error'), String(data.error?.message ?? '')));
    }
  };

  // ---- Messages from the app ----
  const send = (message) => window.parent.postMessage(message, APP_ORIGIN);
  const handlers = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== APP_ORIGIN) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    handlers.get(data.type)?.(data, event);
  });

  // The app's answer to aa:ready: the one port for runtime calls, or a refusal (it hands out one
  // port per artifact page, so a page the frame navigated to later gets none).
  handlers.set('aa:port', (_, event) => {
    if (port || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = onPortMessage;
  });
  // A duplicate aa:ready from this page also gets a refusal; by then the port has come (window
  // messages keep their order), and ready waits for its init.
  handlers.set('aa:no-port', () => {
    if (!port) settle();
  });

  // The page's text as quotes see it: whitespace runs collapsed to one space, script and style left
  // out. For each character, the text node and offset it came from.
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);
  const textModel = () => {
    const model = { text: '', nodes: [], firsts: [], nodeOf: [], offsetOf: [] };
    if (!document.body) return model;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        SKIP.has(node.parentNode?.nodeName.toUpperCase())
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const chars = [];
    let space = true;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = model.nodes.push(node) - 1;
      model.firsts.push(chars.length);
      const data = node.data;
      for (let offset = 0; offset < data.length; offset++) {
        const isSpace = /\s/.test(data[offset]);
        if (isSpace && space) continue;
        space = isSpace;
        chars.push(isSpace ? ' ' : data[offset]);
        model.nodeOf.push(index);
        model.offsetOf.push(offset);
      }
    }
    model.text = chars.join('');
    return model;
  };

  // Index in model.text of a DOM boundary point, such as a selection's start or end.
  const indexOf = (model, container, offset) => {
    const i = model.nodes.indexOf(container);
    if (i >= 0) {
      let k = model.firsts[i];
      while (k < model.nodeOf.length && model.nodeOf[k] === i && model.offsetOf[k] < offset) k++;
      return k;
    }
    const point = document.createRange();
    point.setStart(container, offset);
    for (let j = 0; j < model.nodes.length; j++) {
      if (point.comparePoint(model.nodes[j], 0) >= 0) return model.firsts[j];
    }
    return model.nodeOf.length;
  };

  // Lone surrogates left by a cut at the edges would not survive the trip to the database.
  const trimStart = (s) => s.replace(/^[\uDC00-\uDFFF]/, '');
  const trimEnd = (s) => s.replace(/[\uD800-\uDBFF]$/, '');

  let lastSent = '';
  const reportSelection = () => {
    const selection = document.getSelection();
    let quote = { exact: '', prefix: '', suffix: '' };
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      const model = textModel();
      const { text } = model;
      let start = indexOf(model, range.startContainer, range.startOffset);
      let end = indexOf(model, range.endContainer, range.endOffset);
      while (start < end && text[start] === ' ') start++;
      while (end > start && text[end - 1] === ' ') end--;
      end = Math.min(end, start + MAX_EXACT);
      const exact = trimEnd(text.slice(start, end));
      if (exact) {
        quote = {
          exact,
          prefix: trimStart(text.slice(Math.max(0, start - CONTEXT), start)),
          suffix: trimEnd(text.slice(start + exact.length, start + exact.length + CONTEXT)),
        };
      }
    }
    const key = JSON.stringify(quote);
    if (key === lastSent) return;
    lastSent = key;
    send({ type: 'aa:selection', ...quote });
  };
  let timer;
  document.addEventListener('selectionchange', () => {
    clearTimeout(timer);
    timer = setTimeout(reportSelection, 200);
  });

  // The first match whose prefix and suffix match too; else the first match.
  const find = (text, quote) => {
    let first = -1;
    for (let at = text.indexOf(quote.exact); at >= 0; at = text.indexOf(quote.exact, at + 1)) {
      if (first < 0) first = at;
      const end = at + quote.exact.length;
      const before = at >= quote.prefix.length && text.slice(at - quote.prefix.length, at);
      if (before === quote.prefix && text.startsWith(quote.suffix, end)) return at;
    }
    return first;
  };

  const wrap = (model, start, end) => {
    const first = model.nodeOf[start];
    const last = model.nodeOf[end - 1];
    for (let i = first; i <= last; i++) {
      let node = model.nodes[i];
      const from = i === first ? model.offsetOf[start] : 0;
      const to = i === last ? model.offsetOf[end - 1] + 1 : node.data.length;
      if (to <= from || !node.data.slice(from, to).trim()) continue;
      if (from > 0) node = node.splitText(from);
      if (to - from < node.data.length) node.splitText(to - from);
      const mark = document.createElement('mark');
      mark.setAttribute(MARK, '');
      node.replaceWith(mark);
      mark.append(node);
    }
  };

  const clean = (value, max) =>
    typeof value === 'string' && value.length <= max ? value.replace(/\s+/g, ' ') : null;

  handlers.set('aa:highlight', (data) => {
    if (!Array.isArray(data.quotes)) return;
    for (const mark of document.querySelectorAll(`mark[${MARK}]`)) {
      const parent = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parent.normalize();
    }
    const model = textModel();
    const ranges = [];
    for (const raw of data.quotes.slice(0, MAX_QUOTES)) {
      const exact = clean(raw?.exact, MAX_EXACT)?.trim();
      const prefix = clean(raw?.prefix, CONTEXT) ?? '';
      const suffix = clean(raw?.suffix, CONTEXT) ?? '';
      if (!exact) continue;
      const at = find(model.text, { exact, prefix, suffix });
      if (at >= 0) ranges.push([at, at + exact.length]);
    }
    // Wrapping splits text nodes, which moves the offsets after the split. Going from the end
    // backwards keeps every earlier range's offsets valid; overlapping ranges are dropped.
    ranges.sort((a, b) => a[0] - b[0]);
    const kept = [];
    for (const range of ranges) {
      if (kept.length === 0 || range[0] >= kept[kept.length - 1][1]) kept.push(range);
    }
    for (const [start, end] of kept.reverse()) wrap(model, start, end);
  });

  // Once the body is there to highlight in. The app also pings, in case it wasn't listening yet.
  const ready = () => whenLoaded(() => send({ type: 'aa:ready' }));
  handlers.set('aa:ping', ready);
  ready();
})();
