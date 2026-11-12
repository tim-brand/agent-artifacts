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
  type Comparison,
  type ContentSigner,
  type Deps,
  type LibraryFilter,
  type LibraryQuery,
  type OAuthGrant,
  type OAuthService,
  type PublishInput,
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
    capabilities: { db: false, viewer: false },
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
    linesAdded: n === 1 ? 12 : n,
    linesRemoved: n === 1 ? 0 : 1,
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

const COMPARISON: Omit<Comparison, 'artifact' | 'from' | 'to'> = {
  files: [
    {
      path: 'index.html',
      status: 'changed',
      diff: 'text',
      linesAdded: 2,
      linesRemoved: 1,
      hunks: [
        {
          oldStart: 8,
          oldLines: 4,
          newStart: 8,
          newLines: 5,
          lines: [
            ' <p>same</p>',
            '-<script>alert("old")</script>',
            '+<img src=x onerror=alert(1)>',
            '+& more',
            ' <p>after</p>',
            ' end',
            '\\ No newline at end of file',
          ],
        },
      ],
      truncated: false,
    },
    {
      path: 'logo.png',
      status: 'added',
      diff: 'binary',
      linesAdded: null,
      linesRemoved: null,
      hunks: [],
      truncated: false,
    },
    {
      path: 'new <b>.css',
      oldPath: 'old.css',
      status: 'renamed',
      diff: 'text',
      linesAdded: 0,
      linesRemoved: 0,
      hunks: [],
      truncated: true,
    },
  ],
  unchanged: 1,
  linesAdded: 2,
  linesRemoved: 1,
  patch: 'unused by the UI',
  truncated: true,
};

function fakeDeps(overrides: {
  config?: Partial<Config>;
  artifacts?: Partial<ArtifactService>;
  comments?: Partial<CommentService>;
  oauth?: Partial<OAuthService>;
}) {
  const list: Artifact[] = [
    artifact('a1', 'html', '<script>alert(1)</script>', 3),
    artifact('p1', 'pdf', 'A PDF'),
    artifact('i1', 'image', 'A chart'),
  ];
  const deleted: string[] = [];
  const searched: SearchQuery[] = [];
  const browsed: LibraryQuery[] = [];
  const counted: LibraryFilter[] = [];
  const published: { input: PublishInput; by: string }[] = [];
  const entryOf = (a: Artifact) =>
    ({ pdf: 'document.pdf', image: 'chart.svg' })[a.format as string] ?? 'index.html';
  const undeleted: string[] = [];
  const restored: { id: string; version: number; publishedBy: string }[] = [];
  const compared: [string, number, number][] = [];
  const artifacts: ArtifactService = {
    publish: async (input, by) => {
      published.push({ input, by });
      const a = list.find((x) => x.id === input.id);
      if (!a) throw new AppError('not_found', 'gone');
      if (!input.title?.trim()) throw new AppError('invalid_input', 'title must not be empty');
      return { id: a.id, version: a.latestVersion, title: input.title, url: `${APP}/a/${a.id}` };
    },
    get: async (id, n) => {
      const a = list.find((x) => x.id === id);
      const v = n ?? a?.latestVersion;
      if (!a || !v || v > a.latestVersion) return null;
      return {
        artifact: a,
        version: version(a, v, entryOf(a)),
      };
    },
    readFile: async () => null,
    list: async (query) => ({
      items: list.filter((a) => !query?.format || a.format === query.format),
      nextCursor: query?.cursor ? null : 'next-page',
    }),
    browse: async (query = {}) => {
      browsed.push(query);
      return {
        items: list
          .filter((a) => !query.format || a.format === query.format)
          .map((a) => ({
            artifact: a,
            entry: entryOf(a),
            agent: a.id === 'a1' ? 'Claude <Code>' : 'OpenCode',
            publicLinks: a.id === 'a1' ? 1 : 0,
            openComments: a.id === 'a1' ? 2 : 0,
            openAsks: a.id === 'a1' ? 1 : 0,
          })),
        nextCursor: query.cursor ? null : 'next-page',
      };
    },
    count: async (filter = {}) => {
      counted.push(filter);
      if (filter.openAsks) return 1;
      return filter.live ? 0 : filter.shared ? 1 : filter.openComments ? 1 : list.length;
    },
    summary: async () => ({
      total: list.length,
      trash: 1,
      agents: [
        { name: 'Claude <Code>', count: 1 },
        { name: 'OpenCode', count: 2 },
      ],
      openAsks: 2,
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
    compare: async (id, from, to) => {
      compared.push([id, from, to]);
      const a = list.find((x) => x.id === id);
      if (!a || from > a.latestVersion || to > a.latestVersion) return null;
      return {
        artifact: a,
        from: version(a, from, entryOf(a)),
        to: version(a, to, entryOf(a)),
        ...COMPARISON,
      };
    },
    ...overrides.artifacts,
  };

  const added: { input: CommentInput; author: CommentAuthor }[] = [];
  const resolved: [string, boolean, string | undefined][] = [];
  const answered: [string, string, string, string][] = [];
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
    openAskCounts: async (ids): Promise<Record<string, number>> =>
      ids.includes('a1') ? { a1: 1 } : {},
    answer: async (artifactId, commentId, optionId, by) => {
      answered.push([artifactId, commentId, optionId, by]);
      if (optionId === 'nope')
        throw new AppError('invalid_input', 'That is not one of the options');
      return artifactId === 'a1' && commentId === 'c-ask' ? (THREADS[0] as Thread) : null;
    },
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
  const data = {} as Deps['data'];
  const grants: OAuthGrant[] = [
    {
      id: 'g1',
      clientId: 'c1',
      clientName: 'Claude <Code>',
      user: 'owner@example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  ];
  const revokedGrants: string[] = [];
  const oauth = {
    listGrants: async () => grants.filter((g) => !revokedGrants.includes(g.id)),
    revokeGrant: async (id: string) => {
      if (!grants.some((g) => g.id === id) || revokedGrants.includes(id)) return false;
      revokedGrants.push(id);
      return true;
    },
    ...overrides.oauth,
  } as Deps['oauth'];
  const deps: Deps = { config, artifacts, comments, data, tokens, oauth, shareLinks, signer };
  return {
    app: createUiRoutes(deps),
    deleted,
    searched,
    browsed,
    counted,
    published,
    undeleted,
    restored,
    compared,
    shared,
    links,
    added,
    resolved,
    answered,
    revokedGrants,
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

const cookie = (res: Response) => res.headers.get('set-cookie') ?? '';
/** The first element of a page matching an opening-tag pattern. */
const tag = (body: string, pattern: RegExp) => body.match(pattern)?.[0] ?? '';

describe('auth', () => {
  it('returns 401 without user header or devUser, without the sidebar', async () => {
    const { app } = fakeDeps({});
    const res = await app.request(`${APP}/`);
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.match(body, /Not signed in/);
    assert.doesNotMatch(body, /class="side"/);
    assert.doesNotMatch(body, /Back to the library/);
  });

  it('uses devUser when there is no header, and shows the user', async () => {
    const { app } = fakeDeps({ config: { devUser: 'dev@local' } });
    const res = await app.request(`${APP}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<span class="who-name">dev@local<\/span>/);
  });

  it('shows the X-authentik-name with initials, escaped', async () => {
    const { app } = fakeDeps({});
    const res = await app.request(`${APP}/`, {
      headers: { ...USER, 'X-authentik-name': 'Tim <Brand>' },
    });
    const body = await res.text();
    assert.match(body, /<span class="who-name">Tim &lt;Brand&gt;<\/span>/);
    assert.match(body, /<small>owner@example\.com<\/small>/);
    assert.match(body, /<span class="av" aria-hidden="true">TB<\/span>/);
  });

  it('never serves the UI under /mcp', async () => {
    const { app } = fakeDeps({});
    const res = await get(app, '/mcp/anything');
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /owner@example\.com/);
  });
});

describe('static files and CSP', () => {
  it('allows only scripts, styles and fonts from self, with no inline style at all', async () => {
    const { app } = fakeDeps({});
    for (const path of ['/', '/a/a1', '/trash', '/settings/connections', '/connect', '/nowhere']) {
      const res = await get(app, path);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /style-src 'self'; font-src 'self'; script-src 'self';/);
      assert.match(csp, /frame-src https:\/\/content\.test/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline|sha256/);
      const body = await res.text();
      assert.doesNotMatch(body, /<style|\sstyle="/, path);
      assert.equal(body.match(/<script/g)?.length, 1, path);
      assert.match(body, /<script src="\/static\/app\.js\?v=[0-9a-f]{12}" defer><\/script>/);
      assert.match(body, /<link rel="stylesheet" href="\/static\/app\.css\?v=[0-9a-f]{12}">/);
      assert.match(body, /<link rel="icon" href="\/static\/icon\.svg\?v=[0-9a-f]{12}"/);
    }
  });

  it('serves the script, the stylesheet, the icon and the fonts with long cache headers', async () => {
    const { app } = fakeDeps({});
    const files: [string, string, RegExp | null][] = [
      ['/static/app.js', 'text/javascript; charset=utf-8', /aa:selection/],
      ['/static/app.css', 'text/css; charset=utf-8', /font-family: "Geist"|font-family: 'Geist'/],
      ['/static/icon.svg', 'image/svg+xml', /^<svg [^>]*>(?![\s\S]*<script)/],
      ['/static/fonts/Geist-Variable.woff2', 'font/woff2', null],
      ['/static/fonts/GeistMono-Variable.woff2', 'font/woff2', null],
    ];
    for (const [path, type, content] of files) {
      const res = await get(app, path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('content-type'), type);
      assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (content) assert.match(new TextDecoder().decode(bytes), content);
      else assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'wOF2');
    }
    const css = await (await get(app, '/static/app.css')).text();
    assert.match(
      css,
      /url\("\/static\/fonts\/Geist-Variable\.woff2"\)|url\('\/static\/fonts\/Geist-Variable\.woff2'\)/,
    );
    assert.doesNotMatch(css, /https?:\/\//);
    assert.equal((await get(app, '/static/../routes.ts')).status, 404);
    assert.equal((await get(app, '/static/fonts/OFL.txt')).status, 404);
  });
});

describe('theme', () => {
  it('follows the system without a cookie, and renders a chosen theme on <html>', async () => {
    const { app } = fakeDeps({});
    const system = await (await get(app, '/')).text();
    assert.match(system, /<html lang="en">/);
    assert.match(system, /value="system" title="System" aria-label="System" aria-pressed="true"/);

    for (const [value, attr] of [
      ['dark', ' data-theme="dark"'],
      ['light', ' data-theme="light"'],
      ['purple', ''],
    ]) {
      const res = await app.request(`${APP}/a/a1`, {
        headers: { ...USER, Cookie: `aa_theme=${value}` },
      });
      assert.match(await res.text(), new RegExp(`<html lang="en"${attr}>`));
    }
  });

  it('sets the cookie from the form and goes back to a local path only', async () => {
    const { app } = fakeDeps({});
    const res = await post(
      app,
      '/settings/theme',
      { theme: 'dark', back: '/a/a1?panel=share' },
      APP,
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/a/a1?panel=share');
    assert.match(cookie(res), /^aa_theme=dark; Max-Age=31536000; Path=\/; Secure; SameSite=Lax$/);
    for (const back of ['//evil.test', 'https://evil.test', '/\\evil.test', 'x', '/a\nb']) {
      const other = await post(app, '/settings/theme', { theme: 'light', back }, APP);
      assert.equal(other.headers.get('location'), '/', back);
    }
    assert.equal((await post(app, '/settings/theme', { theme: 'blue' }, APP)).status, 400);
    assert.equal((await post(app, '/settings/theme', { theme: 'dark' }, CONTENT)).status, 403);
  });

  it('leaves Secure off on a plain http origin', async () => {
    const { app } = fakeDeps({ config: { appOrigin: 'http://localhost:4300' } });
    const res = await app.request('http://localhost:4300/settings/theme', {
      method: 'POST',
      headers: {
        ...USER,
        Origin: 'http://localhost:4300',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'theme=system',
    });
    assert.doesNotMatch(cookie(res), /Secure/);
  });
});

describe('library', () => {
  it('renders cards escaped, with live previews and the sidebar', async () => {
    const { app, browsed } = fakeDeps({});
    const res = await get(app, '/');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(browsed, [{ sort: 'updated', cursor: undefined, limit: 24 }]);
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!body.includes('<script>alert(1)'));
    assert.ok(body.indexOf('alert(1)') < body.indexOf('A PDF'));
    assert.match(body, /<a class="stretch" href="\/a\/a1">/);
    // A preview: the signed entry in a frame without scripts, kept out of tab order and a11y.
    const preview = tag(body, /<iframe[^>]*a1\/3\/index\.html[^>]*>/);
    assert.match(preview, /src="https:\/\/content\.test\/s\/9\.sig\/a1\/3\/index\.html"/);
    assert.match(preview, / sandbox="" loading="lazy" tabindex="-1" aria-hidden="true"/);
    assert.match(
      body,
      /<iframe src="https:\/\/content\.test\/s\/9\.sig\/i1\/1\/chart\.svg" sandbox=""/,
    );
    // A PDF gets the format tile.
    assert.doesNotMatch(body, /document\.pdf/);
    assert.match(body, /<div class="thumb tile">.*<b>A PDF<\/b><\/div>/);
    // Sidebar: counts and agents, escaped.
    assert.match(
      body,
      /<a class="nav on" href="\/" aria-current="page">.*Library<\/span><span class="n">3<\/span>/,
    );
    assert.match(body, /Trash<\/span><span class="n">1<\/span>/);
    assert.match(
      body,
      /href="\/\?agent=Claude\+%3CCode%3E"><span class="dot"><\/span><span class="label">Claude &lt;Code&gt;<\/span><span class="n">1<\/span>/,
    );
    assert.match(body, /<span class="agent">Claude &lt;Code&gt;<\/span>/);
    assert.match(body, /<span class="pill cmt" title="2 open comment threads">.*2<\/span>/);
    assert.match(body, /<span class="pill pub" title="1 public link">/);
    assert.match(body, /<a class="btn" href="\/\?cursor=next-page">Load more<\/a>/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
  });

  it('has tabs with counts that keep the format and agent filters', async () => {
    const { app, browsed, counted } = fakeDeps({});
    const body = await (await get(app, '/?tab=comments&format=html&agent=OpenCode')).text();
    assert.deepEqual(browsed, [
      {
        format: 'html',
        agent: 'OpenCode',
        openComments: true,
        sort: 'updated',
        cursor: undefined,
        limit: 24,
      },
    ]);
    assert.deepEqual(counted, [
      { format: 'html', agent: 'OpenCode' },
      { format: 'html', agent: 'OpenCode', live: true },
      { format: 'html', agent: 'OpenCode', shared: true },
      { format: 'html', agent: 'OpenCode', openComments: true },
      { format: 'html', agent: 'OpenCode', openAsks: true },
    ]);
    assert.match(
      body,
      /<a class="tab" href="\/\?format=html&amp;agent=OpenCode">All<span class="n">3<\/span><\/a>/,
    );
    assert.match(
      body,
      /<a class="tab" href="\/\?tab=live&amp;format=html&amp;agent=OpenCode">Live<span class="n">0<\/span>/,
    );
    assert.match(
      body,
      /<a class="tab on" href="\/\?tab=comments&amp;format=html&amp;agent=OpenCode" aria-current="page">Open comments<span class="n">1<\/span>/,
    );
    assert.match(body, /<span class="count">1 artifact<\/span>/);
    assert.match(body, /<span class="chip set">.*Format<b>HTML<\/b>/);
    assert.match(body, /<span class="chip set">Agent<b>OpenCode<\/b>/);
    assert.match(body, /<a class="clear" href="\/\?tab=comments">Clear filters<\/a>/);
    assert.match(
      body,
      /href="\/\?tab=comments&amp;format=html&amp;agent=OpenCode&amp;cursor=next-page">Load more/,
    );
    // The sidebar marks the agent being filtered on.
    assert.match(body, /<a class="nav agent on" href="\/\?agent=OpenCode" aria-current="page">/);
    assert.match(body, /<a class="nav" href="\/">.*Library/);
  });

  it('ignores unknown tabs, formats and sorts, and sorts by title when asked', async () => {
    const { app, browsed } = fakeDeps({});
    await get(app, '/?tab=secret&format=exe&sort=random');
    await get(app, '/?sort=title&cursor=abc');
    assert.deepEqual(browsed, [
      { sort: 'updated', cursor: undefined, limit: 24 },
      { sort: 'title', cursor: 'abc', limit: 24 },
    ]);
    const body = await (await get(app, '/?sort=title')).text();
    assert.match(body, /<span class="btn ghost">Title/);
    assert.match(
      body,
      /<a class="menu-item on" href="\/\?sort=title" aria-current="page">Title<\/a>/,
    );
  });

  it('switches between grid and list, remembering it in a cookie', async () => {
    const { app } = fakeDeps({});
    const grid = await (await get(app, '/')).text();
    assert.match(grid, /<div class="grid">/);
    assert.match(grid, /<a href="\/\?view=list" aria-label="List"/);

    const res = await get(app, '/?view=list&format=html');
    assert.match(cookie(res), /^aa_view=list; Max-Age=31536000; Path=\/; Secure; SameSite=Lax$/);
    const list = await res.text();
    assert.match(list, /<div class="list">/);
    assert.match(list, /<a class="ttl stretch" href="\/a\/a1">/);
    assert.doesNotMatch(list, /<iframe/);
    // The view stays out of the other links.
    assert.match(list, /href="\/\?format=html&amp;cursor=next-page">Load more/);

    const remembered = await app.request(`${APP}/`, {
      headers: { ...USER, Cookie: 'aa_view=list' },
    });
    assert.match(await remembered.text(), /<div class="list">/);
    assert.equal(cookie(remembered), '');
  });

  it('shows an empty state that points to /connect, or back to everything', async () => {
    const empty = fakeDeps({
      artifacts: {
        browse: async () => ({ items: [], nextCursor: null }),
        count: async () => 0,
      },
    });
    assert.match(await (await get(empty.app, '/')).text(), /href="\/connect">Connect an agent/);
    const filtered = await (await get(empty.app, '/?format=pdf')).text();
    assert.match(filtered, /No artifacts match in <strong>PDF<\/strong>/);
    assert.match(filtered, /<a href="\/">Show everything<\/a>/);
  });

  it('answers a bad cursor with 400', async () => {
    const { app } = fakeDeps({
      artifacts: {
        browse: async () => {
          throw new AppError('invalid_input', 'Invalid cursor');
        },
      },
    });
    const res = await get(app, '/?cursor=junk');
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Invalid cursor/);
  });
});

describe('search', () => {
  it('has a search box on every app page that "/" focuses', async () => {
    const { app, searched } = fakeDeps({});
    for (const path of [
      '/',
      '/trash',
      '/settings/connections',
      '/connect',
      '/docs/runtime',
      '/a/a1',
    ]) {
      const body = await (await get(app, path)).text();
      assert.match(
        body,
        /<form class="search( sm)?" method="get" action="\/" role="search">/,
        path,
      );
      assert.match(
        body,
        /<input type="search" name="q" value="" placeholder="[^"]+" maxlength="200" aria-label="Search artifacts" data-search>/,
      );
    }
    assert.deepEqual(searched, []);
  });

  it('escapes snippets and turns only the match markers into <mark>', async () => {
    const { app, searched, browsed } = fakeDeps({});
    const res = await get(app, '/?q=%20%22onerror%22%20');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(searched, [{ query: '"onerror"', cursor: undefined, limit: 20 }]);
    assert.deepEqual(browsed, []);
    assert.ok(
      body.includes('<p class="hit">a <mark>&lt;img src=x onerror=alert(1)&gt;</mark> b «c</p>'),
    );
    assert.ok(!body.includes('<img'));
    assert.ok(body.includes('value="&quot;onerror&quot;"'));
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.match(body, /<span class="pill cmt" title="2 open comment threads">/);
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
    const iframe = tag(body, /<iframe[^>]*>/);
    assert.match(iframe, /^<iframe class="artifact"/);
    assert.match(iframe, /src="https:\/\/content\.test\/s\/9\.sig\/a1\/3\/index\.html"/);
    assert.match(iframe, /sandbox="allow-scripts allow-popups/);
    assert.doesNotMatch(iframe, /allow-same-origin/);
    assert.match(body, /<h1 class="title">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
    assert.match(
      body,
      /<textarea class="input" name="description" rows="3" maxlength="2000">A &lt;b&gt;description&lt;\/b&gt;<\/textarea>/,
    );
    assert.match(
      body,
      /<a href="https:\/\/content\.test\/s\/9\.sig\/a1\/3\/style\.css" target="_blank" rel="noopener noreferrer">style\.css<\/a>/,
    );
    assert.match(
      body,
      /<a class="btn ghost raw" href="https:\/\/content\.test\/s\/9\.sig\/a1\/3\/index\.html" target="_blank" rel="noopener noreferrer">.*Open raw/,
    );
    assert.match(body, /<span class="muted fmt">HTML<\/span>/);
    assert.match(body, /<summary class="vsel" aria-label="Version"><b>v3<\/b>/);
    assert.match(body, /action="\/a\/a1\/delete" data-confirm="Move this artifact to the trash\?/);
    assert.doesNotMatch(body, /class="side"/);
  });

  it('gives pdf artifacts no sandbox', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/p1')).text();
    const iframe = tag(body, /<iframe[^>]*>/);
    assert.match(iframe, /document\.pdf/);
    assert.doesNotMatch(iframe, /sandbox/);
  });

  it('sandboxes image artifacts, since an SVG can carry script', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/i1')).text();
    const iframe = tag(body, /<iframe[^>]*>/);
    assert.match(iframe, /chart\.svg/);
    assert.match(iframe, /sandbox="allow-scripts allow-popups/);
    assert.match(body, /<span class="muted fmt">Image<\/span>/);
  });

  it('shows the requested version, with a way back to the latest', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1/v/2')).text();
    assert.match(body, /<iframe[^>]*src="https:\/\/content\.test\/s\/9\.sig\/a1\/2\/index\.html"/);
    assert.match(
      body,
      /<a class="menu-item on" href="\/a\/a1\/v\/2" aria-current="page"><b>v2<\/b><span class="label">agent-2<\/span>/,
    );
    assert.match(body, /<a class="menu-item" href="\/a\/a1"><b>v3<\/b>/);
    assert.match(body, /You are viewing <b>v2<\/b>; the latest is v3\./);
    assert.match(
      body,
      /<li class="ver viewing">\n<div class="l1"><b>v2<\/b><span class="tag soft">Viewing<\/span>/,
    );
    assert.match(
      body,
      /<li class="ver cur">\n<div class="l1"><b>v3<\/b><span class="tag">Current<\/span>/,
    );
  });

  it('opens the panel on the remembered tab, or the one asked for, and remembers it', async () => {
    const { app } = fakeDeps({});
    const pane = (body: string, name: string) =>
      tag(body, new RegExp(`<section class="pbody" id="pane-${name}"[^>]*>`));

    const first = await (await get(app, '/a/a1')).text();
    assert.match(tag(first, /<aside class="panel"[^>]*>/), /aria-label="Artifact panel">$/);
    assert.doesNotMatch(pane(first, 'comments'), /hidden/);
    assert.match(pane(first, 'versions'), / hidden>$/);
    assert.match(
      first,
      /<a class="ptab on" href="\/a\/a1\?panel=comments" role="tab"[^>]*aria-selected="true"/,
    );

    const res = await get(app, '/a/a1/v/2?panel=versions');
    assert.match(cookie(res), /^aa_panel=versions;/);
    const versions = await res.text();
    assert.doesNotMatch(pane(versions, 'versions'), /hidden/);
    assert.match(pane(versions, 'comments'), / hidden>$/);
    // Tab links stay on the version shown.
    assert.match(versions, /href="\/a\/a1\/v\/2\?panel=share" role="tab"/);

    const closed = await get(app, '/a/a1?panel=closed');
    assert.match(cookie(closed), /^aa_panel=closed;/);
    const closedBody = await closed.text();
    assert.match(tag(closedBody, /<aside class="panel"[^>]*>/), / hidden>$/);
    assert.match(closedBody, /<div class="vbody closed">/);
    assert.match(
      closedBody,
      /href="\/a\/a1\?panel=comments" data-panel-toggle aria-controls="panel" aria-expanded="false"/,
    );

    const remembered = await app.request(`${APP}/a/a1`, {
      headers: { ...USER, Cookie: 'aa_panel=details' },
    });
    assert.doesNotMatch(pane(await remembered.text(), 'details'), /hidden/);
    const stillClosed = await app.request(`${APP}/a/a1`, {
      headers: { ...USER, Cookie: 'aa_panel=closed' },
    });
    assert.match(await stillClosed.text(), /<div class="vbody closed">/);
  });

  it('returns 404 for unknown artifacts and versions', async () => {
    const { app } = fakeDeps({});
    assert.equal((await get(app, '/a/nope')).status, 404);
    assert.equal((await get(app, '/a/a1/v/9')).status, 404);
    assert.equal((await get(app, '/a/a1/v/abc')).status, 404);
    const res = await get(app, '/nowhere');
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.match(body, /<p class="status">404<\/p>/);
    assert.match(body, /Back to the library/);
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
    // The theme form comes back to the Connections page, not to the POST.
    assert.match(body, /<input type="hidden" name="back" value="\/settings\/connections">/);

    const list = await (await get(app, '/settings/connections')).text();
    assert.ok(list.includes('laptop &lt;1&gt;'));
    assert.ok(!list.includes('aa_secret1'));
    assert.match(list, /<a class="nav on" href="\/settings\/connections" aria-current="page">/);
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
    assert.equal(res.headers.get('location'), '/settings/connections');
    assert.equal((await post(app, '/settings/tokens/nope/revoke', {}, APP)).status, 404);
  });
});

describe('connections', () => {
  it('lists signed-in apps above the tokens, escaped', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/settings/connections')).text();
    assert.match(body, /<h1>Connections<\/h1>/);
    assert.ok(body.includes('Claude &lt;Code&gt;'));
    assert.ok(!body.includes('Claude <Code>'));
    assert.ok(body.indexOf('Signed-in apps') < body.indexOf('Personal access tokens'));
    assert.match(body, /action="\/settings\/connections\/g1\/revoke"/);
  });

  it('the old Tokens URL redirects', async () => {
    const { app } = fakeDeps({});
    const res = await get(app, '/settings/tokens');
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/settings/connections');
  });

  it('revokes a grant only with the app Origin', async () => {
    const { app, revokedGrants } = fakeDeps({});
    assert.equal((await post(app, '/settings/connections/g1/revoke', {})).status, 403);
    assert.deepEqual(revokedGrants, []);
    const res = await post(app, '/settings/connections/g1/revoke', {}, APP);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/settings/connections');
    assert.deepEqual(revokedGrants, ['g1']);
    assert.equal((await post(app, '/settings/connections/g1/revoke', {}, APP)).status, 404);
    const body = await (await get(app, '/settings/connections')).text();
    assert.match(body, /No apps signed in/);
  });

  it('never serves the public OAuth paths, whatever X-authentik says', async () => {
    const { app } = fakeDeps({});
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/mcp',
      '/oauth/register',
      '/oauth/token',
    ]) {
      const res = await get(app, path);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(await res.text(), /owner@example\.com/);
    }
  });
});

describe('rename', () => {
  it('is a settings-only publish as the signed-in user, back on the Details tab', async () => {
    const { app, published } = fakeDeps({});
    const res = await post(
      app,
      '/a/a1/settings',
      { title: 'New <title>', description: 'Desc', version: '3' },
      APP,
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/a/a1?panel=details');
    assert.deepEqual(published, [
      {
        input: { id: 'a1', title: 'New <title>', description: 'Desc' },
        by: 'owner@example.com',
      },
    ]);
    const old = await post(app, '/a/a1/settings', { title: 'x', version: '2' }, APP);
    assert.equal(old.headers.get('location'), '/a/a1/v/2?panel=details');
  });

  it('refuses an empty title, a foreign Origin and an unknown artifact', async () => {
    const { app, published } = fakeDeps({});
    assert.equal((await post(app, '/a/a1/settings', { title: 'x' }, CONTENT)).status, 403);
    assert.deepEqual(published, []);
    assert.equal((await post(app, '/a/a1/settings', { title: ' ' }, APP)).status, 400);
    assert.equal((await post(app, '/a/nope/settings', { title: 'x' }, APP)).status, 404);
  });

  it('has a rename form in the Details tab', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1')).text();
    assert.match(
      body,
      /<form method="post" action="\/a\/a1\/settings" class="rename" id="rename">/,
    );
    assert.match(body, /name="title" value="&lt;script&gt;alert\(1\)&lt;\/script&gt;" required/);
  });
});

describe('restore a version', () => {
  it('offers Restore on older versions only', async () => {
    const { app } = fakeDeps({});
    const old = await (await get(app, '/a/a1/v/2')).text();
    assert.match(
      old,
      /<form method="post" action="\/a\/a1\/v\/2\/restore"><button class="btn sm" type="submit">Restore this version/,
    );
    const latest = await (await get(app, '/a/a1')).text();
    assert.doesNotMatch(latest, /Restore this version/);
    assert.doesNotMatch(latest, /action="\/a\/a1\/v\/3\/restore"/);
    assert.match(latest, /action="\/a\/a1\/v\/2\/restore"/);
    assert.match(latest, /action="\/a\/a1\/v\/1\/restore"/);
    assert.match(latest, /<a class="btn sm" href="\/a\/a1\/v\/1">.*View<\/a>/);
  });

  it('restores as the signed-in user and redirects to the artifact', async () => {
    const { app, restored } = fakeDeps({});
    const res = await post(app, '/a/a1/v/2/restore', {}, APP);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/a/a1?panel=versions');
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

describe('compare versions', () => {
  it('shows line counts in the Versions panel, linked to the changes', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1/v/2?panel=versions')).text();
    assert.match(
      body,
      /<a class="delta" href="\/a\/a1\/compare\?from=2&amp;to=3" title="3 lines added, 1 removed"><span class="add">\+3<\/span><span class="del">−1<\/span><\/a>/,
    );
    // v1 has nothing before it to compare with.
    assert.match(body, /<span class="delta" title="12 lines added, 0 removed">/);
    // The pane's Compare: the version on screen against the one before it.
    assert.match(
      body,
      /<div class="phead"><span>3 versions<\/span><a class="btn sm" href="\/a\/a1\/compare\?from=1&amp;to=2">/,
    );
    // Each other version compares with the one on screen, older first.
    assert.match(body, /href="\/a\/a1\/compare\?from=2&amp;to=3" title="Compare v2 with v3">/);
    assert.match(body, /href="\/a\/a1\/compare\?from=1&amp;to=2" title="Compare v1 with v2">/);
  });

  it('has no Compare for an artifact with one version', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/p1')).text();
    assert.doesNotMatch(body, /\/compare/);
  });

  it('renders the changes escaped, with line numbers, gaps and file statuses', async () => {
    const { app, compared } = fakeDeps({});
    const res = await get(app, '/a/a1/compare?from=1&to=3');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.deepEqual(compared, [['a1', 1, 3]]);
    assert.doesNotMatch(body, /<script>alert|<img src=x|<b>\.css/);
    assert.match(
      body,
      /<tr class="gap"><td class="ln" colspan="2">⋯<\/td><td class="code">7 unchanged lines<\/td><\/tr>/,
    );
    assert.match(
      body,
      /<tr><td class="ln">8<\/td><td class="ln">8<\/td><td class="code">&lt;p&gt;same&lt;\/p&gt;<\/td><\/tr>/,
    );
    assert.match(
      body,
      /<tr class="del"><td class="ln">9<\/td><td class="ln"><\/td><td class="code">&lt;script&gt;alert\(&quot;old&quot;\)&lt;\/script&gt;<\/td><\/tr>/,
    );
    assert.match(
      body,
      /<tr class="add"><td class="ln"><\/td><td class="ln">9<\/td><td class="code">&lt;img src=x onerror=alert\(1\)&gt;<\/td><\/tr>/,
    );
    assert.match(body, /<td class="ln">10<\/td><td class="code">&amp; more<\/td>/);
    assert.match(body, /<td class="ln">11<\/td><td class="ln">12<\/td><td class="code">end<\/td>/);
    assert.match(body, /<tr class="eof">.*No newline at end of file/);
    // The file list, and a section per file.
    assert.match(body, /<ul class="cfiles">/);
    assert.match(
      body,
      /<a href="#file-2"><span class="tag added">Added<\/span><span class="path mono">logo\.png<\/span><\/a>/,
    );
    assert.match(
      body,
      /<span class="path mono">old\.css → new &lt;b&gt;\.css<\/span><span class="tag renamed">Renamed<\/span>/,
    );
    assert.match(body, /Binary file: not compared\./);
    assert.match(body, /This diff is not shown: a comparison stops at 200 KB\./);
    assert.match(body, /<div class="notice warn">This comparison is longer than 200 KB/);
    assert.match(body, /· 3 files changed · 1 unchanged/);
    assert.match(
      body,
      /<a href="\/a\/a1\/compare\?from=1&amp;to=3" aria-current="true" class="on">Changes<\/a>/,
    );
    assert.match(
      body,
      /<a href="\/a\/a1\/compare\?from=1&amp;to=3&amp;mode=side">Side by side<\/a>/,
    );
    assert.match(body, /<option value="1" selected>v1 · /);
    assert.match(body, /<select class="input vpick" name="to"[^>]*><option value="3" selected>/);
    assert.match(
      body,
      /<form class="cmp-pick" method="get" action="\/a\/a1\/compare" data-autosubmit>/,
    );
    assert.doesNotMatch(body, /<iframe/);
  });

  it('defaults to the latest against the one before it', async () => {
    const { app, compared } = fakeDeps({});
    assert.equal((await get(app, '/a/a1/compare')).status, 200);
    assert.equal((await get(app, '/a/a1/compare?to=1')).status, 200);
    assert.equal((await get(app, '/a/a1/compare?from=3&to=')).status, 200);
    assert.deepEqual(compared, [
      ['a1', 2, 3],
      ['a1', 1, 1],
      ['a1', 3, 3],
    ]);
  });

  it('shows both versions side by side in sandboxed frames', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1/compare?from=1&to=2&mode=side')).text();
    const frames = body.match(/<iframe[^>]*>/g) ?? [];
    assert.equal(frames.length, 2);
    for (const [i, frame] of frames.entries()) {
      assert.match(
        frame,
        new RegExp(`src="https://content\\.test/s/9\\.sig/a1/${i + 1}/index\\.html"`),
      );
      assert.match(frame, /sandbox="allow-scripts allow-popups/);
      assert.doesNotMatch(frame, /allow-same-origin|data-artifact/);
    }
    assert.match(body, /<input type="hidden" name="mode" value="side">/);
    assert.doesNotMatch(body, /class="diff"/);

    const pdf = await (await get(app, '/a/p1/compare?mode=side')).text();
    for (const frame of pdf.match(/<iframe[^>]*>/g) ?? []) assert.doesNotMatch(frame, /sandbox/);
  });

  it('says so when nothing changed', async () => {
    const { app } = fakeDeps({
      artifacts: {
        compare: async (id, from, to) => {
          const a = artifact(id, 'markdown', 'Same');
          return {
            ...COMPARISON,
            artifact: { ...a, latestVersion: 2 },
            from: version(a, from, 'README.md'),
            to: version(a, to, 'README.md'),
            files: [],
            truncated: false,
          };
        },
      },
    });
    const body = await (await get(app, '/a/a1/compare?from=1&to=2')).text();
    assert.match(body, /<h2>No changes<\/h2><p class="muted">v1 and v2 have the same files\.<\/p>/);
  });

  it('is not found for an unknown artifact or version, or a bad number', async () => {
    const { app } = fakeDeps({});
    for (const path of [
      '/a/nope/compare',
      '/a/a1/compare?from=1&to=9',
      '/a/a1/compare?from=0&to=2',
      '/a/a1/compare?from=x',
    ]) {
      assert.equal((await get(app, path)).status, 404, path);
    }
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
    assert.match(body, /<a class="nav on" href="\/trash" aria-current="page">/);
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
      body.includes(
        '<code id="claude">claude mcp add --transport http -s user agent-artifacts https://app.test/mcp</code>',
      ),
    );
    assert.ok(body.includes('opencode mcp auth agent-artifacts'));
    assert.ok(body.includes('codex mcp login agent-artifacts'));
    // Tokens are the fallback, after the OAuth snippets.
    assert.ok(body.indexOf('Bearer &lt;TOKEN&gt;') > body.indexOf('codex mcp login'));
    assert.ok(body.includes('{env:AGENT_ARTIFACTS_TOKEN}'));
    assert.match(body, /href="\/settings\/connections"/);
    assert.match(body, /<a class="nav on" href="\/connect" aria-current="page">/);
  });
});

describe('share links', () => {
  it('has a share form in the Share tab, with the page version to pin', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1/v/2')).text();
    assert.match(body, /<form method="post" action="\/a\/a1\/share" class="share-form">/);
    assert.match(body, /<option value="latest">Always the latest version<\/option>/);
    assert.match(body, /<option value="2">Only version 2<\/option>/);
    assert.match(body, /No public links\./);
    assert.match(
      body,
      /<a class="btn primary" href="\/a\/a1\/v\/2\?panel=share" data-tab-link="share">/,
    );
    assert.doesNotMatch(body, /public link<\/a>/);
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
    // The Share tab is open, and every link on the page points at a GET URL.
    assert.doesNotMatch(tag(body, /<section class="pbody" id="pane-share"[^>]*>/), /hidden/);
    assert.match(body, /<input type="hidden" name="back" value="\/a\/a1">/);
    assert.ok(body.includes('mum &lt;3'));
    assert.ok(!body.includes('mum <3'));

    const page = await (await get(app, '/a/a1')).text();
    assert.ok(!page.includes('sl_secret1'));
    assert.match(
      page,
      /<a class="pill pub" href="\/a\/a1\?panel=share" data-tab-link="share">.*1 public link<\/a>/,
    );
    assert.match(page, /<small>Latest version · never expires · never opened · created/);
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
    assert.match(body, /You are viewing <b>v2<\/b>/);
    assert.match(body, /Pinned to <a href="\/a\/a1\/v\/2">v2<\/a> · expires <time/);
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
    assert.equal(res.headers.get('location'), '/a/a1?panel=share');
    assert.equal(links.length, 0);
    assert.equal((await post(app, '/a/a1/share/l1/revoke', {}, APP)).status, 404);
  });

  it('marks an expired link, and leaves it out of the count', async () => {
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
    assert.match(body, /<li class="link expired">/);
    assert.match(body, /<span class="badge">expired<\/span>/);
    assert.doesNotMatch(body, /class="pill pub"/);
  });
});

describe('comments', () => {
  it('renders the panel escaped, with threads up to this version', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1/v/2')).text();
    assert.match(body, /<section class="pbody" id="pane-comments" role="tabpanel"/);
    assert.match(body, /<button type="button" class="sel" id="comment-on-selection" hidden>/);
    assert.ok(body.includes('Fix &lt;script&gt;alert(2)&lt;/script&gt;'));
    assert.ok(!body.includes('<script>alert(2)'));
    // The owner's own comment says "you"; an agent's says "agent", with a neutral avatar.
    assert.match(
      body,
      /<span class="av" aria-hidden="true">OW<\/span>[\s\S]*?owner@example\.com<span class="you">you<\/span><small>· v2 · <time/,
    );
    assert.match(
      body,
      /<span class="av bot" aria-hidden="true">AX<\/span>[\s\S]*?agent &lt;x&gt;<span class="agent-tag">agent<\/span>/,
    );
    assert.ok(body.includes('<blockquote class="quote">Quoted &quot;&lt;b&gt;&quot;</blockquote>'));
    // Started on v3: not shown on v2.
    assert.ok(!body.includes('thread-th-new'));
    assert.ok(!body.includes('Old quote'));
    assert.match(body, /name="version" value="2"/);
    assert.match(body, /placeholder="Comment on v2, or select text in the page…"/);
    assert.match(body, />Comments<span class="n">1<\/span><\/a>/);
    assert.match(body, /1 open · 0 resolved/);
  });

  it('keeps resolved threads apart, and highlights only open quotes', async () => {
    const { app } = fakeDeps({});
    const body = await (await get(app, '/a/a1')).text();
    assert.match(
      body,
      /id="thread-th-open" data-exact="Quoted &quot;&lt;b&gt;&quot;" data-prefix="before &lt;" data-suffix="&gt; after">/,
    );
    assert.match(body, /<article class="thread done" id="thread-th-done">/);
    assert.match(body, /<details class="resolved"><summary>1 resolved thread<\/summary>/);
    assert.match(body, /<p class="where">on the whole page · v3<\/p>/);
    assert.equal(body.match(/data-exact=/g)?.length, 1);
    assert.match(body, /value="1">Resolve<\/button>/);
    assert.match(body, /value="0">Reopen<\/button>/);
    assert.match(body, /<button class="btn sm" type="submit" data-reply>Reply<\/button>/);
    assert.match(body, />Comments<span class="n">2<\/span><\/a>/);
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
    assert.equal(res.headers.get('location'), '/a/a1/v/2?panel=comments#thread-th-created');
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
    assert.equal(res.headers.get('location'), '/a/a1?panel=comments#thread-th-created');
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
    assert.equal(res.headers.get('location'), '/a/a1?panel=comments#thread-th-open');
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
    assert.equal(res.headers.get('location'), '/a/a1/v/2?panel=comments#thread-th-open');
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

describe('asks', () => {
  const askThread = (opts: { answered?: boolean; resolved?: boolean } = {}): Thread => ({
    ...(THREADS[2] as Thread),
    id: 'th-ask',
    version: 1,
    resolvedAt: opts.resolved ? '2026-01-05T00:00:00.000Z' : null,
    comments: [
      {
        id: 'c-ask',
        author: 'agent <x>',
        typed: false,
        body: 'Which <b>layout</b>?',
        createdAt: '2026-01-03T00:00:00.000Z',
        ask: {
          question: 'Which <b>layout</b>?',
          options: [
            { id: 'two', label: 'Two <i>columns</i>', detail: 'Denser <script>x</script>' },
            { id: 'one', label: 'One column' },
          ],
          recommended: { optionId: 'two', why: 'Fits <the> data' },
          answer: opts.answered
            ? {
                optionId: 'one',
                label: 'One column',
                by: 'owner@example.com',
                at: '2026-01-04T00:00:00.000Z',
                typed: true,
              }
            : null,
        },
      },
    ],
  });
  const page = async (thread: Thread) => {
    const { app } = fakeDeps({ comments: { list: async () => [thread] } });
    return (await get(app, '/a/a1')).text();
  };

  it('shows an ask as a card of option buttons, escaped, with the recommendation', async () => {
    const body = await page(askThread());
    assert.match(body, /<form method="post" action="\/a\/a1\/asks\/c-ask" class="ask-opts">/);
    assert.ok(body.includes('<span>Which &lt;b&gt;layout&lt;/b&gt;?</span>'));
    // The body equals the question, so it isn't shown twice.
    assert.equal(body.match(/Which &lt;b&gt;layout/g)?.length, 1);
    assert.match(
      body,
      /<button class="ask-opt rec" type="submit" name="optionId" value="two" aria-pressed="false">\s*<span class="ask-l1"><span class="ask-label">Two &lt;i&gt;columns&lt;\/i&gt;<\/span><span class="tag">Recommended<\/span><\/span>\s*<span class="ask-detail">Denser &lt;script&gt;x&lt;\/script&gt;<\/span>\s*<span class="ask-why">Fits &lt;the&gt; data<\/span>/,
    );
    assert.match(body, /<button class="ask-opt" type="submit" name="optionId" value="one"/);
    assert.ok(!body.includes('<script>x'));
    assert.match(body, /Waiting for your answer/);
    assert.match(body, /<span class="n ask" title="1 ask waiting for your answer">/);
  });

  it('marks the answer, which can change until the thread is resolved', async () => {
    const answered = await page(askThread({ answered: true }));
    assert.match(answered, /value="one" aria-pressed="true">/);
    assert.match(answered, /value="two" aria-pressed="false">/);
    assert.match(answered, /Answered by you · <time/);
    assert.doesNotMatch(answered, /class="n ask"/);
    assert.doesNotMatch(answered, /disabled/);

    const resolved = await page(askThread({ resolved: true }));
    assert.equal(resolved.match(/aria-pressed="false" disabled>/g)?.length, 2);
    assert.match(resolved, /Not answered before the thread was resolved/);
  });

  it('answers as the signed-in user from the app Origin only, whatever the form says', async () => {
    const { app, answered } = fakeDeps({});
    const res = await post(
      app,
      '/a/a1/asks/c-ask',
      { optionId: 'two', version: '2', by: 'agent', typed: '1', answer: 'one' },
      APP,
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/a/a1/v/2?panel=comments#thread-th-open');
    assert.deepEqual(answered, [['a1', 'c-ask', 'two', 'owner@example.com']]);

    assert.equal((await post(app, '/a/a1/asks/c-ask', { optionId: 'two' })).status, 403);
    assert.equal((await post(app, '/a/a1/asks/c-ask', { optionId: 'two' }, CONTENT)).status, 403);
    assert.equal(answered.length, 1);
  });

  it('refuses an option the ask does not have, and another artifact or comment', async () => {
    const { app } = fakeDeps({});
    const refused = await post(app, '/a/a1/asks/c-ask', { optionId: 'nope' }, APP);
    assert.equal(refused.status, 400);
    assert.equal((await post(app, '/a/p1/asks/c-ask', { optionId: 'two' }, APP)).status, 404);
    assert.equal((await post(app, '/a/a1/asks/c-x', { optionId: 'two' }, APP)).status, 404);
  });

  it('cannot be created from the comment form', async () => {
    const { app, added } = fakeDeps({});
    await post(
      app,
      '/a/a1/comments',
      { body: 'Hi', question: 'Q?', 'ask[question]': 'Q?', ask: '{"question":"Q?"}' },
      APP,
    );
    assert.equal(added.length, 1);
    assert.ok(!('ask' in (added[0]?.input ?? {})));
  });

  it('has an "Asks for you" library tab, a sidebar count and a badge on cards', async () => {
    const { app, browsed } = fakeDeps({});
    const body = await (await get(app, '/?tab=asks')).text();
    assert.equal(browsed[0]?.openAsks, true);
    assert.match(body, /aria-current="page">Asks for you<span class="n">1<\/span><\/a>/);
    assert.match(
      body,
      /<a class="nav on" href="\/\?tab=asks" aria-current="page">.*Asks for you<\/span><span class="n attn">2<\/span><\/a>/,
    );
    assert.match(body, /<a class="nav" href="\/">.*Library/);
    assert.match(body, /<span class="pill ask" title="1 ask waiting for your answer">/);

    const list = await (await get(app, '/?view=list')).text();
    assert.match(list, /<div class="row-pills"><span class="pill ask"/);
  });
});
