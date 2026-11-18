import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

// bridge.js in a stand-in for an artifact page: in the app's frame, or on its own.
const APP = 'https://app.test';
const SOURCE = readFileSync(new URL('./bridge.js', import.meta.url), 'utf8').replace(
  "'__APP_ORIGIN__'",
  JSON.stringify(APP),
);

type Runtime = {
  ready: Promise<void>;
  theme: string;
  viewer: { email: string; name: string } | null;
  db: Record<string, (...args: unknown[]) => Promise<unknown>>;
};

const channels: MessageChannel[] = [];
after(() => {
  for (const c of channels) {
    c.port1.close();
    c.port2.close();
  }
});

/**
 * `styled`: the page has the content host's style link, from the start or (`linkLate`) only once
 * the document has loaded, as on a rendered markdown page. `loading`: the document is still loading,
 * so DOMContentLoaded comes later, through `loaded()`.
 */
function load(
  framed: boolean,
  page: { styled?: boolean; linkLate?: boolean; loading?: boolean } = {},
) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const docListeners: Record<string, (() => void)[]> = {};
  const attributes: [string, string][] = [];
  /** Listeners for a change of the system's light or dark setting. */
  const systemTheme: ((event: { matches: boolean }) => void)[] = [];
  let linked = page.styled === true && page.linkLate !== true;
  const document = {
    readyState: page.loading ? 'loading' : 'complete',
    addEventListener: (type: string, fn: () => void) => {
      docListeners[type] = [...(docListeners[type] ?? []), fn];
    },
    visibilityState: 'visible',
    querySelector: (selector: string) =>
      selector === 'link[data-aa-style]' && linked ? { rel: 'stylesheet' } : null,
    documentElement: {
      setAttribute: (name: string, value: string) => attributes.push([name, value]),
    },
  };
  const loaded = () => {
    linked = page.styled === true;
    document.readyState = 'interactive';
    for (const fn of docListeners.DOMContentLoaded ?? []) fn();
  };
  const posted: [unknown, string][] = [];
  const parent = { postMessage: (m: unknown, origin: string) => posted.push([m, origin]) };
  const timers: (() => void)[] = [];
  const window: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    matchMedia: () => ({
      matches: true,
      addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => {
        systemTheme.push(fn);
      },
    }),
  };
  window.parent = framed ? parent : window;
  runInNewContext(SOURCE, {
    window,
    document,
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  });
  const runtime = window.openArtifacts as Runtime;
  const fromParent = (data: unknown, extra: Record<string, unknown> = {}) =>
    listeners.message?.({ source: parent, origin: APP, data, ports: [], ...extra });
  const setSystemTheme = (theme: 'light' | 'dark') => {
    for (const fn of systemTheme) fn({ matches: theme === 'dark' });
  };
  return {
    runtime,
    posted,
    fromParent,
    listeners,
    parent,
    timers,
    attributes,
    loaded,
    setSystemTheme,
  };
}

/** Hands the bridge a port, as the app does, and returns the app's end of it. */
function connect(fromParent: ReturnType<typeof load>['fromParent']) {
  const channel = new MessageChannel();
  channels.push(channel);
  fromParent({ type: 'aa:port' }, { ports: [channel.port2] });
  return channel.port1;
}

/** Lets messages posted on a MessagePort arrive. */
const settleMessages = () => new Promise((resolve) => setImmediate(resolve));

const code = (c: string) => (error: unknown) => (error as { code?: string }).code === c;

describe('bridge.js outside the app', () => {
  it('is ready at once, with no viewer, and db calls reject with no_shell', async () => {
    const { runtime, posted } = load(false);
    await runtime.ready;
    assert.equal(runtime.viewer, null);
    assert.equal(runtime.theme, 'dark');
    await assert.rejects(runtime.db.get?.('a') as Promise<unknown>, code('no_shell'));
    await assert.rejects(runtime.db.set?.('a', {}) as Promise<unknown>, code('no_shell'));
    await assert.rejects(runtime.db.subscribe?.(() => {}) as Promise<unknown>, code('no_shell'));
    assert.deepEqual(posted, []);
  });
});

describe('bridge.js in the frame', () => {
  it('says ready to the app origin only, and takes a port only from the parent', async () => {
    const { runtime, posted, fromParent, listeners } = load(true);
    assert.deepEqual(JSON.parse(JSON.stringify(posted)), [[{ type: 'aa:ready' }, APP]]);

    const channel = new MessageChannel();
    channels.push(channel);
    const asked: unknown[] = [];
    channel.port1.onmessage = (event) => {
      asked.push(event.data);
      channel.port1.postMessage({ type: 'result', id: event.data.id, ok: true, value: 'answer' });
    };
    // Wrong origin, wrong source: ignored. Had the bridge taken the decoy, ready would never come.
    const decoy = new MessageChannel();
    channels.push(decoy);
    fromParent({ type: 'aa:port' }, { origin: 'null', ports: [decoy.port2] });
    listeners.message?.({
      source: {},
      origin: APP,
      data: { type: 'aa:port' },
      ports: [decoy.port2],
    });
    fromParent({ type: 'aa:port' }, { ports: [channel.port2] });
    channel.port1.postMessage({
      type: 'init',
      theme: 'light',
      viewer: { email: 'a@b', name: 'A' },
    });
    await runtime.ready;
    assert.deepEqual({ ...runtime.viewer }, { email: 'a@b', name: 'A' });
    assert.equal(runtime.theme, 'light');

    assert.equal(await runtime.db.get?.('doc1'), 'answer');
    assert.deepEqual(asked, [{ id: 1, op: 'get', args: ['doc1'] }]);
    // Can't-clone input rejects instead of throwing.
    await assert.rejects(
      runtime.db.set?.('x', { f() {} }) as Promise<unknown>,
      code('invalid_input'),
    );
  });

  it('rejects with no_shell when the app refuses a port, and answers a ping', async () => {
    const { runtime, posted, fromParent } = load(true);
    fromParent({ type: 'aa:no-port' });
    await runtime.ready;
    await assert.rejects(runtime.db.list?.() as Promise<unknown>, code('no_shell'));
    fromParent({ type: 'aa:ping' });
    assert.equal(posted.length, 2);
  });

  it('gives up waiting for a port after a while', async () => {
    const { runtime, timers } = load(true);
    for (const fn of timers) fn();
    await runtime.ready;
    await assert.rejects(runtime.db.get?.('a') as Promise<unknown>, code('no_shell'));
  });
});

describe('bridge.js on a styled page', () => {
  it('sets data-aa-theme on a styled page after it loads', () => {
    const { attributes, loaded } = load(true, { styled: true, linkLate: true, loading: true });
    assert.deepEqual(attributes, []);
    loaded();
    assert.deepEqual(attributes, [['data-aa-theme', 'dark']]);
  });

  it('sets it at once when the link is already there', () => {
    const { attributes } = load(true, { styled: true });
    assert.deepEqual(attributes.at(-1), ['data-aa-theme', 'dark']);
  });

  it("follows the app's theme", async () => {
    const { attributes, fromParent, runtime } = load(true, { styled: true });
    const port = connect(fromParent);
    port.postMessage({ type: 'init', theme: 'dark', viewer: null });
    await runtime.ready;
    port.postMessage({ type: 'theme', theme: 'light' });
    await settleMessages();
    assert.deepEqual(attributes.at(-1), ['data-aa-theme', 'light']);
    port.postMessage({ type: 'theme', theme: 'dark' });
    await settleMessages();
    assert.deepEqual(attributes.at(-1), ['data-aa-theme', 'dark']);
  });

  it('leaves unstyled pages and pages outside the app alone', async () => {
    const plain = load(true, { loading: true });
    plain.loaded();
    const port = connect(plain.fromParent);
    port.postMessage({ type: 'init', theme: 'light', viewer: null });
    await plain.runtime.ready;
    assert.deepEqual(plain.attributes, []);

    const outside = load(false, { styled: true, loading: true });
    outside.loaded();
    outside.setSystemTheme('light');
    assert.equal(outside.runtime.theme, 'light');
    assert.deepEqual(outside.attributes, []);
  });
});
