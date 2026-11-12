import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { test } from 'node:test';
import type {
  Artifact,
  ArtifactService,
  ContentSigner,
  Deps,
  FileInfo,
  Format,
  Version,
} from '../contracts.ts';
import { createContentRoutes } from './routes.ts';

const APP = 'https://app.test';
const CONTENT = 'https://content.test';
const SECRET = 'x'.repeat(32);
const SANDBOX = /^sandbox allow-scripts .*; frame-ancestors https:\/\/app\.test$/;

const sign = (id: string, version: number, exp: number) =>
  createHmac('sha256', SECRET).update(`${id}/${version}/${exp}`).digest('base64url');

const signer: ContentSigner = {
  url(id, version, path, ttlSeconds = 3600) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const rest = path.split('/').map(encodeURIComponent).join('/');
    return `${CONTENT}/s/${exp}.${sign(id, version, exp)}/${id}/${version}/${rest}`;
  },
  verify(id, version, exp, sig) {
    const expected = Buffer.from(sign(id, version, exp));
    const given = Buffer.from(sig);
    return (
      exp > Date.now() / 1000 &&
      given.length === expected.length &&
      timingSafeEqual(given, expected)
    );
  },
};

type Stored = {
  format: Format;
  entry: string;
  files: Record<string, [string, string]>;
  live?: boolean;
};

const store: Record<string, Stored> = {
  site: {
    format: 'html',
    entry: 'index.html',
    files: {
      'index.html': [
        'text/html; charset=utf-8',
        '<link href="assets/style.css"><script src="app.js">',
      ],
      'app.js': ['text/javascript; charset=utf-8', 'console.log(1)'],
      'assets/style.css': ['text/css; charset=utf-8', 'body{}'],
      'my file.txt': ['text/plain; charset=utf-8', 'spaced'],
    },
  },
  doc: {
    format: 'markdown',
    entry: 'README.md',
    files: {
      'README.md': ['text/markdown; charset=utf-8', '# Hello\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'],
      'notes.md': ['text/markdown; charset=utf-8', '# Notes'],
    },
  },
  code: {
    format: 'code',
    entry: 'main.ts',
    files: {
      'main.ts': [
        'text/plain; charset=utf-8',
        'const x = "</script><script>alert(1)</script>";\nexport default x;\n',
      ],
    },
  },
  svg: {
    format: 'image',
    entry: 'charts/q3 "big".svg',
    files: {
      'charts/q3 "big".svg': [
        'image/svg+xml; charset=utf-8',
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ],
    },
  },
  pdf: {
    format: 'pdf',
    entry: 'document.pdf',
    files: { 'document.pdf': ['application/pdf', '%PDF-1.4 fake'] },
  },
  live: {
    format: 'html',
    entry: 'index.html',
    live: true,
    files: {
      'index.html': [
        'text/html; charset=utf-8',
        '\uFEFF\n<!-- made by <b>an agent</b> -->\n<!DOCTYPE html>\n<html lang="nl"><head><script>openArtifacts.ready</script>',
      ],
    },
  },
};

const readCalls: string[] = [];

const artifacts: ArtifactService = {
  async get(id, version) {
    const stored = store[id];
    if (!stored || version !== 1) return null;
    const files: FileInfo[] = Object.entries(stored.files).map(([path, [contentType, text]]) => ({
      path,
      contentType,
      size: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    }));
    const now = new Date(0).toISOString();
    const artifact: Artifact = {
      id,
      title: `Title <${id}>`,
      description: '',
      format: stored.format,
      latestVersion: 1,
      capabilities: { db: stored.live === true, viewer: false },
      createdAt: now,
      updatedAt: now,
    };
    const v: Version = {
      artifactId: id,
      version: 1,
      entry: stored.entry,
      format: stored.format,
      files,
      createdAt: now,
      publishedBy: 'test',
      linesAdded: null,
      linesRemoved: null,
    };
    return { artifact, version: v };
  },
  async readFile(id, version, path) {
    readCalls.push(path);
    const file = version === 1 ? store[id]?.files[path] : undefined;
    return file ? { contentType: file[0], bytes: new TextEncoder().encode(file[1]) } : null;
  },
  list: () => Promise.reject(new Error('unused')),
  browse: () => Promise.reject(new Error('unused')),
  count: () => Promise.reject(new Error('unused')),
  summary: () => Promise.reject(new Error('unused')),
  search: () => Promise.reject(new Error('unused')),
  listVersions: () => Promise.reject(new Error('unused')),
  delete: () => Promise.reject(new Error('unused')),
  undelete: () => Promise.reject(new Error('unused')),
  listDeleted: () => Promise.reject(new Error('unused')),
  restoreVersion: () => Promise.reject(new Error('unused')),
  compare: () => Promise.reject(new Error('unused')),
  publish: () => Promise.reject(new Error('unused')),
};

const deps = {
  config: {
    port: 0,
    dataDir: '',
    appOrigin: APP,
    contentOrigin: CONTENT,
    signingSecret: SECRET,
    devUser: null,
    authEmailHeader: 'X-authentik-email',
    authNameHeader: 'X-authentik-name',
  },
  artifacts,
  signer,
  tokens: {} as Deps['tokens'],
  oauth: {} as Deps['oauth'],
  shareLinks: {} as Deps['shareLinks'],
  comments: {} as Deps['comments'],
  data: {} as Deps['data'],
} satisfies Deps;

const app = createContentRoutes(deps);
const get = (url: string, init?: RequestInit) => app.request(url, init);

function assertSafeHeaders(res: Response) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.match(
    res.headers.get('content-security-policy') ?? '',
    /frame-ancestors https:\/\/app\.test$/,
  );
}

const BRIDGE_TAG = /\n<script src="\/_aa\/bridge\.js\?v=[0-9a-f]{16}"><\/script>\n$/;

test('a valid link serves the bytes with their content type, sandboxed', async () => {
  const res = await get(signer.url('site', 1, 'app.js'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await res.text(), store.site?.files['app.js']?.[1]);
  assert.match(res.headers.get('content-security-policy') ?? '', SANDBOX);
  assert.match(res.headers.get('cache-control') ?? '', /^private, max-age=(3600|359\d)$/);
  assert.match(res.headers.get('etag') ?? '', /^"[0-9a-f]{64}"$/);
  assertSafeHeaders(res);
});

test('cache lifetime never outlives the link', async () => {
  const res = await get(signer.url('site', 1, 'app.js', 60));
  assert.match(res.headers.get('cache-control') ?? '', /^private, max-age=(60|59|58)$/);
});

test('a matching If-None-Match gets 304', async () => {
  const url = signer.url('site', 1, 'app.js');
  const etag = (await get(url)).headers.get('etag') ?? '';
  const res = await get(url, { headers: { 'if-none-match': etag } });
  assert.equal(res.status, 304);
  assertSafeHeaders(res);
});

test('relative links in a multi-file artifact resolve under the same signed prefix', async () => {
  const page = signer.url('site', 1, 'index.html');
  for (const [href, type, body] of [
    ['app.js', 'text/javascript; charset=utf-8', 'console.log(1)'],
    ['assets/style.css', 'text/css; charset=utf-8', 'body{}'],
    ['my%20file.txt', 'text/plain; charset=utf-8', 'spaced'],
  ] as const) {
    const res = await get(new URL(href, page).href);
    assert.equal(res.status, 200, href);
    assert.equal(res.headers.get('content-type'), type);
    assert.equal(await res.text(), body);
  }
});

test('HEAD returns the headers without a body', async () => {
  const res = await get(signer.url('site', 1, 'app.js'), { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
  assertSafeHeaders(res);
});

test('a PDF gets frame-ancestors but no sandbox', async () => {
  const res = await get(signer.url('pdf', 1, 'document.pdf'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-security-policy'), `frame-ancestors ${APP}`);
});

test('expired, tampered or mismatched links get 403', async () => {
  const valid = signer.url('site', 1, 'index.html');
  const exp = Math.floor(Date.now() / 1000) - 10;
  const urls = [
    signer.url('site', 1, 'index.html', -10),
    `${CONTENT}/s/${exp}.${sign('site', 1, exp)}/site/1/index.html`,
    valid.replace(/(\/s\/\d+\.)([A-Za-z0-9_-])/, (_, pre, ch) => `${pre}${ch === 'A' ? 'B' : 'A'}`),
    valid.replace('/site/1/', '/doc/1/'),
    valid.replace('/site/1/', '/site/2/'),
    valid.replace(/\/s\/\d+/, (m) => `${m}0`),
    `${CONTENT}/s/garbage/site/1/index.html`,
    valid.replace('/site/1/', '/site/01/'),
    valid.replace('/site/1/', '/site/1.0/'),
  ];
  for (const url of urls) {
    const res = await get(url);
    assert.equal(res.status, 403, url);
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await res.text(), 'Link expired or invalid');
    assertSafeHeaders(res);
  }
});

test('path traversal never reaches the store', async () => {
  const prefix = signer.url('site', 1, 'x').slice(0, -1);
  readCalls.length = 0;
  for (const rest of [
    '..%2F..%2Fetc%2Fpasswd',
    'assets%2F..%2F..%2Fsecret',
    'assets/%2e%2e%2fsecret',
    '..%5Csecret',
    'a%00b',
    'a//b',
    '%E0%A4%A',
    '',
  ]) {
    const res = await get(prefix + rest);
    assert.ok(res.status === 404 || res.status === 403, `${rest}: ${res.status}`);
    assertSafeHeaders(res);
  }
  // Plain ../ is normalized away by URL parsing, leaving a link that no longer verifies.
  const res = await get(`${prefix}../../../etc/passwd`);
  assert.equal(res.status, 403);
  assert.deepEqual(readCalls, []);
});

test('missing artifacts, versions, files and other routes are 404', async () => {
  for (const url of [
    signer.url('nope', 1, 'index.html'),
    signer.url('site', 2, 'index.html'),
    signer.url('site', 1, 'missing.html'),
    signer.url('site', 1, '').slice(0, -1),
    `${CONTENT}/`,
    `${CONTENT}/healthz`,
    `${CONTENT}/s/`,
  ]) {
    const res = await get(url);
    assert.equal(res.status, 404, url);
    assertSafeHeaders(res);
  }
  const post = await get(signer.url('site', 1, 'index.html'), { method: 'POST' });
  assert.equal(post.status, 404);
  assertSafeHeaders(post);
});

test('a markdown entry is rendered; ?raw=1 and other .md files are raw', async () => {
  const rendered = await get(signer.url('doc', 1, 'README.md'));
  assert.equal(rendered.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(rendered.headers.get('content-security-policy') ?? '', SANDBOX);
  const html = await rendered.text();
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<title>Title &lt;doc&gt;<\/title>/);
  // The bridge is the only script, right after the doctype.
  assert.equal(html.match(/<script/g)?.length, 1);
  assert.match(
    html,
    /^<!doctype html>\n<script src="\/_aa\/bridge\.js\?v=[0-9a-f]{16}"><\/script>\n\n<html lang="en">/,
  );

  const raw = await get(`${signer.url('doc', 1, 'README.md')}?raw=1`);
  assert.equal(raw.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await raw.text(), store.doc?.files['README.md']?.[1]);
  assert.notEqual(raw.headers.get('etag'), rendered.headers.get('etag'));

  const other = await get(signer.url('doc', 1, 'notes.md'));
  assert.equal(other.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await other.text(), '# Notes');
});

test('a code entry is highlighted and HTML-escaped', async () => {
  const res = await get(signer.url('code', 1, 'main.ts'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(res.headers.get('content-security-policy') ?? '', SANDBOX);
  const html = await res.text();
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<\/script/i);
  assert.match(html, /&lt;\/script&gt;&lt;script&gt;alert\(1\)/);
  assert.match(html, /class="hljs-keyword">const</);
  assert.match(html, /prefers-color-scheme: dark/);

  const raw = await get(`${signer.url('code', 1, 'main.ts')}?raw=1`);
  assert.equal(raw.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await raw.text(), store.code?.files['main.ts']?.[1]);
});

test('an image entry is a page that centers it; ?raw=1 is the bytes, sandboxed even as SVG', async () => {
  const pageUrl = signer.url('svg', 1, 'charts/q3 "big".svg');
  const page = await get(pageUrl);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(page.headers.get('content-security-policy') ?? '', SANDBOX);
  assertSafeHeaders(page);
  const html = await page.text();
  assert.match(
    html,
    /<img class="image" src="q3%20%22big%22\.svg\?raw=1" alt="Title &lt;svg&gt;">/,
  );
  assert.match(html, /<body class="image">/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.doesNotMatch(html, /<script/);

  const src = /src="([^"]+)"/.exec(html)?.[1] ?? '';
  const raw = await get(new URL(src, pageUrl).href);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(raw.headers.get('content-security-policy') ?? '', SANDBOX);
  assertSafeHeaders(raw);
  assert.equal(await raw.text(), store.svg?.files['charts/q3 "big".svg']?.[1]);
  assert.notEqual(raw.headers.get('etag'), page.headers.get('etag'));
});

test('an html entry gets the bridge after its own bytes; ?raw=1 and other files do not', async () => {
  const url = signer.url('site', 1, 'index.html');
  const res = await get(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(res.headers.get('content-security-policy') ?? '', SANDBOX);
  const html = await res.text();
  const original = store.site?.files['index.html']?.[1] ?? '';
  assert.ok(html.startsWith(original));
  assert.match(html.slice(original.length), BRIDGE_TAG);
  assert.match(res.headers.get('etag') ?? '', /^"[0-9a-f]{64}-bridge-[0-9a-f]{16}"$/);

  const raw = await get(`${url}?raw=1`);
  assert.equal(await raw.text(), original);
  assert.notEqual(raw.headers.get('etag'), res.headers.get('etag'));

  for (const [id, path] of [
    ['site', 'my file.txt'],
    ['code', 'main.ts'],
    ['svg', 'charts/q3 "big".svg'],
    ['doc', 'notes.md'],
  ] as const) {
    assert.doesNotMatch(await (await get(signer.url(id, 1, path))).text(), /bridge\.js/, path);
  }
});

test('the bridge goes right after a leading doctype, past a BOM and comments', async () => {
  const res = await get(signer.url('live', 1, 'index.html'));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const original = store.live?.files['index.html']?.[1] ?? '';
  const prologue = '\uFEFF\n<!-- made by <b>an agent</b> -->\n<!DOCTYPE html>';
  const html = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  assert.ok(html.startsWith(prologue));
  const rest = html.slice(prologue.length);
  assert.match(rest, /^\n<script src="\/_aa\/bridge\.js\?v=[0-9a-f]{16}"><\/script>\n/);
  // Byte offsets, not string indexes: the BOM is three bytes.
  assert.equal(rest.replace(/^\n<script[^\n]*\n/, ''), original.slice(prologue.length));
});

test('the bridge script is served unsigned, talking only to the app origin', async () => {
  const html = await (await get(signer.url('site', 1, 'index.html'))).text();
  const src = /<script src="([^"]+)"><\/script>\n$/.exec(html)?.[1] ?? '';
  const res = await get(new URL(src, CONTENT).href);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  assertSafeHeaders(res);
  const js = await res.text();
  assert.ok(js.includes(`const APP_ORIGIN = "${APP}";`));
  assert.doesNotMatch(js, /__APP_ORIGIN__/);
  assert.match(js, /event\.source !== window\.parent \|\| event\.origin !== APP_ORIGIN/);
  assert.equal((await get(`${CONTENT}/_aa/bridge.js`, { method: 'POST' })).status, 404);
  assert.equal((await get(`${CONTENT}/_aa/other.js`)).status, 404);
});
