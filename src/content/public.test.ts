import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { createCore } from '../core/index.ts';
import { createRateLimiter } from './rate-limit.ts';
import { createContentRoutes } from './routes.ts';

const CONTENT = 'https://content.test';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-'));
  const config: Config = {
    port: 0,
    dataDir: join(dir, 'data'),
    appOrigin: 'https://app.test',
    contentOrigin: CONTENT,
    signingSecret: 'x'.repeat(32),
    devUser: null,
    authEmailHeader: 'X-authentik-email',
    authNameHeader: 'X-authentik-name',
  };
  const core = createCore(config);
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const app = createContentRoutes({ config, ...core });
  let ip = 0;
  // A fresh client IP per request by default, so only the rate limit test meets the limit.
  const get = (path: string, init: RequestInit & { ip?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    const forwarded = init.ip === undefined ? `10.0.0.${++ip}` : init.ip;
    if (forwarded !== null) headers.set('x-forwarded-for', forwarded);
    return app.request(`${CONTENT}${path}`, { ...init, headers });
  };
  const site = (text: string) => ({
    files: {
      'docs/index.html': `<h1>${text}</h1><script src="app.js"></script>`,
      'docs/app.js': `console.log(${JSON.stringify(text)})`,
    },
    entry: 'docs/index.html',
    format: 'html' as const,
  });
  return { ...core, get, site };
}

function assertPublicHeaders(res: Response) {
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'$/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('set-cookie'), null);
}

test('a link opens its entry, with relative links and the public headers', async (t) => {
  const { artifacts, shareLinks, get, site } = setup(t);
  const { id } = await artifacts.publish({ title: 'Site', ...site('one') }, 'a');
  const { token } = await shareLinks.create(id);

  for (const path of [`/p/${token}/`, `/p/${token}`]) {
    const res = await get(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), `/p/${token}/docs/index.html`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assertPublicHeaders(res);
  }

  const page = await get(`/p/${token}/docs/index.html`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<h1>one</h1><script src="app.js"></script>');
  assert.match(page.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts /);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assertPublicHeaders(page);

  const script = await get(new URL('app.js', `${CONTENT}/p/${token}/docs/index.html`).pathname);
  assert.equal(script.status, 200);
  assert.equal(await script.text(), 'console.log("one")');
});

test('markdown renders as under /s/', async (t) => {
  const { artifacts, shareLinks, get } = setup(t);
  const { id } = await artifacts.publish(
    { title: 'Doc <x>', content: '# Hello', format: 'markdown' },
    'a',
  );
  const { token } = await shareLinks.create(id);
  const res = await get(`/p/${token}/README.md`);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await res.text();
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /<title>Doc &lt;x&gt;<\/title>/);
  const raw = await get(`/p/${token}/README.md?raw=1`);
  assert.equal(await raw.text(), '# Hello');
});

test('public links never get the comment bridge, which /s/ adds to the same entries', async (t) => {
  const { artifacts, shareLinks, signer, get, site } = setup(t);
  const html = await artifacts.publish({ title: 'Site', ...site('one') }, 'a');
  const md = await artifacts.publish({ title: 'Doc', content: '# Hi', format: 'markdown' }, 'a');
  for (const [id, entry] of [
    [html.id, 'docs/index.html'],
    [md.id, 'README.md'],
  ] as const) {
    const signed = await get(new URL(signer.url(id, 1, entry)).pathname);
    assert.match(
      await signed.text(),
      /<script src="\/_aa\/bridge\.js\?v=[0-9a-f]{16}"><\/script>\n/,
    );

    const { token } = await shareLinks.create(id);
    const pinned = await shareLinks.create(id, { version: 1 });
    for (const link of [token, pinned.token]) {
      const res = await get(`/p/${link}/${entry}`);
      assert.equal(res.status, 200);
      assert.doesNotMatch(await res.text(), /bridge\.js/, entry);
      assert.doesNotMatch(res.headers.get('etag') ?? '', /bridge/);
    }
  }
});

test('a public live page gets the bridge, in its no-shell form, so it does not crash', async (t) => {
  const { artifacts, shareLinks, get } = setup(t);
  const page = '<!doctype html><html><body><script>openArtifacts.ready</script></body></html>';
  const live = await artifacts.publish(
    { title: 'Poll', content: page, format: 'html', capabilities: { db: true } },
    'a',
  );
  const { token } = await shareLinks.create(live.id);
  const res = await get(`/p/${token}/index.html`);
  assert.equal(res.status, 200);
  assertPublicHeaders(res);
  assert.match(
    await res.text(),
    /^<!doctype html>\n<script src="\/_aa\/bridge\.js\?v=[0-9a-f]{16}">/,
  );
  assert.match(res.headers.get('etag') ?? '', /-bridge-/);
  // Only on the entry, and not on markdown, which has no runtime to use.
  assert.doesNotMatch(await (await get(`/p/${token}/index.html?raw=1`)).text(), /bridge\.js/);
  const md = await artifacts.publish(
    { title: 'Doc', content: '# Hi', format: 'markdown', capabilities: { db: true } },
    'a',
  );
  const mdLink = await shareLinks.create(md.id);
  assert.doesNotMatch(await (await get(`/p/${mdLink.token}/README.md`)).text(), /bridge\.js/);
});

test('a latest link follows new versions; a pinned one stays and may be cached', async (t) => {
  const { artifacts, shareLinks, get, site } = setup(t);
  const { id } = await artifacts.publish({ title: 'Site', ...site('one') }, 'a');
  const latest = await shareLinks.create(id);
  const pinned = await shareLinks.create(id, { version: 1 });
  await artifacts.publish({ id, ...site('two') }, 'a');

  const body = async (token: string) => (await get(`/p/${token}/docs/app.js`)).text();
  assert.equal(await body(latest.token), 'console.log("two")');
  assert.equal(await body(pinned.token), 'console.log("one")');

  const res = await get(`/p/${pinned.token}/docs/app.js`);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
  assertPublicHeaders(res);
  const etag = res.headers.get('etag') ?? '';
  const cached = await get(`/p/${pinned.token}/docs/app.js`, {
    headers: { 'if-none-match': etag },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get('cache-control'), 'private, max-age=300');
});

test('unknown, malformed, revoked, expired and deleted links get the same 404; undelete restores', async (t) => {
  const { artifacts, shareLinks, get, site } = setup(t);
  const { id } = await artifacts.publish({ title: 'Site', ...site('one') }, 'a');
  const make = async (expiresAt?: string) => (await shareLinks.create(id, { expiresAt })).token;
  const revoked = await shareLinks.create(id);
  const expiring = await make(new Date(Date.now() + 60_000).toISOString());
  const kept = await make();
  await shareLinks.revoke(id, revoked.link.id);

  const notFound = async (path: string, init?: RequestInit) => {
    const res = await get(path, init);
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), 'Not found');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assertPublicHeaders(res);
  };

  const unknown = `sl_${'A'.repeat(43)}`;
  for (const token of [unknown, revoked.token, `${kept}A`, kept.slice(0, -1), 'sl_x', 'x']) {
    await notFound(`/p/${token}/docs/index.html`);
    await notFound(`/p/${token}/`);
  }
  await notFound(`/p/${kept}/docs/missing.html`);
  await notFound(`/p/${kept}/docs/..%2Fdocs%2Findex.html`);
  await notFound(`/p/${kept}/docs/index.html`, { method: 'POST' });
  await notFound('/p/');

  assert.equal((await get(`/p/${expiring}/docs/index.html`)).status, 200);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_001 });
  await notFound(`/p/${expiring}/docs/index.html`);
  t.mock.timers.reset();

  assert.equal((await get(`/p/${kept}/docs/index.html`)).status, 200);
  await artifacts.delete(id);
  await notFound(`/p/${kept}/docs/index.html`);
  await notFound(`/p/${kept}/`);

  await artifacts.undelete(id);
  assert.equal((await get(`/p/${kept}/docs/index.html`)).status, 200);
  await notFound(`/p/${revoked.token}/docs/index.html`);
});

test('/p/ is rate limited per client IP, from the first X-Forwarded-For entry', async (t) => {
  const { get } = setup(t);
  const path = `/p/sl_${'A'.repeat(43)}/`;
  for (let i = 0; i < 60; i++) {
    assert.equal((await get(path, { ip: '1.2.3.4, 10.0.0.1' })).status, 404);
  }
  const limited = await get(path, { ip: '1.2.3.4, 10.0.0.2' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '1');
  assertPublicHeaders(limited);
  assert.equal((await get(path, { ip: '5.6.7.8, 1.2.3.4' })).status, 404);

  // Without the header everyone shares one bucket.
  for (let i = 0; i < 60; i++) assert.equal((await get(path, { ip: null })).status, 404);
  assert.equal((await get(path, { ip: null })).status, 429);
});

test('the rate limiter refills over time and forgets idle clients', () => {
  const limiter = createRateLimiter({ capacity: 2, perMinute: 60, maxKeys: 2 });
  assert.equal(limiter.take('a', 0), true);
  assert.equal(limiter.take('a', 0), true);
  assert.equal(limiter.take('a', 0), false);
  assert.equal(limiter.take('a', 999), false);
  assert.equal(limiter.take('a', 1000), true);
  assert.equal(limiter.take('a', 1000), false);

  assert.equal(limiter.take('b', 1000), true);
  // A third client while both are busy: the map is reset rather than grown.
  assert.equal(limiter.take('c', 1000), true);
  assert.equal(limiter.take('a', 1000), true);
});
