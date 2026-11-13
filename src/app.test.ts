import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { createApp } from './app.ts';
import type { Config } from './config.ts';
import { createCore } from './core/index.ts';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-app-'));
  const config: Config = {
    port: 0,
    dataDir: dir,
    appOrigin: 'https://app.test',
    contentOrigin: 'https://content.test',
    signingSecret: 'x'.repeat(32),
    devUser: null,
    authEmailHeader: 'X-authentik-email',
    authNameHeader: 'X-authentik-name',
    authMode: 'proxy',
    authUsers: [],
  };
  const core = createCore(config);
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const app = createApp({ config, ...core });
  return (path: string, host: string, headers: Record<string, string> = {}) =>
    app.request(`https://app.test${path}`, { headers: { host, ...headers } });
}

test('an unknown host gets a plain 404 that explains the setting, and never the UI', async (t) => {
  const get = setup(t);
  const res = await get('/', 'artifacts.example.org', { 'X-authentik-email': 'owner@example.com' });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
  const body = await res.text();
  assert.match(body, /Unknown host/);
  assert.match(body, /APP_ORIGIN and CONTENT_ORIGIN/);
  assert.match(body, /Host header/);
  assert.equal((await get('/mcp', 'artifacts.example.org')).status, 404);
});

test('the host is compared case-insensitively', async (t) => {
  const get = setup(t);
  const ui = await get('/', 'APP.Test', { 'X-authentik-email': 'owner@example.com' });
  assert.equal(ui.status, 200);
  assert.equal((await get('/healthz', 'App.TEST')).status, 200);
  const content = await get('/s/bad/x/1/index.html', 'Content.Test');
  assert.notEqual(content.status, 200);
  assert.doesNotMatch(await content.text(), /Unknown host/);
});

test('/healthz answers ok on any host, including the content host and a pod IP', async (t) => {
  const get = setup(t);
  for (const host of ['app.test', 'content.test', '10.42.0.17:3000', 'whatever.example.org']) {
    const res = await get('/healthz', host);
    assert.equal(res.status, 200, host);
    assert.equal(await res.text(), 'ok', host);
  }
});

test('the app host and the content host route as before', async (t) => {
  const get = setup(t);
  assert.equal((await get('/', 'app.test')).status, 401);
  const content = await get('/', 'content.test', { 'X-authentik-email': 'owner@example.com' });
  assert.equal(content.status, 404);
  assert.doesNotMatch(await content.text(), /Unknown host/);
});
