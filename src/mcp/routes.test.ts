import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import {
  AppError,
  type Artifact,
  type ArtifactService,
  type Deps,
  type PublishInput,
  type SearchQuery,
  type TokenInfo,
  type Version,
} from '../contracts.ts';
import { createMcpRoutes } from './routes.ts';

const TOKEN = 'aa_good';
const tokenInfo: TokenInfo = {
  id: 't1',
  name: 'claude-laptop',
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: null,
};

const artifact: Artifact = {
  id: 'art1',
  title: 'Hello',
  description: '',
  format: 'markdown',
  latestVersion: 2,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const version: Version = {
  artifactId: 'art1',
  version: 2,
  entry: 'README.md',
  format: 'markdown',
  files: [{ path: 'README.md', size: 7, contentType: 'text/markdown', sha256: 'x' }],
  createdAt: '2026-01-02T00:00:00Z',
  publishedBy: 'claude-laptop',
};

function setup(overrides: Partial<ArtifactService> = {}) {
  const published: { input: PublishInput; publishedBy: string }[] = [];
  const searched: SearchQuery[] = [];
  const artifacts: ArtifactService = {
    async publish(input, publishedBy) {
      published.push({ input, publishedBy });
      return { id: 'art1', version: 1, title: input.title ?? '', url: 'https://app.test/a/art1' };
    },
    async get(id) {
      return id === 'art1' ? { artifact, version } : null;
    },
    async readFile() {
      return { bytes: new TextEncoder().encode('# Hello'), contentType: 'text/markdown' };
    },
    async list() {
      return { items: [artifact], nextCursor: null };
    },
    async search(query) {
      searched.push(query);
      return { items: [{ artifact, snippet: 'say «hello» there' }], nextCursor: 'c2' };
    },
    async listVersions(id) {
      return id === 'art1' ? [version] : null;
    },
    async delete(id) {
      return id === 'art1';
    },
    ...overrides,
  };
  const deps: Deps = {
    config: {
      port: 3000,
      dataDir: './data',
      appOrigin: 'https://app.test',
      contentOrigin: 'https://content.test',
      signingSecret: 'x'.repeat(32),
      devUser: null,
    },
    artifacts,
    tokens: {
      create: async () => assert.fail('not used'),
      list: async () => [],
      revoke: async () => false,
      verify: async (token) => (token === TOKEN ? tokenInfo : null),
    },
    signer: { url: () => '', verify: () => false },
  };
  const app = new Hono();
  app.route('/mcp', createMcpRoutes(deps));
  return { app, published, searched };
}

let nextId = 1;
async function rpc(app: Hono, method: string, params?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
}

async function callTool(app: Hono, name: string, args: Record<string, unknown>) {
  const res = await rpc(app, 'tools/call', { name, arguments: args });
  assert.equal(res.status, 200);
  const body = await res.json();
  const result = body.result;
  return { result, json: JSON.parse(result.content[0].text) };
}

test('401 without a token or with a bad one', async () => {
  const { app } = setup();
  for (const token of [null, 'aa_bad']) {
    const res = await rpc(app, 'tools/list', {}, token);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="agent-artifacts"');
    assert.equal((await res.json()).error, 'unauthorized');
  }
});

test('ignores X-authentik headers', async () => {
  const { app } = setup();
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'x-authentik-email': 'admin@example.com', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 401);
});

test('GET and DELETE are 405', async () => {
  const { app } = setup();
  for (const method of ['GET', 'DELETE']) {
    const res = await app.request('/mcp', {
      method,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 405);
  }
});

test('initialize and tools/list', async () => {
  const { app } = setup();
  const init = await rpc(app, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(init.status, 200);
  const initBody = await init.json();
  assert.equal(initBody.result.serverInfo.name, 'agent-artifacts');
  assert.match(initBody.result.instructions, /artifacts/);

  const list = await rpc(app, 'tools/list', {});
  const names = (await list.json()).result.tools.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, [
    'delete_artifact',
    'get_artifact',
    'list_artifacts',
    'list_versions',
    'publish_artifact',
    'search_artifacts',
  ]);
});

test('publish_artifact passes input through with publishedBy = token name', async () => {
  const { app, published } = setup();
  const input = {
    title: 'Site',
    format: 'html',
    files: { 'index.html': '<h1>hi</h1>', 'logo.png': { base64: 'AAAA' } },
    entry: 'index.html',
    expectedVersion: 3,
  };
  const { result, json } = await callTool(app, 'publish_artifact', input);
  assert.equal(result.isError, undefined);
  assert.deepEqual(published, [{ input, publishedBy: 'claude-laptop' }]);
  assert.deepEqual(json, { id: 'art1', version: 1, title: 'Site', url: 'https://app.test/a/art1' });
  assert.deepEqual(result.structuredContent, json);
});

test('AppError becomes an isError result', async () => {
  const { app } = setup({
    publish: async () => {
      throw new AppError('version_conflict', 'Latest is 4', { latestVersion: 4 });
    },
  });
  const { result, json } = await callTool(app, 'publish_artifact', { id: 'art1', content: 'x' });
  assert.equal(result.isError, true);
  assert.deepEqual(json, {
    error: 'version_conflict',
    message: 'Latest is 4',
    details: { latestVersion: 4 },
  });
});

test('unknown errors are hidden from the client', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { app } = setup({
    list: async () => {
      throw new Error('database exploded at /secret/path');
    },
  });
  const { result, json } = await callTool(app, 'list_artifacts', {});
  assert.equal(result.isError, true);
  assert.equal(json.error, 'internal_error');
  assert.doesNotMatch(result.content[0].text, /secret/);
});

test('get_artifact inlines the entry text and links the version page', async () => {
  const { app } = setup();
  const { json } = await callTool(app, 'get_artifact', { id: 'art1' });
  assert.equal(json.entryContent, '# Hello');
  assert.equal(json.url, 'https://app.test/a/art1/v/2');
  assert.equal(json.version.files.length, 1);

  const missing = await callTool(app, 'get_artifact', { id: 'nope' });
  assert.equal(missing.result.isError, true);
  assert.equal(missing.json.error, 'not_found');
});

test('list_artifacts, list_versions and delete_artifact', async () => {
  const { app } = setup();
  const list = await callTool(app, 'list_artifacts', { format: 'markdown', limit: 5 });
  assert.equal(list.json.items[0].url, 'https://app.test/a/art1');
  assert.equal(list.json.nextCursor, null);

  const versions = await callTool(app, 'list_versions', { id: 'art1' });
  assert.equal(versions.json.versions[0].version, 2);

  const deleted = await callTool(app, 'delete_artifact', { id: 'art1' });
  assert.deepEqual(deleted.json, { deleted: true });
});

test('get_artifact inlines an SVG but not a raster image', async () => {
  for (const [path, contentType, inlined] of [
    ['chart.svg', 'image/svg+xml; charset=utf-8', true],
    ['shot.png', 'image/png', false],
  ] as const) {
    const image: Version = {
      ...version,
      entry: path,
      format: 'image',
      files: [{ path, size: 6, contentType, sha256: 'x' }],
    };
    const { app } = setup({
      get: async () => ({ artifact: { ...artifact, format: 'image' }, version: image }),
      readFile: async () => ({ bytes: new TextEncoder().encode('<svg/>'), contentType }),
    });
    const { json } = await callTool(app, 'get_artifact', { id: 'art1' });
    assert.equal(json.entryContent, inlined ? '<svg/>' : undefined, path);
    assert.equal(typeof json.entryContentOmitted, inlined ? 'undefined' : 'string', path);
  }
});

test('search_artifacts passes the query through and returns hits with url and snippet', async () => {
  const { app, searched } = setup();
  const { result, json } = await callTool(app, 'search_artifacts', {
    query: 'hello AND "x',
    limit: 5,
    cursor: 'c1',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(searched, [{ query: 'hello AND "x', limit: 5, cursor: 'c1' }]);
  assert.equal(json.items[0].id, 'art1');
  assert.equal(json.items[0].title, 'Hello');
  assert.equal(json.items[0].url, 'https://app.test/a/art1');
  assert.equal(json.items[0].snippet, 'say «hello» there');
  assert.equal(json.nextCursor, 'c2');

  const missing = await rpc(app, 'tools/call', { name: 'search_artifacts', arguments: {} });
  assert.equal((await missing.json()).result.isError, true);
});
