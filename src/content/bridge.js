// The frame bridge, the one script the content host adds to a page: html and markdown entries opened
// through the app's signed links. It tells the app about the reader's text selection and highlights
// the quotes the app sends back. Nothing else. The artifact shares this realm and can post any
// message itself, so the app treats every message from the frame as untrusted.
(() => {
  const APP_ORIGIN = '__APP_ORIGIN__';
  const CONTEXT = 32;
  const MAX_EXACT = 2000;
  const MAX_QUOTES = 200;
  const MARK = 'data-aa-highlight';
  if (window.parent === window) return;

  const send = (message) => window.parent.postMessage(message, APP_ORIGIN);
  const handlers = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== APP_ORIGIN) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    handlers.get(data.type)?.(data);
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

  const ready = () => send({ type: 'aa:ready' });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
