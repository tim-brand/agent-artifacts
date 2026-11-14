import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { AppError, type Capabilities, DATA_LIMITS } from '../contracts.ts';
import { createCore } from './index.ts';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-data-'));
  const config: Config = {
    port: 0,
    trustedProxies: 1,
    dataDir: join(dir, 'data'),
    appOrigin: 'https://app.example',
    contentOrigin: 'https://content.example',
    signingSecret: 'x'.repeat(32),
    devUser: null,
    authEmailHeader: 'X-authentik-email',
    authNameHeader: 'X-authentik-name',
    authMode: 'proxy',
    authUsers: [],
  };
  let core = createCore(config);
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get artifacts() {
      return core.artifacts;
    },
    get data() {
      return core.data;
    },
    purge: (now: number) => core.purge(now),
    publish: async (capabilities?: Partial<Capabilities>) =>
      (
        await core.artifacts.publish(
          { title: 'Poll', content: '<p>poll</p>', format: 'html', capabilities },
          'agent',
        )
      ).id,
    /** Work on the database file directly, with the app closed. */
    withDb(fn: (db: DatabaseSync) => void) {
      core.close();
      const db = new DatabaseSync(join(config.dataDir, 'artifacts.db'));
      db.exec('PRAGMA foreign_keys = ON');
      try {
        fn(db);
      } finally {
        db.close();
      }
      core = createCore(config);
    },
  };
}

const code = (c: AppError['code']) => (error: unknown) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, c, error.message);
  return true;
};

test('capabilities: none by default, replaced when given, kept when omitted', async (t) => {
  const { artifacts, publish } = setup(t);
  const id = await publish();
  const caps = async () => (await artifacts.get(id))?.artifact.capabilities;
  assert.deepEqual(await caps(), { db: false, viewer: false });

  // Settings only: no new version.
  await artifacts.publish({ id, capabilities: { db: true, viewer: true } }, 'a');
  assert.deepEqual(await caps(), { db: true, viewer: true });
  assert.equal((await artifacts.get(id))?.artifact.latestVersion, 1);

  await artifacts.publish({ id, content: '<p>v2</p>', format: 'html' }, 'a');
  assert.deepEqual(await caps(), { db: true, viewer: true });
  await artifacts.restoreVersion(id, 1, 'a');
  assert.deepEqual(await caps(), { db: true, viewer: true });

  await artifacts.publish({ id, capabilities: { viewer: true } }, 'a');
  assert.deepEqual(await caps(), { db: false, viewer: true });

  for (const capabilities of [{ net: true }, { db: 'yes' }, [], null]) {
    await assert.rejects(
      artifacts.publish({ id, capabilities: capabilities as never }, 'a'),
      code('invalid_input'),
    );
  }
});

test('every data call needs the db capability, checked on the server', async (t) => {
  const { data, artifacts, publish } = setup(t);
  const id = await publish({ viewer: true });
  await assert.rejects(data.get(id, 'x'), code('forbidden'));
  await assert.rejects(data.set(id, 'x', {}, 'me'), code('forbidden'));
  await assert.rejects(data.update(id, 'x', {}, 'me'), code('forbidden'));
  await assert.rejects(data.delete(id, 'x', 'me'), code('forbidden'));
  await assert.rejects(data.list(id), code('forbidden'));
  await assert.rejects(data.query(id), code('forbidden'));
  await assert.rejects(data.changes(id, 0), code('forbidden'));
  await assert.rejects(data.get('missing', 'x'), code('not_found'));

  // Taking it away again hides the data that is there.
  await artifacts.publish({ id, capabilities: { db: true } }, 'a');
  await data.set(id, 'x', { a: 1 }, 'me');
  await artifacts.publish({ id, capabilities: {} }, 'a');
  await assert.rejects(data.get(id, 'x'), code('forbidden'));
});

test('set, get, update (top-level merge), delete and list', async (t) => {
  const { data, publish } = setup(t);
  const id = await publish({ db: true });
  assert.equal(await data.get(id, 'a'), null);

  const set = await data.set(id, 'a', { title: 'Milk', tags: ['x'], meta: { n: 1 } }, 'me@x');
  assert.equal(set.id, 'a');
  assert.equal(set.updatedBy, 'me@x');
  const updated = await data.update(id, 'a', { done: true, meta: { m: 2 } }, 'agent');
  assert.deepEqual(updated.data, { title: 'Milk', tags: ['x'], meta: { m: 2 }, done: true });
  assert.equal(updated.updatedBy, 'agent');
  assert.deepEqual((await data.get(id, 'a'))?.data, updated.data);

  const created = await data.update(id, 'b', { done: false }, 'me@x');
  assert.deepEqual(created.data, { done: false });

  for (const n of [3, 4, 5]) await data.set(id, `c${n}`, { n }, 'me@x');
  const first = await data.list(id, { limit: 2 });
  assert.deepEqual(
    first.items.map((d) => d.id),
    ['a', 'b'],
  );
  const rest = await data.list(id, { cursor: first.nextCursor ?? undefined });
  assert.deepEqual(
    rest.items.map((d) => d.id),
    ['c3', 'c4', 'c5'],
  );
  assert.equal(rest.nextCursor, null);

  assert.equal(await data.delete(id, 'a', 'me@x'), true);
  assert.equal(await data.delete(id, 'a', 'me@x'), false);
  assert.equal(await data.get(id, 'a'), null);
  assert.equal((await data.list(id)).items.length, 4);
  // A deleted document can be written again.
  assert.deepEqual((await data.update(id, 'a', { again: true }, 'me')).data, { again: true });
});

test('limits: document ids, document size, JSON objects only, documents per artifact', async (t) => {
  const ctx = setup(t);
  const id = await ctx.publish({ db: true });
  for (const bad of ['', 'a/b', '../x', 'a.b', 'é', 'x'.repeat(DATA_LIMITS.docId + 1)]) {
    await assert.rejects(ctx.data.set(id, bad, {}, 'me'), code('invalid_input'), bad);
    await assert.rejects(ctx.data.get(id, bad), code('invalid_input'), bad);
  }
  await ctx.data.set(id, 'x'.repeat(DATA_LIMITS.docId), {}, 'me');
  for (const bad of [[], 'text', 42, null]) {
    await assert.rejects(ctx.data.set(id, 'a', bad as never, 'me'), code('invalid_input'));
    await assert.rejects(ctx.data.update(id, 'a', bad as never, 'me'), code('invalid_input'));
  }

  const room = DATA_LIMITS.docBytes - '{"s":""}'.length;
  await ctx.data.set(id, 'big', { s: 'x'.repeat(room) }, 'me');
  await assert.rejects(
    ctx.data.set(id, 'big', { s: 'x'.repeat(room + 1) }, 'me'),
    code('too_large'),
  );
  // The merged document counts for update.
  await assert.rejects(ctx.data.update(id, 'big', { more: 1 }, 'me'), code('too_large'));

  // Fill up to the limit directly, then one more is refused, but a replace still works.
  ctx.withDb((db) => {
    const insert = db.prepare(
      `INSERT INTO artifact_data (artifact_id, doc_id, json, rev, updated_at, updated_by)
       VALUES (?, ?, '{}', 0, '2026-01-01T00:00:00.000Z', 'x')`,
    );
    for (let i = 2; i < DATA_LIMITS.docs; i++) insert.run(id, `fill${i}`);
  });
  await assert.rejects(ctx.data.set(id, 'one-more', {}, 'me'), code('too_large'));
  await assert.rejects(ctx.data.update(id, 'one-more', {}, 'me'), code('too_large'));
  await ctx.data.set(id, 'fill2', { replaced: true }, 'me');
  await ctx.data.delete(id, 'fill3', 'me');
  await ctx.data.set(id, 'one-more', {}, 'me');
});

test('query: typed equality on top-level fields, orderBy and limit', async (t) => {
  const { data, publish } = setup(t);
  const id = await publish({ db: true });
  await data.set(id, 'a', { option: 'Pizza', n: 3, done: true, note: null }, 'me');
  await data.set(id, 'b', { option: 'Sushi', n: 1, done: false }, 'me');
  await data.set(id, 'c', { option: 'Pizza', n: 2, done: 1 }, 'me');
  await data.set(id, 'd', { option: '3', n: '3' }, 'me');
  const ids = async (query: Parameters<typeof data.query>[1]) =>
    (await data.query(id, query)).map((d) => d.id);

  assert.deepEqual(await ids({ where: { option: 'Pizza' } }), ['a', 'c']);
  assert.deepEqual(await ids({ where: { n: 3 } }), ['a']);
  assert.deepEqual(await ids({ where: { n: '3' } }), ['d']);
  assert.deepEqual(await ids({ where: { done: true } }), ['a']);
  assert.deepEqual(await ids({ where: { done: 1 } }), ['c']);
  assert.deepEqual(await ids({ where: { note: null } }), ['a']);
  assert.deepEqual(await ids({ where: { option: 'Pizza', n: 2 } }), ['c']);
  assert.deepEqual(await ids({ orderBy: 'n', order: 'desc', where: { option: 'Pizza' } }), [
    'a',
    'c',
  ]);
  assert.deepEqual(await ids({ order: 'desc', limit: 2 }), ['d', 'c']);
  assert.deepEqual(await ids({}), ['a', 'b', 'c', 'd']);

  for (const query of [
    { where: { 'a"b': 1 } },
    { where: { 'a.b': 1 } },
    { where: { x: { nested: 1 } } },
    { where: { x: [1] } },
    { orderBy: "n') --" },
    { order: 'sideways' },
    { limit: 0 },
    { where: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, i])) },
  ]) {
    await assert.rejects(
      data.query(id, query as never),
      code('invalid_input'),
      JSON.stringify(query),
    );
  }
});

test('changes: revisions for polling, deletes as data: null, reset past dropped tombstones', async (t) => {
  const { data, publish } = setup(t);
  const id = await publish({ db: true });
  const start = await data.changes(id, 0);
  assert.deepEqual(start, { items: [], rev: 0, more: false, reset: true });

  await data.set(id, 'a', { n: 1 }, 'me');
  await data.set(id, 'b', { n: 2 }, 'me');
  const first = await data.changes(id, 0);
  assert.equal(first.reset, true);
  assert.equal(first.rev, 2);

  await data.update(id, 'a', { n: 3 }, 'me');
  await data.delete(id, 'b', 'me');
  const next = await data.changes(id, first.rev);
  assert.equal(next.reset, false);
  assert.deepEqual(
    next.items.map((c) => [c.id, c.data]),
    [
      ['a', { n: 3 }],
      ['b', null],
    ],
  );
  assert.equal(next.rev, 4);
  assert.deepEqual((await data.changes(id, 4)).items, []);
  await assert.rejects(data.changes(id, 5), code('invalid_input'));
  await assert.rejects(data.changes(id, -1), code('invalid_input'));

  // More than a page of changes comes in pages.
  for (let i = 0; i < DATA_LIMITS.page + 5; i++) await data.set(id, `p${i}`, { i }, 'me');
  const page = await data.changes(id, 4);
  assert.equal(page.items.length, DATA_LIMITS.page);
  assert.equal(page.more, true);
  const tail = await data.changes(id, page.rev);
  assert.equal(tail.items.length, 5);
  assert.equal(tail.more, false);

  // Over 1,000 tombstones are dropped; a poller from before then must start over.
  const before = tail.rev;
  for (let i = 0; i < 999; i++) {
    await data.set(id, `t${i}`, {}, 'me');
    await data.delete(id, `t${i}`, 'me');
  }
  // 1,000 tombstones, with b's: not yet.
  assert.equal((await data.changes(id, before)).reset, false);
  await data.set(id, 'last', {}, 'me');
  await data.delete(id, 'last', 'me');
  const stale = await data.changes(id, before);
  assert.equal(stale.reset, true);
  assert.deepEqual(stale.items, []);
  const fresh = await data.changes(id, stale.rev);
  assert.equal(fresh.reset, false);
  assert.equal((await data.list(id)).items.length, DATA_LIMITS.page);
});

test("a deleted artifact's data can't be read or written; undelete brings it back", async (t) => {
  const { data, artifacts, publish } = setup(t);
  const id = await publish({ db: true });
  await data.set(id, 'a', { n: 1 }, 'me');
  await artifacts.delete(id);
  await assert.rejects(data.get(id, 'a'), code('not_found'));
  await assert.rejects(data.set(id, 'a', {}, 'me'), code('not_found'));
  await assert.rejects(data.list(id), code('not_found'));
  await assert.rejects(data.changes(id, 0), code('not_found'));
  await artifacts.undelete(id);
  assert.deepEqual((await data.get(id, 'a'))?.data, { n: 1 });
});

test('the purge takes the data of the artifacts it deletes', async (t) => {
  const ctx = setup(t);
  const gone = await ctx.publish({ db: true });
  const keep = await ctx.publish({ db: true });
  await ctx.data.set(gone, 'a', {}, 'me');
  await ctx.data.set(keep, 'a', {}, 'me');
  await ctx.artifacts.delete(gone);
  assert.equal((await ctx.purge(Date.now() + 31 * 86_400_000)).artifacts, 1);
  ctx.withDb((db) => {
    const rows = db.prepare('SELECT artifact_id FROM artifact_data').all();
    assert.deepEqual(
      rows.map((r) => r.artifact_id),
      [keep],
    );
  });
});

test('the live pages migration runs on an existing database', async (t) => {
  const ctx = setup(t);
  const id = await ctx.publish();
  ctx.withDb((db) => {
    db.exec(
      'DROP TABLE sessions; DROP TABLE oauth_tokens; DROP TABLE oauth_codes; DROP TABLE oauth_grants; DROP TABLE oauth_clients; ' +
        'DROP TABLE asks; DROP TABLE artifact_data; ALTER TABLE artifacts DROP COLUMN capabilities; ' +
        'ALTER TABLE artifacts DROP COLUMN data_rev; ALTER TABLE artifacts DROP COLUMN data_floor; ' +
        'ALTER TABLE versions DROP COLUMN lines_added; ALTER TABLE versions DROP COLUMN lines_removed; ' +
        'PRAGMA user_version = 4',
    );
  });
  assert.deepEqual((await ctx.artifacts.get(id))?.artifact.capabilities, {
    db: false,
    viewer: false,
  });
  await ctx.artifacts.publish({ id, capabilities: { db: true } }, 'a');
  await ctx.data.set(id, 'a', { ok: true }, 'me');
  assert.deepEqual((await ctx.data.get(id, 'a'))?.data, { ok: true });
});
