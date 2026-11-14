import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { AppError } from '../contracts.ts';
import { createCore } from './index.ts';

const OWNER = { name: 'owner@example.com', typed: true };
const AGENT = { name: 'claude-laptop', typed: false };

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-comments-'));
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
    proxySecret: null,
    authMode: 'proxy',
    authUsers: [],
  };
  let core = createCore(config);
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const publish = async (title = 'Doc') =>
    (await core.artifacts.publish({ title, content: '# Hi', format: 'markdown' }, 'agent')).id;
  return {
    get artifacts() {
      return core.artifacts;
    },
    get comments() {
      return core.comments;
    },
    purge: (now: number) => core.purge(now),
    publish,
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

const code = (c: AppError['code']) => (error: unknown) =>
  error instanceof AppError && error.code === c;

test('threads, replies, provenance and newest activity first', async (t) => {
  const { comments, publish, artifacts } = setup(t);
  const id = await publish();
  await artifacts.publish({ id, content: '# Hi again', format: 'markdown' }, 'agent');

  const note = await comments.add({ artifactId: id, body: '  Shorter, please  ' }, OWNER);
  assert.deepEqual(note.anchor, { kind: 'note' });
  assert.equal(note.version, 2);
  assert.equal(note.artifactId, id);
  assert.equal(note.resolvedAt, null);
  assert.deepEqual(
    note.comments.map((c) => [c.author, c.typed, c.body]),
    [['owner@example.com', true, 'Shorter, please']],
  );

  const quote = await comments.add(
    {
      artifactId: id,
      body: 'Typo',
      version: 1,
      anchor: { kind: 'text', exact: '  Hi\n\n  there ', prefix: 'a\tb', suffix: '' },
    },
    AGENT,
  );
  assert.deepEqual(quote.anchor, { kind: 'text', exact: 'Hi there', prefix: 'a b', suffix: '' });
  assert.equal(quote.version, 1);
  assert.equal(quote.comments[0]?.typed, false);

  // A reply bumps the older thread to the top. Times are in milliseconds.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const replied = await comments.add({ artifactId: id, threadId: note.id, body: 'On it' }, AGENT);
  assert.deepEqual(
    replied.comments.map((c) => [c.author, c.body]),
    [
      ['owner@example.com', 'Shorter, please'],
      ['claude-laptop', 'On it'],
    ],
  );
  const listed = await comments.list(id);
  assert.deepEqual(
    listed?.map((th) => th.id),
    [note.id, quote.id],
  );
  assert.equal(listed?.[0]?.comments.length, 2);
});

test('resolve, reopen, status filters and open counts', async (t) => {
  const { comments, publish } = setup(t);
  const a = await publish('A');
  const b = await publish('B');
  const first = await comments.add({ artifactId: a, body: 'one' }, OWNER);
  await comments.add({ artifactId: a, body: 'two' }, OWNER);
  await comments.add({ artifactId: b, body: 'three' }, OWNER);

  const done = await comments.resolve(first.id, true);
  assert.ok(done?.resolvedAt);
  // Resolving again keeps the first time.
  assert.equal((await comments.resolve(first.id, true))?.resolvedAt, done?.resolvedAt);
  assert.equal((await comments.list(a, 'open'))?.length, 1);
  assert.deepEqual(
    (await comments.list(a, 'resolved'))?.map((th) => th.id),
    [first.id],
  );
  assert.equal((await comments.list(a, 'all'))?.length, 2);
  assert.deepEqual(await comments.openCounts([a, b, 'nope']), { [a]: 1, [b]: 1 });
  assert.deepEqual(await comments.openCounts([]), {});

  assert.equal((await comments.resolve(first.id, false))?.resolvedAt, null);
  assert.deepEqual(await comments.openCounts([a]), { [a]: 2 });

  // Scoped to an artifact, a thread on another one is not found.
  assert.equal(await comments.resolve(first.id, true, b), null);
  assert.equal(await comments.resolve('nope', true), null);
  await assert.rejects(comments.list(a, 'closed' as 'open'), code('invalid_input'));
});

test('a body over 2,000 characters, or an empty one, is refused', async (t) => {
  const { comments, publish } = setup(t);
  const id = await publish();
  await assert.rejects(
    comments.add({ artifactId: id, body: 'x'.repeat(2001) }, OWNER),
    code('invalid_input'),
  );
  await assert.rejects(
    comments.add({ artifactId: id, body: ' \n ' }, OWNER),
    code('invalid_input'),
  );
  const max = await comments.add({ artifactId: id, body: ` ${'x'.repeat(2000)} ` }, OWNER);
  assert.equal(max.comments[0]?.body.length, 2000);
  assert.equal((await comments.list(id))?.length, 1);
});

test('bad anchors, versions and threads are refused', async (t) => {
  const { comments, publish } = setup(t);
  const id = await publish();
  const other = await publish('Other');
  const thread = await comments.add({ artifactId: id, body: 'x' }, OWNER);
  const refuse = (input: Parameters<typeof comments.add>[0], c: AppError['code']) =>
    assert.rejects(comments.add(input, OWNER), code(c));

  await refuse(
    { artifactId: id, body: 'x', anchor: { kind: 'text', exact: 'Hi', prefix: 'p'.repeat(33) } },
    'invalid_input',
  );
  await refuse(
    { artifactId: id, body: 'x', anchor: { kind: 'text', exact: ' ' } },
    'invalid_input',
  );
  await refuse(
    { artifactId: id, body: 'x', anchor: { kind: 'text', exact: 'x'.repeat(2001) } },
    'invalid_input',
  );
  await refuse({ artifactId: id, body: 'x', anchor: { kind: 'box' } as never }, 'invalid_input');
  await refuse({ artifactId: id, body: 'x', version: 2 }, 'not_found');
  await refuse({ artifactId: id, body: 'x', threadId: thread.id, version: 1 }, 'invalid_input');
  await refuse(
    { artifactId: id, body: 'x', threadId: thread.id, anchor: { kind: 'note' } },
    'invalid_input',
  );
  await refuse({ artifactId: other, body: 'x', threadId: thread.id }, 'not_found');
  await refuse({ artifactId: 'nope', body: 'x' }, 'not_found');
  assert.equal(await comments.list('nope'), null);
  assert.equal((await comments.list(id))?.[0]?.comments.length, 1);
});

test("a deleted artifact's comments are hidden, and come back with it", async (t) => {
  const ctx = setup(t);
  const id = await ctx.publish();
  const thread = await ctx.comments.add({ artifactId: id, body: 'x' }, OWNER);
  await ctx.artifacts.delete(id);

  assert.equal(await ctx.comments.list(id, 'all'), null);
  assert.deepEqual(await ctx.comments.openCounts([id]), {});
  assert.equal(await ctx.comments.resolve(thread.id, true), null);
  await assert.rejects(ctx.comments.add({ artifactId: id, body: 'y' }, OWNER), code('not_found'));
  await assert.rejects(
    ctx.comments.add({ artifactId: id, threadId: thread.id, body: 'y' }, OWNER),
    code('not_found'),
  );

  // As an undelete would.
  ctx.withDb((db) => db.prepare('UPDATE artifacts SET deleted_at = NULL WHERE id = ?').run(id));
  assert.deepEqual(
    (await ctx.comments.list(id))?.map((th) => th.comments.length),
    [1],
  );
});

test('the purge removes the threads and comments of the artifacts it deletes', async (t) => {
  const ctx = setup(t);
  const id = await ctx.publish();
  const keep = await ctx.publish('Keep');
  const thread = await ctx.comments.add({ artifactId: id, body: 'x' }, OWNER);
  await ctx.comments.add({ artifactId: id, threadId: thread.id, body: 'y' }, AGENT);
  await ctx.comments.add({ artifactId: keep, body: 'z' }, OWNER);
  await ctx.artifacts.delete(id);
  assert.equal((await ctx.purge(Date.now() + 31 * 86_400_000)).artifacts, 1);

  ctx.withDb((db) => {
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert.equal(count('threads'), 1);
    assert.equal(count('comments'), 1);
  });
  assert.equal((await ctx.comments.list(keep))?.length, 1);
});

test('the comments migration runs on an existing database', async (t) => {
  const ctx = setup(t);
  const id = await ctx.publish();
  // Back to the schema before comments, with an artifact in it.
  ctx.withDb((db) => {
    db.exec(
      'DROP TABLE sessions; DROP TABLE oauth_tokens; DROP TABLE oauth_codes; DROP TABLE oauth_grants; DROP TABLE oauth_clients; ' +
        'DROP TABLE asks; DROP TABLE comments; DROP TABLE threads; ' +
        'DROP TABLE artifact_data; ALTER TABLE artifacts DROP COLUMN capabilities; ALTER TABLE artifacts DROP COLUMN data_rev; ALTER TABLE artifacts DROP COLUMN data_floor; ' +
        'ALTER TABLE versions DROP COLUMN lines_added; ALTER TABLE versions DROP COLUMN lines_removed; PRAGMA user_version = 3',
    );
  });
  const thread = await ctx.comments.add({ artifactId: id, body: 'after the upgrade' }, OWNER);
  assert.equal(thread.version, 1);
  assert.equal((await ctx.comments.list(id))?.length, 1);
});
