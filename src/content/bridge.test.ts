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

function load(framed: boolean) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const posted: [unknown, string][] = [];
  const parent = { postMessage: (m: unknown, origin: string) => posted.push([m, origin]) };
  const timers: (() => void)[] = [];
  const window: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    matchMedia: () => ({ matches: true }),
  };
  window.parent = framed ? parent : window;
  runInNewContext(SOURCE, {
    window,
    document: { readyState: 'complete', addEventListener: () => {}, visibilityState: 'visible' },
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  });
  const runtime = window.openArtifacts as Runtime;
  const fromParent = (data: unknown, extra: Record<string, unknown> = {}) =>
    listeners.message?.({ source: parent, origin: APP, data, ports: [], ...extra });
  return { runtime, posted, fromParent, listeners, parent, timers };
}

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
