import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

// /static/app.js runs in a stand-in for the artifact page: just the elements and events it uses.
const SOURCE = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');

type Listener = (event: unknown) => void;

function element(extra: Record<string, unknown> = {}) {
  const listeners: Record<string, Listener> = {};
  return {
    hidden: true,
    open: true,
    value: '',
    textContent: '',
    focused: false,
    dataset: {} as Record<string, string>,
    listeners,
    addEventListener(type: string, fn: Listener) {
      listeners[type] = fn;
    },
    focus() {
      this.focused = true;
    },
    ...extra,
  };
}

function load(quotes: Record<string, string>[] = []) {
  const posted: [unknown, string][] = [];
  const frameWindow = {
    postMessage: (message: unknown, origin: string) => posted.push([message, origin]),
  };
  const frame = { contentWindow: frameWindow };
  const fields = { exact: element(), prefix: element(), suffix: element(), body: element() };
  const els: Record<string, ReturnType<typeof element>> = {
    comments: element(),
    'new-comment': element({
      elements: { namedItem: (name: keyof typeof fields) => fields[name] },
    }),
    'comment-on-selection': element(),
    'new-quote': element(),
    'new-quote-text': element(),
    'new-quote-clear': element(),
  };
  const windowListeners: Record<string, Listener> = {};
  const context = {
    window: {
      addEventListener: (type: string, fn: Listener) => {
        windowListeners[type] = fn;
      },
      matchMedia: () => ({ matches: false }),
    },
    document: {
      addEventListener: () => {},
      getElementById: (id: string) => els[id] ?? null,
      querySelector: (selector: string) => (selector === 'iframe.artifact' ? frame : null),
      querySelectorAll: (selector: string) =>
        selector === '[data-exact]' ? quotes.map((dataset) => ({ dataset })) : [],
    },
    location: { hash: '' },
  };
  runInNewContext(SOURCE, context);
  const message = (source: unknown, data: unknown) => windowListeners.message?.({ source, data });
  return { els, fields, posted, frameWindow, message };
}

const selection = { type: 'aa:selection', exact: 'some text', prefix: 'before ', suffix: ' after' };

describe('app.js frame bridge', () => {
  it('ignores a selection from any window but the artifact frame', () => {
    const { els, message } = load();
    message({}, selection);
    message(null, selection);
    message({ postMessage() {} }, selection);
    assert.equal(els['comment-on-selection']?.hidden, true);
  });

  it('offers "Comment on selection" and fills the new-comment form on click', () => {
    const { els, fields, message, frameWindow } = load();
    message(frameWindow, selection);
    const button = els['comment-on-selection'];
    assert.equal(button?.hidden, false);

    button?.listeners.click?.({});
    assert.equal(fields.exact.value, 'some text');
    assert.equal(fields.prefix.value, 'before ');
    assert.equal(fields.suffix.value, ' after');
    assert.equal(els['new-quote-text']?.textContent, 'some text');
    assert.equal(els['new-quote']?.hidden, false);
    assert.equal(fields.body.focused, true);
    assert.equal(button?.hidden, true);

    els['new-quote-clear']?.listeners.click?.({});
    assert.equal(fields.exact.value, '');
    assert.equal(els['new-quote']?.hidden, true);
  });

  it('hides the button when the selection is cleared', () => {
    const { els, message, frameWindow } = load();
    message(frameWindow, selection);
    message(frameWindow, { ...selection, exact: '', prefix: '', suffix: '' });
    assert.equal(els['comment-on-selection']?.hidden, true);
  });

  it('ignores malformed or oversized selections and unknown types', () => {
    const { els, message, frameWindow } = load();
    for (const data of [
      { ...selection, exact: 'x'.repeat(2001) },
      { ...selection, prefix: 'p'.repeat(33) },
      { ...selection, suffix: 42 },
      { ...selection, type: 'aa:navigate' },
      'aa:selection',
      null,
    ]) {
      message(frameWindow, data);
    }
    assert.equal(els['comment-on-selection']?.hidden, true);
  });

  it('sends open quotes to the frame at start and whenever the bridge is ready', () => {
    const quotes: Record<string, string>[] = [
      { exact: 'a', prefix: 'b', suffix: 'c' },
      { exact: 'd' },
    ];
    const { posted, message, frameWindow } = load(quotes);
    const expected = {
      type: 'aa:highlight',
      quotes: [
        { exact: 'a', prefix: 'b', suffix: 'c' },
        { exact: 'd', prefix: '', suffix: '' },
      ],
    };
    assert.equal(posted.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(posted[0])), [expected, '*']);
    message({}, { type: 'aa:ready' });
    assert.equal(posted.length, 1);
    message(frameWindow, { type: 'aa:ready' });
    assert.equal(posted.length, 2);
  });

  it('sends nothing when there is nothing to highlight', () => {
    const { posted, message, frameWindow } = load();
    message(frameWindow, { type: 'aa:ready' });
    assert.deepEqual(posted, []);
  });
});
