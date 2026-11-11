import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
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

type Fetched = { url: string; method: string; body: unknown };

/** Ports the frame got, closed after the tests so the process can exit. */
const ports: MessagePort[] = [];
after(() => {
  for (const port of ports) port.close();
});

function load(
  quotes: Record<string, string>[] = [],
  dataset: Record<string, string> = {},
  answer: (f: Fetched) => [number, unknown] = () => [200, { doc: null }],
) {
  const posted: [unknown, string][] = [];
  const received: unknown[] = [];
  let port: MessagePort | undefined;
  const frameWindow = {
    postMessage: (message: unknown, origin: string, transfer?: MessagePort[]) => {
      posted.push([message, origin]);
      for (const p of transfer ?? []) {
        ports.push(p);
        port ??= p;
        p.onmessage = (event) => received.push(event.data);
      }
    },
  };
  const frame = { contentWindow: frameWindow, dataset };
  const fetched: Fetched[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const f = {
      url,
      method: init.method ?? 'GET',
      body: init.body && JSON.parse(String(init.body)),
    };
    fetched.push(f);
    const [status, body] = answer(f);
    return new Response(JSON.stringify(body), { status });
  };
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
    MessageChannel,
    URLSearchParams,
    fetch,
  };
  runInNewContext(SOURCE, context);
  const message = (source: unknown, data: unknown) => windowListeners.message?.({ source, data });
  /** A runtime call from the frame over its port, and the shell's answer. */
  const call = async (op: string, ...args: unknown[]) => {
    assert.ok(port, 'the frame has no port');
    const id = received.length + 1000;
    port.postMessage({ id, op, args });
    for (let i = 0; i < 50; i++) {
      const found = received.find((r) => (r as { id?: number }).id === id);
      if (found) return found as { ok: boolean; value?: unknown; error?: { code: string } };
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`no answer to ${op}`);
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    els,
    fields,
    posted,
    received,
    fetched,
    frameWindow,
    message,
    call,
    settle,
    hasPort: () => port !== undefined,
  };
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
    const highlights = () =>
      posted.filter(([m]) => (m as { type: string }).type === 'aa:highlight');
    assert.equal(highlights().length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(highlights()[0])), [expected, '*']);
    message({}, { type: 'aa:ready' });
    assert.equal(highlights().length, 1);
    message(frameWindow, { type: 'aa:ready' });
    assert.equal(highlights().length, 2);
  });

  it('sends nothing but a ping when there is nothing to highlight', () => {
    const { posted, message, frameWindow } = load();
    message(frameWindow, { type: 'aa:ready' });
    assert.deepEqual(JSON.parse(JSON.stringify(posted)), [[{ type: 'aa:ping' }, '*']]);
  });
});

const LIVE = { artifact: 'live1', capabilities: '{"db":true,"viewer":true}' };
const VIEWER = { email: 'owner@example.com', name: 'Owner' };

describe('app.js runtime bridge', () => {
  it('hands a port only to the frame window, once; later documents are refused', async () => {
    const { posted, message, frameWindow, received, hasPort, settle } = load([], {
      ...LIVE,
      viewer: JSON.stringify(VIEWER),
    });
    message({}, { type: 'aa:ready' });
    message({ postMessage() {} }, { type: 'aa:ready' });
    assert.equal(hasPort(), false);

    message(frameWindow, { type: 'aa:ready' });
    await settle();
    assert.equal(hasPort(), true);
    // The transfer itself carries no data; the init with the viewer goes over the port.
    const transfer = posted.find(([m]) => (m as { type: string }).type === 'aa:port');
    assert.deepEqual(JSON.parse(JSON.stringify(transfer)), [{ type: 'aa:port' }, '*']);
    assert.deepEqual(JSON.parse(JSON.stringify(received)), [
      { type: 'init', theme: 'light', viewer: VIEWER },
    ]);

    message(frameWindow, { type: 'aa:ready' });
    const ports = posted.filter(([m]) => (m as { type: string }).type === 'aa:port');
    assert.equal(ports.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), [{ type: 'aa:no-port' }, '*']);
  });

  it('sends no viewer without the viewer capability, even when the page has one', async () => {
    const { message, frameWindow, received, settle } = load([], {
      artifact: 'a1',
      capabilities: '{"db":true}',
      viewer: JSON.stringify(VIEWER),
    });
    message(frameWindow, { type: 'aa:ready' });
    await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(received)), [
      { type: 'init', theme: 'light', viewer: null },
    ]);
  });

  it('refuses db calls the artifact did not declare, without a request', async () => {
    const { message, frameWindow, call, fetched } = load([], {
      artifact: 'a1',
      capabilities: '{"viewer":true}',
    });
    message(frameWindow, { type: 'aa:ready' });
    const answer = await call('get', 'x');
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.code, 'forbidden');
    assert.deepEqual(fetched, []);
  });

  it("calls the API for the page's own artifact, whatever the message says", async () => {
    const { message, frameWindow, call, fetched } = load([], LIVE, (f) =>
      f.method === 'PUT'
        ? [200, { doc: { id: 'v1', data: f.body } }]
        : [403, { error: 'forbidden', message: 'no' }],
    );
    message(frameWindow, { type: 'aa:ready', artifact: 'other' });
    const set = await call('set', 'v1', { option: 'Pizza' }, 'other');
    assert.equal(set.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(set.value)), {
      id: 'v1',
      data: { data: { option: 'Pizza' } },
    });
    const denied = await call('list', { cursor: 'abc', limit: 5 });
    assert.equal(denied.error?.code, 'forbidden');
    await call('query', { where: { done: false } });
    await call('changes', 7);
    await call('delete', 'v1');
    assert.deepEqual(
      fetched.map((f) => [f.method, f.url]),
      [
        ['PUT', '/api/artifacts/live1/data/v1'],
        ['GET', '/api/artifacts/live1/data?cursor=abc&limit=5'],
        ['POST', '/api/artifacts/live1/query'],
        ['GET', '/api/artifacts/live1/data?since=7'],
        ['DELETE', '/api/artifacts/live1/data/v1'],
      ],
    );
  });

  it('rejects bad document ids and unknown calls without a request', async () => {
    const { message, frameWindow, call, fetched } = load([], LIVE);
    message(frameWindow, { type: 'aa:ready' });
    for (const id of ['../x', 'a/b', '', 'x'.repeat(129), 42]) {
      assert.equal((await call('get', id)).error?.code, 'invalid_input');
    }
    assert.equal((await call('fetch', '/settings/tokens')).error?.code, 'invalid_input');
    assert.equal((await call('constructor')).error?.code, 'invalid_input');
    assert.deepEqual(fetched, []);
  });
});
