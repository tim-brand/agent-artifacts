import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Config } from '../config.ts';
import {
  AppError,
  type Artifact,
  type ArtifactService,
  type ContentSigner,
  type Deps,
  type TokenInfo,
  type TokenService,
  type Version,
} from '../contracts.ts';
import { createUiRoutes } from './routes.ts';

const APP = 'https://app.test';
const CONTENT = 'https://content.test';
const USER = { 'X-authentik-email': 'owner@example.com' };

function artifact(id: string, format: Artifact['format'], title: string, versions = 1): Artifact {
  return {
    id,
    title,
    description: 'A <b>description</b>',
    format,
    latestVersion: versions,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function version(a: Artifact, n: number, entry: string): Version {
  return {
    artifactId: a.id,
    version: n,
    entry,
    format: a.format,
    files: [
      { path: entry, size: 10, contentType: 'text/html', sha256: 'x' },
      { path: 'style.css', size: 2048, contentType: 'text/css', sha256: 'y' },
    ],
    createdAt: '2026-01-02T00:00:00.000Z',
    publishedBy: `agent-${n}`,
  };
}

function fakeDeps(overrides: { config?: Partial<Config>; artifacts?: Partial<ArtifactService> }) {
  const list: Artifact[] = [
    artifact('a1', 'html', '<script>alert(1)</script>', 3),
    artifact('p1', 'pdf', 'A PDF'),
  ];
  const deleted: string[] = [];
  const artifacts: ArtifactService = {
    publish: async () => {
      throw new Error('not used');
    },
    get: async (id, n) => {
      const a = list.find((x) => x.id === id);
      const v = n ?? a?.latestVersion;
      if (!a || !v || v > a.latestVersion) return null;
      return {
        artifact: a,
        version: version(a, v, a.format === 'pdf' ? 'document.pdf' : 'index.html'),
      };
    },
    readFile: async () => null,
    list: async (query) => ({
      items: list.filter((a) => !query?.format || a.format === query.format),
      nextCursor: query?.cursor ? null : 'next-page',
    }),
    listVersions: async (id) => {
      const a = list.find((x) => x.id === id);
      if (!a) return null;
      return Array.from({ length: a.latestVersion }, (_, i) =>
        version(a, a.latestVersion - i, 'index.html'),
      );
    },
    delete: async (id) => {
      deleted.push(id);
      return list.some((a) => a.id === id);
    },
    ...overrides.artifacts,
  };

  const stored: TokenInfo[] = [];
  const tokens: TokenService = {
    create: async (name) => {
      const info = {
        id: `t${stored.length + 1}`,
        name,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      stored.push(info);
      return { token: `aa_secret${stored.length}`, info };
    },
    list: async () => [...stored],
    revoke: async (id) => stored.some((t) => t.id === id),
    verify: async () => null,
  };

  const signer: ContentSigner = {
    url: (id, v, path) => `${CONTENT}/s/9.sig/${id}/${v}/${path}`,
    verify: () => true,
  };

  const config: Config = {
    port: 0,
    dataDir: '/tmp',
    appOrigin: APP,
    contentOrigin: CONTENT,
    signingSecret: 'x'.repeat(32),
    devUser: null,
    ...overrides.config,
  };
  const deps: Deps = { config, artifacts, tokens, signer };
  return { app: createUiRoutes(deps), deleted };
}

const get = (app: ReturnType<typeof fakeDeps>['app'], path: string) =>
  app.request(`${APP}${path}`, { headers: USER });

const post = (
  app: ReturnType<typeof fakeDeps>['app'],
  path: string,
  body: Record<string, string>,
  origin?: string,
) =>
  app.request(`${APP}${path}`, {
    method: 'POST',
    headers: {
      ...USER,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(origin ? { Origin: origin } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });

describe('auth', () => {
  it('returns 401 without user header or devUser', async () => {
    const { app } = fakeDeps({});
    const res = await app.request(`${APP}/`);
    assert.equal(res.status, 401);
    assert.match(await res.text(), /Not signed in/);
  });

  it('uses devUser when there is no header, and shows the user', async () => {
    const { app } = fakeDeps({ config: { devUser: 'dev@local' } });
    const res = await app.request(`${APP}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /dev@local/);
  });

  it('never serves the UI under /mcp', async () => {
    const { app } = fakeDeps({});
    const res = await get(app, '/mcp/anything');
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /owner@example\.com/);
  });
});

describe('list', () => {
  it('renders titles escaped, newest first, with load more and security headers', async () => {
    const { app } = fakeDeps({});
    const res = await get(app, '/');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!body.includes('<script>alert(1)'));
    assert.ok(body.indexOf('alert(1)') < body.indexOf('A PDF'));
    assert.match(body, /3 versions/);
    assert.match(body, /href="\/\?cursor=next-page"/);
    assert.match(body, /owner@example\.com/);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /frame-src https:\/\/content\.test/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
  });

  it('filters by format and keeps it in the load more link', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/?format=pdf')).text();
    assert.ok(body.includes('A PDF'));
    assert.ok(!body.includes('alert(1)'));
    assert.match(body, /href="\/\?format=pdf&amp;cursor=next-page"/);
  });

  it('shows an empty state that points to /connect', async () => {
    const { app } = fakeDeps({
      artifacts: { list: async () => ({ items: [], nextCursor: null }) },
    });
    const body = await (await get(app, '/')).text();
    assert.match(body, /href="\/connect">Connect an agent/);
  });
});

describe('artifact page', () => {
  it('sandboxes html artifacts without allow-same-origin', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1')).text();
    const iframe = body.match(/<iframe[^>]*>/)?.[0] ?? '';
    assert.match(iframe, /src="https:\/\/content\.test\/s\/9\.sig\/a1\/3\/index\.html"/);
    assert.match(iframe, /sandbox="allow-scripts allow-popups/);
    assert.doesNotMatch(iframe, /allow-same-origin/);
    assert.ok(body.includes('A &lt;b&gt;description&lt;/b&gt;'));
    assert.match(body, /href="https:\/\/content\.test\/s\/9\.sig\/a1\/3\/style\.css"/);
    assert.match(body, /Open in new tab/);
  });

  it('gives pdf artifacts no sandbox', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/p1')).text();
    const iframe = body.match(/<iframe[^>]*>/)?.[0] ?? '';
    assert.match(iframe, /document\.pdf/);
    assert.doesNotMatch(iframe, /sandbox/);
  });

  it('shows the requested version', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1/v/2')).text();
    assert.match(body, /<iframe[^>]*src="https:\/\/content\.test\/s\/9\.sig\/a1\/2\/index\.html"/);
    assert.match(body, /<a href="\/a\/a1\/v\/2" aria-current="page">v2 · agent-2/);
    assert.match(body, /Version 2 of 3/);
  });

  it('returns 404 for unknown artifacts and versions', async () => {
    const { app } = fakeDeps({});
    assert.equal((await get(app, '/a/nope')).status, 404);
    assert.equal((await get(app, '/a/a1/v/9')).status, 404);
    assert.equal((await get(app, '/a/a1/v/abc')).status, 404);
    assert.equal((await get(app, '/nowhere')).status, 404);
  });

  it('maps AppError not_found to 404 and other errors to a 500 without details', async () => {
    const notFound = fakeDeps({
      artifacts: {
        get: async () => {
          throw new AppError('not_found', 'gone');
        },
      },
    });
    assert.equal((await get(notFound.app, '/a/a1')).status, 404);

    const broken = fakeDeps({
      artifacts: {
        get: async () => {
          throw new Error('secret database detail');
        },
      },
    });
    const original = console.error;
    console.error = () => {};
    try {
      const res = await get(broken.app, '/a/a1');
      assert.equal(res.status, 500);
      assert.doesNotMatch(await res.text(), /secret database detail/);
      assert.ok(res.headers.get('content-security-policy'));
    } finally {
      console.error = original;
    }
  });
});

describe('POST', () => {
  it('rejects a missing or foreign Origin', async () => {
    const { app, deleted } = fakeDeps({});
    assert.equal((await post(app, '/a/a1/delete', {})).status, 403);
    assert.equal((await post(app, '/a/a1/delete', {}, 'https://evil.test')).status, 403);
    assert.equal((await post(app, '/a/a1/delete', {}, CONTENT)).status, 403);
    assert.deepEqual(deleted, []);
  });

  it('deletes and redirects with the app Origin', async () => {
    const { app, deleted } = fakeDeps({});
    const res = await post(app, '/a/a1/delete', {}, APP);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    assert.deepEqual(deleted, ['a1']);
  });

  it('shows a created token once', async () => {
    const { app } = fakeDeps({});
    const res = await post(app, '/settings/tokens', { name: 'laptop <1>' }, APP);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(body, /<code id="new-token" class="token">aa_secret1<\/code>/);
    assert.match(body, /data-copy="new-token"/);
    assert.match(body, /shown only once/);
    assert.ok(body.includes('laptop &lt;1&gt;'));

    const list = await (await get(app, '/settings/tokens')).text();
    assert.ok(list.includes('laptop &lt;1&gt;'));
    assert.ok(!list.includes('aa_secret1'));
  });

  it('refuses a token without a name', async () => {
    const { app } = fakeDeps({});
    assert.equal((await post(app, '/settings/tokens', { name: '  ' }, APP)).status, 400);
  });

  it('revokes a token', async () => {
    const { app } = fakeDeps({});
    await post(app, '/settings/tokens', { name: 'x' }, APP);
    const res = await post(app, '/settings/tokens/t1/revoke', {}, APP);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/settings/tokens');
    assert.equal((await post(app, '/settings/tokens/nope/revoke', {}, APP)).status, 404);
  });
});

describe('connect', () => {
  it('shows the MCP URL and client snippets', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/connect')).text();
    assert.ok(body.includes('https://app.test/mcp'));
    assert.ok(
      body.includes('claude mcp add --transport http -s user agent-artifacts https://app.test/mcp'),
    );
    assert.ok(body.includes('{file:~/.agent-artifacts-token}'));
    assert.match(body, /href="\/settings\/tokens"/);
  });
});
