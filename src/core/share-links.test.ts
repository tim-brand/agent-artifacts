import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { AppError } from '../contracts.ts';
import { createCore } from './index.ts';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-'));
  const config: Config = {
    port: 0,
    dataDir: join(dir, 'data'),
    appOrigin: 'https://app.example',
    contentOrigin: 'https://content.example',
    signingSecret: 'x'.repeat(32),
    devUser: null,
  };
  let core = createCore(config);
  // A second connection, to look at rows directly and to rewind the schema.
  const db = new DatabaseSync(join(config.dataDir, 'artifacts.db'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  t.after(() => {
    db.close();
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const reopen = () => {
    core.close();
    core = createCore(config);
    return core;
  };
  const publish = async (id?: string) =>
    (await core.artifacts.publish({ id, title: 'Doc', content: `# v`, format: 'markdown' }, 'a'))
      .id;
  return { core: () => core, db, config, reopen, publish };
}

const code = (c: AppError['code']) => (error: unknown) =>
  error instanceof AppError && error.code === c;

test('a link is stored hashed and resolves until it is revoked', async (t) => {
  const { core, db, config, publish } = setup(t);
  const { shareLinks } = core();
  const id = await publish();
  const { token, link } = await shareLinks.create(id, { label: ' family ' });
  assert.match(token, /^sl_[A-Za-z0-9_-]{43}$/);
  assert.equal(link.label, 'family');
  assert.equal(link.version, null);
  assert.equal(link.expiresAt, null);

  const row = db.prepare('SELECT token_hash FROM share_links').get() as { token_hash: string };
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  db.exec('PRAGMA wal_checkpoint(FULL)');
  const file = readFileSync(join(config.dataDir, 'artifacts.db'));
  assert.equal(file.includes(token), false);
  assert.equal(file.includes(token.slice(3)), false);

  const resolved = await shareLinks.resolve(token);
  assert.equal(resolved?.link.id, link.id);
  assert.equal(resolved?.version, 1);
  assert.ok(resolved?.link.lastUsedAt);
  assert.equal((await shareLinks.list(id))?.[0]?.lastUsedAt, resolved?.link.lastUsedAt);

  for (const bad of [`${token}x`, token.slice(0, -1), 'sl_nope', '', token.replace('sl_', 'aa_')]) {
    assert.equal(await shareLinks.resolve(bad), null, bad);
  }

  assert.equal(await shareLinks.revoke('other', link.id), false);
  assert.equal(await shareLinks.revoke(id, link.id), true);
  assert.equal(await shareLinks.revoke(id, link.id), false);
  assert.equal(await shareLinks.resolve(token), null);
  assert.deepEqual(await shareLinks.list(id), []);
});

test('a latest link follows new versions; a pinned link stays on its version', async (t) => {
  const { core, publish } = setup(t);
  const { shareLinks } = core();
  const id = await publish();
  const latest = await shareLinks.create(id);
  const pinned = await shareLinks.create(id, { version: 1 });
  assert.equal(pinned.link.version, 1);

  await publish(id);
  assert.equal((await shareLinks.resolve(latest.token))?.version, 2);
  assert.equal((await shareLinks.resolve(pinned.token))?.version, 1);

  const pinned2 = await shareLinks.create(id, { version: 2 });
  await publish(id);
  assert.equal((await shareLinks.resolve(latest.token))?.version, 3);
  assert.equal((await shareLinks.resolve(pinned2.token))?.version, 2);

  assert.deepEqual(
    (await shareLinks.list(id))?.map((l) => l.id),
    [pinned2.link.id, pinned.link.id, latest.link.id],
  );
});

test('an expired link no longer resolves but is still listed', async (t) => {
  const { core, publish } = setup(t);
  const { shareLinks } = core();
  const id = await publish();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const { token, link } = await shareLinks.create(id, { expiresAt });
  assert.equal(link.expiresAt, expiresAt);
  assert.ok(await shareLinks.resolve(token));

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_001 });
  assert.equal(await shareLinks.resolve(token), null);
  assert.equal((await shareLinks.list(id))?.length, 1);
});

test('deleting an artifact stops its links; undeleting brings them back', async (t) => {
  const { core, publish } = setup(t);
  const { artifacts, shareLinks } = core();
  const id = await publish();
  const other = await publish();
  const { token } = await shareLinks.create(id);
  await shareLinks.create(other);

  assert.equal(await artifacts.delete(id), true);
  assert.equal(await shareLinks.resolve(token), null);
  assert.equal(await shareLinks.list(id), null);
  assert.deepEqual(
    (await shareLinks.list())?.map((l) => l.artifactId),
    [other],
  );
  await assert.rejects(shareLinks.create(id), code('not_found'));

  assert.equal(await artifacts.undelete(id), true);
  assert.equal((await shareLinks.resolve(token))?.version, 1);
  assert.equal((await shareLinks.list())?.length, 2);
});

test('purging an artifact removes its links, and only its links', async (t) => {
  const { core, db, publish } = setup(t);
  const { artifacts, shareLinks, purge } = core();
  const id = await publish();
  const kept = await publish();
  await shareLinks.create(id);
  await shareLinks.create(id, { version: 1 });
  const { token } = await shareLinks.create(kept);
  await artifacts.delete(id);

  // The purge's own connection must enforce foreign keys, or the cascade silently does nothing.
  assert.deepEqual(await purge(Date.now() + 31 * 86_400_000), { artifacts: 1, blobs: 0 });
  const rows = db.prepare('SELECT artifact_id FROM share_links').all() as { artifact_id: string }[];
  assert.deepEqual(
    rows.map((r) => r.artifact_id),
    [kept],
  );
  assert.equal((await shareLinks.resolve(token))?.version, 1);
  assert.equal(await artifacts.undelete(id), false);
});

test('create refuses unknown artifacts and versions, long labels and past expiry', async (t) => {
  const { core, publish } = setup(t);
  const { shareLinks } = core();
  const id = await publish();
  await assert.rejects(shareLinks.create('missing'), code('not_found'));
  await assert.rejects(shareLinks.create(id, { version: 2 }), code('not_found'));
  await assert.rejects(shareLinks.create(id, { label: 'x'.repeat(101) }), code('invalid_input'));
  for (const expiresAt of ['soon', new Date(Date.now() - 1000).toISOString()]) {
    await assert.rejects(shareLinks.create(id, { expiresAt }), code('invalid_input'));
  }
  assert.deepEqual(await shareLinks.list(id), []);
});

test('the migration adds the table to an existing database', async (t) => {
  const { db, publish, reopen } = setup(t);
  const id = await publish();
  // Later steps run again too, so their tables go as well.
  db.exec(
    'DROP TABLE share_links; DROP TABLE asks; DROP TABLE comments; DROP TABLE threads; ' +
      'DROP TABLE artifact_data; ALTER TABLE artifacts DROP COLUMN capabilities; ALTER TABLE artifacts DROP COLUMN data_rev; ALTER TABLE artifacts DROP COLUMN data_floor; PRAGMA user_version = 2;',
  );
  const { shareLinks } = reopen();
  const { token } = await shareLinks.create(id);
  assert.equal((await shareLinks.resolve(token))?.version, 1);
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(user_version, 6);
});
