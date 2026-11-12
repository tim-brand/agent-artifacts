import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import type { Capabilities } from '../contracts.ts';
import { createCore } from '../core/index.ts';
import { SAMPLE_POLL } from './docs.ts';
import { createUiRoutes } from './routes.ts';

const APP = 'https://app.test';
const USER = { 'X-authentik-email': 'owner@example.com', 'X-authentik-name': 'The <Owner>' };

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-api-'));
  const config: Config = {
    port: 0,
    dataDir: join(dir, 'data'),
    appOrigin: APP,
    contentOrigin: 'https://content.test',
    signingSecret: 'x'.repeat(32),
    devUser: null,
  };
  const core = createCore(config);
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ui = createUiRoutes({ config, ...core });
  const request = (method: string, path: string, body?: unknown, headers = {}) =>
    ui.request(`${APP}${path}`, {
      method,
      headers: {
        ...USER,
        ...(method === 'GET' ? {} : { Origin: APP }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  const publish = async (capabilities: Partial<Capabilities>) =>
    (
      await core.artifacts.publish(
        { title: 'Poll', content: SAMPLE_POLL, format: 'html', capabilities },
        'agent',
      )
    ).id;
  return { ...core, request, publish };
}

const data = (id: string, doc = '') => `/api/artifacts/${id}/data${doc ? `/${doc}` : ''}`;

test('the API reads and writes an artifact that declares db, as the signed-in user', async (t) => {
  const { request, publish, data: service } = setup(t);
  const id = await publish({ db: true, viewer: true });

  assert.deepEqual(await (await request('GET', data(id, 'v1'))).json(), { doc: null });
  const put = await request('PUT', data(id, 'v1'), { data: { option: 'Pizza' } });
  assert.equal(put.status, 200);
  const { doc } = await put.json();
  assert.deepEqual(doc.data, { option: 'Pizza' });
  assert.equal(doc.updatedBy, 'owner@example.com');
  assert.equal((await service.get(id, 'v1'))?.updatedBy, 'owner@example.com');

  const patch = await request('PATCH', data(id, 'v1'), { fields: { at: 1 } });
  assert.deepEqual((await patch.json()).doc.data, { option: 'Pizza', at: 1 });
  const list = await (await request('GET', `${data(id)}?limit=10`)).json();
  assert.deepEqual(
    list.items.map((d: { id: string }) => d.id),
    ['v1'],
  );
  const query = await request('POST', `/api/artifacts/${id}/query`, { where: { option: 'Pizza' } });
  assert.equal((await query.json()).items.length, 1);
  const changes = await (await request('GET', `${data(id)}?since=1`)).json();
  assert.deepEqual(
    changes.items.map((c: { id: string }) => c.id),
    ['v1'],
  );
  assert.equal(changes.rev, 2);
  const del = await request('DELETE', data(id, 'v1'));
  assert.deepEqual(await del.json(), { deleted: true });
});

test('an artifact without the db capability is refused by the server', async (t) => {
  const { request, publish } = setup(t);
  const id = await publish({ viewer: true });
  for (const [method, path, body] of [
    ['GET', data(id, 'v1')],
    ['GET', data(id)],
    ['GET', `${data(id)}?since=0`],
    ['PUT', data(id, 'v1'), { data: {} }],
    ['PATCH', data(id, 'v1'), { fields: {} }],
    ['DELETE', data(id, 'v1')],
    ['POST', `/api/artifacts/${id}/query`, {}],
  ] as const) {
    const res = await request(method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json()).error, 'forbidden');
  }
});

test('updatedBy, an email, is only shown to a page with the viewer capability', async (t) => {
  const { request, publish, data: service } = setup(t);
  const id = await publish({ db: true });
  await service.set(id, 'a', { n: 1 }, 'someone@example.com');
  const get = await (await request('GET', data(id, 'a'))).json();
  assert.equal(get.doc.updatedBy, undefined);
  const list = await (await request('GET', data(id))).json();
  assert.equal(list.items[0].updatedBy, undefined);
  const put = await (await request('PUT', data(id, 'b'), { data: {} })).json();
  assert.equal(put.doc.updatedBy, undefined);
  assert.equal(JSON.stringify(list).includes('someone@'), false);
});

test('writes need the app Origin, and errors are JSON', async (t) => {
  const { request, publish } = setup(t);
  const id = await publish({ db: true });
  for (const origin of ['null', 'https://content.test', 'https://evil.test']) {
    const res = await request('PUT', data(id, 'a'), { data: {} }, { Origin: origin });
    assert.equal(res.status, 403, origin);
  }
  const missing = await request('GET', data('nope', 'a'));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'not_found');
  for (const [method, path, body] of [
    ['GET', data(id, '..%2Fx')],
    ['GET', `${data(id)}?since=abc`],
    ['PUT', data(id, 'a'), 'not json'],
    ['PUT', data(id, 'a'), { data: [1] }],
    ['PATCH', data(id, 'a'), { fields: 'x' }],
    ['POST', `/api/artifacts/${id}/query`, { where: { 'a"': 1 } }],
  ] as const) {
    const res = await request(method, path, body);
    assert.equal(res.status, 400, `${method} ${path}`);
    assert.equal((await res.json()).error, 'invalid_input');
  }
  const big = await request('PUT', data(id, 'a'), { data: { s: 'x'.repeat(300 * 1024) } });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, 'too_large');
  const unknown = await request('GET', '/api/nothing');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'not_found');
});

test('writes are rate limited per artifact', async (t) => {
  const { request, publish } = setup(t);
  const busy = await publish({ db: true });
  const calm = await publish({ db: true });
  let status = 200;
  let writes = 0;
  while (status === 200 && writes < 100) {
    status = (await request('PUT', data(busy, 'n'), { data: { writes } })).status;
    writes++;
  }
  assert.equal(status, 429);
  assert.equal(writes, 61);
  assert.equal((await request('GET', data(busy, 'n'))).status, 200);
  assert.equal((await request('PUT', data(calm, 'n'), { data: {} })).status, 200);
});

test("a deleted artifact's data is gone from the API", async (t) => {
  const { request, publish, artifacts } = setup(t);
  const id = await publish({ db: true });
  await request('PUT', data(id, 'a'), { data: {} });
  await artifacts.delete(id);
  assert.equal((await request('GET', data(id, 'a'))).status, 404);
  assert.equal((await request('PUT', data(id, 'a'), { data: {} })).status, 404);
});

test('the artifact page gives the frame its id and capabilities, and the viewer only when declared', async (t) => {
  const { request, publish } = setup(t);
  const live = await publish({ db: true, viewer: true });
  const page = await (await request('GET', `/a/${live}`)).text();
  assert.match(page, new RegExp(`data-artifact="${live}"`));
  assert.match(page, /data-capabilities="\{&quot;db&quot;:true,&quot;viewer&quot;:true\}"/);
  assert.match(
    page,
    /data-viewer="\{&quot;email&quot;:&quot;owner@example\.com&quot;,&quot;name&quot;:&quot;The &lt;Owner&gt;&quot;\}"/,
  );
  assert.match(page, /title="Live page: db, viewer"/);

  const dbOnly = await publish({ db: true });
  const other = await (await request('GET', `/a/${dbOnly}`)).text();
  assert.doesNotMatch(other, /data-viewer|owner@example\.com&quot;/);
  assert.match(other, /data-capabilities="\{&quot;db&quot;:true,&quot;viewer&quot;:false\}"/);
});

test('the docs page shows the sample poll, escaped', async (t) => {
  const { request } = setup(t);
  const res = await request('GET', '/docs/runtime');
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /<h1>Live pages<\/h1>/);
  assert.match(page, /&lt;!doctype html&gt;/);
  assert.match(page, /openArtifacts/);
  // The only scripts on the page are the app's own.
  assert.deepEqual(page.match(/<script[^>]*>/g), [
    page.match(/<script src="\/static\/app\.js\?v=[0-9a-f]{12}" defer>/)?.[0],
  ]);
});
