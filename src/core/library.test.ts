import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { AppError, type LibraryQuery } from '../contracts.ts';
import { createCore } from './index.ts';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-library-'));
  const config: Config = {
    port: 0,
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
  const core = createCore(config);
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return core;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

/** Five artifacts, oldest first: notes, poll, script, Banana, chart. */
async function seed(t: TestContext) {
  const core = setup(t);
  const { artifacts, comments, shareLinks } = core;
  const publish = async (input: Parameters<typeof artifacts.publish>[0], by: string) => {
    const result = await artifacts.publish(input, by);
    await tick();
    return result.id;
  };
  const notes = await publish({ title: 'notes', content: '# hi', format: 'markdown' }, 'Claude');
  const poll = await publish(
    { title: 'poll', content: '<p>x</p>', format: 'html', capabilities: { db: true } },
    'OpenCode',
  );
  const script = await publish(
    { title: 'script', content: 'print(1)', format: 'code', language: 'python' },
    'Claude',
  );
  const banana = await publish({ title: 'Banana', content: '<p>b</p>', format: 'html' }, 'Claude');
  const chart = await publish(
    { title: 'chart', files: { 'a.html': '<p>1</p>', 'b.css': 'p{}' }, entry: 'a.html' },
    'OpenCode',
  );
  return { ...core, ids: { notes, poll, script, banana, chart }, comments, shareLinks };
}

const titles = async (core: ReturnType<typeof setup>, query: LibraryQuery = {}) =>
  (await core.artifacts.browse(query)).items.map((item) => item.artifact.title);

test('browse lists the latest entry, publisher, public links and open comments', async (t) => {
  const core = await seed(t);
  const { ids } = core;
  await core.comments.add({ artifactId: ids.notes, body: 'a' }, { name: 'me', typed: true });
  const done = await core.comments.add(
    { artifactId: ids.notes, body: 'b' },
    { name: 'me', typed: true },
  );
  await core.comments.resolve(done.id, true);
  await core.shareLinks.create(ids.notes);

  const page = await core.artifacts.browse();
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    page.items.map((item) => item.artifact.title),
    ['chart', 'Banana', 'script', 'poll', 'notes'],
  );
  const notes = page.items.find((item) => item.artifact.id === ids.notes);
  assert.deepEqual(
    { entry: notes?.entry, agent: notes?.agent, links: notes?.publicLinks },
    { entry: 'README.md', agent: 'Claude', links: 1 },
  );
  assert.equal(notes?.openComments, 1);
  assert.equal(page.items[0]?.entry, 'a.html');
  assert.equal(page.items[0]?.openComments, 0);
});

test('browse filters by format, agent, live, shared and open comments', async (t) => {
  const core = await seed(t);
  const { ids } = core;
  assert.deepEqual(await titles(core, { format: 'html' }), ['chart', 'Banana', 'poll']);
  assert.deepEqual(await titles(core, { agent: 'OpenCode' }), ['chart', 'poll']);
  assert.deepEqual(await titles(core, { agent: 'Claude', format: 'html' }), ['Banana']);
  assert.deepEqual(await titles(core, { agent: 'nobody' }), []);
  assert.deepEqual(await titles(core, { live: true }), ['poll']);

  await core.comments.add({ artifactId: ids.script, body: 'x' }, { name: 'a', typed: false });
  assert.deepEqual(await titles(core, { openComments: true }), ['script']);

  // Revoked and expired links don't count; a link that still works does.
  const revoked = await core.shareLinks.create(ids.banana);
  await core.shareLinks.revoke(ids.banana, revoked.link.id);
  await core.shareLinks.create(ids.chart, { expiresAt: new Date(Date.now() + 300).toISOString() });
  await core.shareLinks.create(ids.notes, { version: 1 });
  assert.deepEqual(await titles(core, { shared: true }), ['chart', 'notes']);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(await titles(core, { shared: true }), ['notes']);

  assert.equal(await core.artifacts.count(), 5);
  assert.equal(await core.artifacts.count({ format: 'html' }), 3);
  assert.equal(await core.artifacts.count({ live: true, agent: 'Claude' }), 0);
  assert.equal(await core.artifacts.count({ shared: true }), 1);
  assert.equal(await core.artifacts.count({ openComments: true, format: 'code' }), 1);
});

test('browse sorts by title and pages with a cursor for that sort', async (t) => {
  const core = await seed(t);
  assert.deepEqual(await titles(core, { sort: 'title' }), [
    'Banana',
    'chart',
    'notes',
    'poll',
    'script',
  ]);

  for (const sort of ['title', 'updated'] as const) {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await core.artifacts.browse({ sort, limit: 2, cursor });
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map((item) => item.artifact.title));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, await titles(core, { sort }));
  }

  const first = await core.artifacts.browse({ sort: 'title', limit: 2 });
  const isInvalid = (error: unknown) => error instanceof AppError && error.code === 'invalid_input';
  // A cursor of one sort is refused by the other.
  await assert.rejects(core.artifacts.browse({ cursor: first.nextCursor ?? '' }), isInvalid);
  await assert.rejects(core.artifacts.browse({ cursor: 'garbage' }), isInvalid);
});

test('the agent is the latest version publisher, without the restore suffix', async (t) => {
  const core = await seed(t);
  const { ids } = core;
  await core.artifacts.publish({ id: ids.notes, content: '# v2', format: 'markdown' }, 'OpenCode');
  assert.deepEqual(await titles(core, { agent: 'OpenCode' }), ['notes', 'chart', 'poll']);
  await tick();
  await core.artifacts.restoreVersion(ids.notes, 1, 'owner@example.com');
  const notes = (await core.artifacts.browse({ agent: 'owner@example.com' })).items;
  assert.deepEqual(
    notes.map((item) => [item.artifact.title, item.agent]),
    [['notes', 'owner@example.com']],
  );
  // A settings-only publish makes no version, so the publisher stays.
  await core.artifacts.publish({ id: ids.notes, title: 'Notes' }, 'Claude');
  assert.equal((await core.artifacts.browse({ agent: 'Claude' })).items.length, 2);
});

test('summary counts the library, the trash and the agents', async (t) => {
  const core = await seed(t);
  await core.artifacts.delete(core.ids.script);
  assert.deepEqual(await core.artifacts.summary(), {
    total: 4,
    trash: 1,
    agents: [
      { name: 'OpenCode', count: 2 },
      { name: 'Claude', count: 2 },
    ].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    openAsks: 0,
  });
  assert.deepEqual(await titles(core, { agent: 'Claude' }), ['Banana', 'notes']);
});
