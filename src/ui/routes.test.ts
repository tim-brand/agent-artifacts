import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Config } from '../config.ts';
import {
  AppError,
  type Artifact,
  type ArtifactService,
  type CommentAuthor,
  type CommentInput,
  type CommentService,
  type ContentSigner,
  type Deps,
  type SearchQuery,
  type ShareLink,
  type ShareLinkInput,
  type ShareLinkService,
  type Thread,
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

const THREADS: Thread[] = [
  {
    id: 'th-open',
    artifactId: 'a1',
    anchor: { kind: 'text', exact: 'Quoted "<b>"', prefix: 'before <', suffix: '> after' },
    version: 2,
    resolvedAt: null,
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    comments: [
      {
        id: 'c1',
        author: 'owner@example.com',
        typed: true,
        body: 'Fix <script>alert(2)</script>',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
      {
        id: 'c2',
        author: 'agent <x>',
        typed: false,
        body: 'Done',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ],
  },
  {
    id: 'th-done',
    artifactId: 'a1',
    anchor: { kind: 'text', exact: 'Old quote', prefix: '', suffix: '' },
    version: 3,
    resolvedAt: '2026-01-04T00:00:00.000Z',
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-04T00:00:00.000Z',
    comments: [],
  },
  {
    id: 'th-new',
    artifactId: 'a1',
    anchor: { kind: 'note' },
    version: 3,
    resolvedAt: null,
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    comments: [],
  },
];

function fakeDeps(overrides: {
  config?: Partial<Config>;
  artifacts?: Partial<ArtifactService>;
  comments?: Partial<CommentService>;
}) {
  const list: Artifact[] = [
    artifact('a1', 'html', '<script>alert(1)</script>', 3),
    artifact('p1', 'pdf', 'A PDF'),
    artifact('i1', 'image', 'A chart'),
  ];
  const deleted: string[] = [];
  const searched: SearchQuery[] = [];
  const undeleted: string[] = [];
  const restored: { id: string; version: number; publishedBy: string }[] = [];
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
        version: version(
          a,
          v,
          { pdf: 'document.pdf', image: 'chart.svg' }[a.format as string] ?? 'index.html',
        ),
      };
    },
    readFile: async () => null,
    list: async (query) => ({
      items: list.filter((a) => !query?.format || a.format === query.format),
      nextCursor: query?.cursor ? null : 'next-page',
    }),
    search: async (query) => {
      searched.push(query);
      return {
        items: [
          { artifact: list[0] as Artifact, snippet: 'a «<img src=x onerror=alert(1)>» b «c' },
        ],
        nextCursor: query.cursor ? null : 'more',
      };
    },
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
    undelete: async (id) => {
      undeleted.push(id);
      return id === 'gone1';
    },
    listDeleted: async () => [
      {
        ...artifact('gone1', 'markdown', 'Old <i>notes</i>'),
        deletedAt: '2026-01-03T00:00:00.000Z',
      },
    ],
    restoreVersion: async (id, n, publishedBy) => {
      restored.push({ id, version: n, publishedBy });
      const a = list.find((x) => x.id === id);
      if (!a || n > a.latestVersion) throw new AppError('not_found', 'gone');
      return { id, version: a.latestVersion + 1, title: a.title, url: `${APP}/a/${id}` };
    },
    ...overrides.artifacts,
  };

  const added: { input: CommentInput; author: CommentAuthor }[] = [];
  const resolved: [string, boolean, string | undefined][] = [];
  const comments: CommentService = {
    list: async (id) =>
      list.some((a) => a.id === id) ? THREADS.filter((t) => t.artifactId === id) : null,
    add: async (input, author) => {
      added.push({ input, author });
      if (input.threadId && !THREADS.some((t) => t.id === input.threadId)) {
        throw new AppError('not_found', 'no thread');
      }
      return { ...(THREADS[2] as Thread), id: input.threadId ?? 'th-created' };
    },
    resolve: async (threadId, value, artifactId) => {
      resolved.push([threadId, value, artifactId]);
      return THREADS.find((t) => t.id === threadId && t.artifactId === artifactId) ?? null;
    },
    openCounts: async (ids): Promise<Record<string, number>> =>
      ids.includes('a1') ? { a1: 2 } : {},
    ...overrides.comments,
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

  const links: ShareLink[] = [];
  const shared: { artifactId: string; input?: ShareLinkInput }[] = [];
  const shareLinks: ShareLinkService = {
    create: async (artifactId, input) => {
      shared.push({ artifactId, input });
      if (!list.some((a) => a.id === artifactId)) throw new AppError('not_found', 'gone');
      const link: ShareLink = {
        id: `l${links.length + 1}`,
        artifactId,
        version: input?.version ?? null,
        label: input?.label ?? '',
        createdAt: new Date().toISOString(),
        expiresAt: input?.expiresAt ?? null,
        lastUsedAt: null,
      };
      links.unshift(link);
      return { token: `sl_secret${links.length}`, link };
    },
    list: async (id) =>
      list.some((a) => a.id === id) ? links.filter((l) => l.artifactId === id) : null,
    revoke: async (artifactId, id) => {
      const index = links.findIndex((l) => l.id === id && l.artifactId === artifactId);
      if (index >= 0) links.splice(index, 1);
      return index >= 0;
    },
    resolve: async () => null,
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
  const deps: Deps = { config, artifacts, comments, tokens, shareLinks, signer };
  return {
    app: createUiRoutes(deps),
    deleted,
    searched,
    undeleted,
    restored,
    shared,
    links,
    added,
    resolved,
  };
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

  it('has an image chip and badge', async () => {
    const { app } = fakeDeps({});
    const all = await (await get(app, '/')).text();
    assert.match(all, /<a href="\/\?format=image">image<\/a>/);
    const body = await (await get(app, '/?format=image')).text();
    assert.match(body, /<a href="\/\?format=image" aria-current="page">image<\/a>/);
    assert.match(body, /A chart<\/a>\n<span class="badge">image<\/span>/);
    assert.ok(!body.includes('A PDF'));
  });

  it('shows an empty state that points to /connect', async () => {
    const { app } = fakeDeps({
      artifacts: { list: async () => ({ items: [], nextCursor: null }) },
    });
    const body = await (await get(app, '/')).text();
    assert.match(body, /href="\/connect">Connect an agent/);
  });
});

describe('search', () => {
  it('shows a search box on the list page', async () => {
    const { app, searched } = fakeDeps({});
    const body = await (await get(app, '/')).text();
    assert.match(body, /<form class="search" method="get" action="\/" role="search">/);
    assert.match(body, /<input type="search" name="q" value=""/);
    assert.deepEqual(searched, []);
  });

  it('escapes snippets and turns only the match markers into <mark>', async () => {
    const { app, searched } = fakeDeps({});
    const res = await get(app, '/?q=%20%22onerror%22%20');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(searched, [{ query: '"onerror"', cursor: undefined, limit: 20 }]);
    assert.ok(
      body.includes('<p class="hit">a <mark>&lt;img src=x onerror=alert(1)&gt;</mark> b «c</p>'),
    );
    assert.ok(!body.includes('<img'));
    assert.ok(body.includes('value="&quot;onerror&quot;"'));
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.match(body, /href="\/\?q=%22onerror%22&amp;cursor=more">More results/);
    assert.ok(!body.includes('A PDF'));
  });

  it('passes the cursor and shows an empty state', async () => {
    const empty = fakeDeps({
      artifacts: { search: async () => ({ items: [], nextCursor: null }) },
    });
    const body = await (await get(empty.app, '/?q=%3Cb%3E')).text();
    assert.match(body, /Nothing matches <strong>&lt;b&gt;<\/strong>/);

    const { app, searched } = fakeDeps({});
    await get(app, '/?q=x&cursor=more');
    assert.deepEqual(searched, [{ query: 'x', cursor: 'more', limit: 20 }]);
  });

  it('answers a bad cursor with 400', async () => {
    const { app } = fakeDeps({
      artifacts: {
        search: async () => {
          throw new AppError('invalid_input', 'Invalid cursor');
        },
      },
    });
    const res = await get(app, '/?q=x&cursor=junk');
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Invalid cursor/);
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

  it('sandboxes image artifacts, since an SVG can carry script', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/i1')).text();
    const iframe = body.match(/<iframe[^>]*>/)?.[0] ?? '';
    assert.match(iframe, /chart\.svg/);
    assert.match(iframe, /sandbox="allow-scripts allow-popups/);
    assert.match(body, /<span class="badge">image<\/span>/);
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

describe('restore a version', () => {
  it('shows the button only on versions that are not the latest', async () => {
    const { app } = fakeDeps({});
    const old = await (await get(app, '/a/a1/v/2')).text();
    assert.match(old, /<form class="inline" method="post" action="\/a\/a1\/v\/2\/restore">/);
    assert.match(old, /Restore this version/);
    const latest = await (await get(app, '/a/a1')).text();
    assert.doesNotMatch(latest, /Restore this version/);
    assert.doesNotMatch(await (await get(app, '/a/a1/v/3')).text(), /Restore this version/);
  });

  it('restores as the signed-in user and redirects to the artifact', async () => {
    const { app, restored } = fakeDeps({});
    const res = await post(app, '/a/a1/v/2/restore', {}, APP);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/a/a1');
    assert.deepEqual(restored, [{ id: 'a1', version: 2, publishedBy: 'owner@example.com' }]);
    assert.equal((await post(app, '/a/a1/v/9/restore', {}, APP)).status, 404);
    assert.equal((await post(app, '/a/a1/v/0/restore', {}, APP)).status, 404);
  });

  it('rejects a foreign Origin', async () => {
    const { app, restored } = fakeDeps({});
    assert.equal((await post(app, '/a/a1/v/2/restore', {})).status, 403);
    assert.equal((await post(app, '/a/a1/v/2/restore', {}, CONTENT)).status, 403);
    assert.deepEqual(restored, []);
  });
});

describe('trash', () => {
  it('lists deleted artifacts escaped, with the delete date and a restore button', async () => {
    const { app } = fakeDeps({});
    const res = await get(app, '/trash');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(body.includes('Old &lt;i&gt;notes&lt;/i&gt;'));
    assert.match(body, /deleted <time datetime="2026-01-03T00:00:00.000Z"/);
    assert.match(body, /action="\/trash\/gone1\/restore"/);
    assert.match(body, /<a href="\/trash" aria-current="page">Trash<\/a>/);
  });

  it('shows an empty trash', async () => {
    const { app } = fakeDeps({ artifacts: { listDeleted: async () => [] } });
    assert.match(await (await get(app, '/trash')).text(), /The trash is empty/);
  });

  it('restores with the app Origin only', async () => {
    const { app, undeleted } = fakeDeps({});
    assert.equal((await post(app, '/trash/gone1/restore', {}, 'https://evil.test')).status, 403);
    assert.deepEqual(undeleted, []);
    const res = await post(app, '/trash/gone1/restore', {}, APP);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/trash');
    assert.equal((await post(app, '/trash/nope/restore', {}, APP)).status, 404);
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

describe('share links', () => {
  it('shows a share form on the artifact page, collapsed, with the page version to pin', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1/v/2')).text();
    assert.match(body, /<details class="share">\n<summary>Share<\/summary>/);
    assert.match(body, /<form method="post" action="\/a\/a1\/share"/);
    assert.match(body, /<option value="latest">Always the latest version<\/option>/);
    assert.match(body, /<option value="2">Only version 2<\/option>/);
    assert.match(body, /No public links\./);
  });

  it('creates a link, shows its URL once with a copy button, then lists it', async () => {
    const { app, shared } = fakeDeps({});
    const res = await post(
      app,
      '/a/a1/share',
      { version: 'latest', label: 'mum <3', expires: '' },
      APP,
    );
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(shared, [
      { artifactId: 'a1', input: { version: undefined, label: 'mum <3', expiresAt: undefined } },
    ]);
    assert.match(
      body,
      /<code id="share-url" class="token">https:\/\/content\.test\/p\/sl_secret1\/<\/code>/,
    );
    assert.match(body, /data-copy="share-url"/);
    assert.match(body, /<details class="share" open>/);
    assert.ok(body.includes('mum &lt;3'));
    assert.ok(!body.includes('mum <3'));

    const page = await (await get(app, '/a/a1')).text();
    assert.ok(!page.includes('sl_secret1'));
    assert.match(page, /Share · 1 public link</);
    assert.match(page, /<td>Latest version<\/td>/);
    assert.match(page, /action="\/a\/a1\/share\/l1\/revoke"/);
  });

  it('pins a version and sets an expiry', async () => {
    const { app, shared } = fakeDeps({});
    const before = Date.now();
    const res = await post(app, '/a/a1/share', { version: '2', label: '', expires: '7' }, APP);
    assert.equal(res.status, 200);
    const input = shared[0]?.input;
    assert.equal(input?.version, 2);
    const expires = Date.parse(input?.expiresAt ?? '');
    assert.ok(expires >= before + 7 * 86_400_000 && expires <= Date.now() + 7 * 86_400_000);
    const body = await res.text();
    assert.match(body, /Version 2 of 3/);
    assert.match(body, /<a href="\/a\/a1\/v\/2">Version 2<\/a>/);
  });

  it('refuses a foreign Origin, a bad version or expiry, and an unknown artifact', async () => {
    const { app, shared } = fakeDeps({});
    const form = { version: 'latest', label: '', expires: '' };
    assert.equal((await post(app, '/a/a1/share', form)).status, 403);
    assert.equal((await post(app, '/a/a1/share', form, CONTENT)).status, 403);
    assert.deepEqual(shared, []);
    assert.equal((await post(app, '/a/a1/share', { ...form, version: '0' }, APP)).status, 400);
    assert.equal((await post(app, '/a/a1/share', { ...form, expires: '365' }, APP)).status, 400);
    assert.deepEqual(shared, []);
    assert.equal((await post(app, '/a/nope/share', form, APP)).status, 404);
  });

  it('revokes a link of this artifact only', async () => {
    const { app, links } = fakeDeps({});
    await post(app, '/a/a1/share', { version: 'latest', label: '', expires: '' }, APP);
    assert.equal((await post(app, '/a/p1/share/l1/revoke', {}, APP)).status, 404);
    assert.equal((await post(app, '/a/a1/share/l1/revoke', {})).status, 403);
    assert.equal(links.length, 1);
    const res = await post(app, '/a/a1/share/l1/revoke', {}, APP);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/a/a1');
    assert.equal(links.length, 0);
    assert.equal((await post(app, '/a/a1/share/l1/revoke', {}, APP)).status, 404);
  });

  it('marks an expired link', async () => {
    const { app, links } = fakeDeps({});
    links.push({
      id: 'old',
      artifactId: 'a1',
      version: null,
      label: 'old',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      lastUsedAt: '2026-01-01T12:00:00.000Z',
    });
    const body = await (await get(app, '/a/a1')).text();
    assert.match(body, /<span class="badge">expired<\/span>/);
  });
});

describe('comments', () => {
  it('shows an open-comments badge in the list and in search results', async () => {
    const { app } = fakeDeps({});
    const list = await (await get(app, '/')).text();
    assert.match(
      list,
      /alert\(1\)&lt;\/script&gt;<\/a>\n.*\n.*\n.*<\/time><\/span><span class="badge" title="Open comment threads">2 open comments<\/span>/,
    );
    assert.equal(list.match(/open comment/g)?.length, 1);
    const search = await (await get(app, '/?q=x')).text();
    assert.match(search, /2 open comments/);
  });

  it('renders the panel escaped, with threads up to this version', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1/v/2')).text();
    assert.match(body, /<details class="comments" id="comments" open>/);
    assert.match(body, /<button type="button" id="comment-on-selection" hidden>/);
    assert.ok(body.includes('Fix &lt;script&gt;alert(2)&lt;/script&gt;'));
    assert.ok(!body.includes('<script>alert(2)'));
    assert.ok(body.includes('agent &lt;x&gt; <span class="badge">agent</span>'));
    assert.ok(body.includes('<blockquote class="quote">Quoted &quot;&lt;b&gt;&quot;</blockquote>'));
    // Started on v3: not shown on v2.
    assert.ok(!body.includes('thread-th-new'));
    assert.ok(!body.includes('Old quote'));
    assert.match(body, /name="version" value="2"/);
    assert.match(body, /<span class="badge">1 open<\/span>/);
  });

  it('marks older threads, keeps resolved ones apart, and highlights only open quotes', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1')).text();
    assert.match(
      body,
      /id="thread-th-open" data-exact="Quoted &quot;&lt;b&gt;&quot;" data-prefix="before &lt;" data-suffix="&gt; after">/,
    );
    assert.match(body, /title="Started on version 2">on v2<\/span>/);
    assert.match(body, /<article class="thread done" id="thread-th-done">/);
    assert.match(body, /<details class="resolved"><summary>1 resolved thread<\/summary>/);
    assert.equal(body.match(/data-exact=/g)?.length, 1);
    assert.match(body, /value="1">Resolve<\/button>/);
    assert.match(body, /value="0">Reopen<\/button>/);
    assert.match(body, /<span class="badge">2 open<\/span>/);
  });

  it('loads its script from /static/app.js, allowed by script-src self', async () => {
    const { app } = fakeDeps({});
    const res = await get(app, '/a/a1');
    const body = await res.text();
    assert.match(body, /<script src="\/static\/app\.js\?v=[0-9a-f]{12}" defer><\/script>/);
    assert.equal(body.match(/<script/g)?.length, 1);
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self';/);

    const js = await get(app, '/static/app.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.match(await js.text(), /aa:selection/);
  });

  it('posts a note as the signed-in owner, typed, whatever the form says', async () => {
    const { app, added } = fakeDeps({});
    const res = await post(
      app,
      '/a/a1/comments',
      { body: 'Hello', version: '2', typed: '0', author: 'someone@else' },
      APP,
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/a/a1/v/2#thread-th-created');
    assert.deepEqual(added, [
      {
        input: { artifactId: 'a1', body: 'Hello', version: 2, anchor: { kind: 'note' } },
        author: { name: 'owner@example.com', typed: true },
      },
    ]);
  });

  it('posts a text anchor, and returns to the plain URL on the latest version', async () => {
    const { app, added } = fakeDeps({});
    const res = await post(
      app,
      '/a/a1/comments',
      { body: 'Hm', version: '3', exact: 'Hi', prefix: 'a', suffix: 'b' },
      APP,
    );
    assert.equal(res.headers.get('location'), '/a/a1#thread-th-created');
    assert.deepEqual(added[0]?.input.anchor, {
      kind: 'text',
      exact: 'Hi',
      prefix: 'a',
      suffix: 'b',
    });
  });

  it('replies without an anchor or version', async () => {
    const { app, added } = fakeDeps({});
    const res = await post(
      app,
      '/a/a1/comments',
      { body: 'More', threadId: 'th-open', version: '3', exact: 'ignored' },
      APP,
    );
    assert.equal(res.headers.get('location'), '/a/a1#thread-th-open');
    assert.deepEqual(added[0]?.input, { artifactId: 'a1', threadId: 'th-open', body: 'More' });
    assert.equal(
      (await post(app, '/a/a1/comments', { body: 'x', threadId: 'nope' }, APP)).status,
      404,
    );
  });

  it('needs the app Origin to post or resolve', async () => {
    const { app, added, resolved } = fakeDeps({});
    assert.equal((await post(app, '/a/a1/comments', { body: 'x' })).status, 403);
    assert.equal((await post(app, '/a/a1/comments', { body: 'x' }, CONTENT)).status, 403);
    assert.equal((await post(app, '/a/a1/comments/th-open/resolve', {}, CONTENT)).status, 403);
    assert.deepEqual(added, []);
    assert.deepEqual(resolved, []);
  });

  it('shows a refused comment as a 400', async () => {
    const { app } = fakeDeps({
      comments: {
        add: async () => {
          throw new AppError('invalid_input', 'A comment is 1 to 2000 characters, not 2001');
        },
      },
    });
    const res = await post(app, '/a/a1/comments', { body: 'x'.repeat(2001) }, APP);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /1 to 2000 characters/);
  });

  it('resolves and reopens within the artifact, posting a typed reply first', async () => {
    const { app, added, resolved } = fakeDeps({});
    const res = await post(
      app,
      '/a/a1/comments/th-open/resolve',
      { resolved: '1', version: '2', body: 'Thanks' },
      APP,
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/a/a1/v/2#thread-th-open');
    assert.deepEqual(added[0]?.input, { artifactId: 'a1', threadId: 'th-open', body: 'Thanks' });
    await post(app, '/a/a1/comments/th-open/resolve', { resolved: '0', body: ' ' }, APP);
    assert.equal(added.length, 1);
    assert.equal((await post(app, '/a/p1/comments/th-open/resolve', {}, APP)).status, 404);
    assert.deepEqual(resolved, [
      ['th-open', true, 'a1'],
      ['th-open', false, 'a1'],
      ['th-open', true, 'p1'],
    ]);
  });

  it('is not found for a deleted or unknown artifact', async () => {
    const { app } = fakeDeps({ comments: { list: async () => null } });
    assert.equal((await get(app, '/a/a1')).status, 404);
  });
});
