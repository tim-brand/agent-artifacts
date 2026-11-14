import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { AppError } from '../contracts.ts';
import { createBlobStore } from './blobs.ts';
import { createCore } from './index.ts';
import { schedulePurge } from './purge.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function setup(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-artifacts-'));
  const config: Config = {
    port: 0,
    trustedProxies: 1,
    dataDir: join(dataDir, 'data'),
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
    rmSync(dataDir, { recursive: true, force: true });
  });
  const blobsDir = join(config.dataDir, 'blobs');
  const blobNames = () =>
    readdirSync(blobsDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  return { ...core, config, blobsDir, blobNames };
}

const failsWith = (c: AppError['code'], details?: Record<string, unknown>) => (error: unknown) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, c, error.message);
  if (details) assert.deepEqual(error.details, details);
  return true;
};

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

test('edits change the entry file and reuse the other files', async (t) => {
  const { artifacts, blobNames } = setup(t);
  const { id } = await artifacts.publish(
    {
      title: 'Site',
      files: { 'index.html': '<h1>Hello</h1><p>one</p>', 'style.css': 'h1{}' },
      entry: 'index.html',
    },
    'agent',
  );
  assert.equal(blobNames().length, 2);

  const result = await artifacts.publish(
    {
      id,
      title: 'Site 2',
      edits: [
        { old: 'Hello', new: 'Hi $& $1' },
        { old: 'one', new: 'two' },
      ],
      expectedVersion: 1,
    },
    'editor',
  );
  assert.equal(result.version, 2);
  assert.equal(result.title, 'Site 2');

  const v2 = await artifacts.get(id);
  assert.equal(v2?.version.publishedBy, 'editor');
  assert.equal(v2?.version.entry, 'index.html');
  assert.equal(v2?.version.format, 'html');
  const entry = await artifacts.readFile(id, 2, 'index.html');
  assert.equal(text(entry?.bytes), '<h1>Hi $& $1</h1><p>two</p>');
  assert.equal(entry?.contentType, 'text/html; charset=utf-8');
  assert.equal(v2?.version.files.find((f) => f.path === 'index.html')?.size, 27);

  const v1 = await artifacts.get(id, 1);
  const css = (v: typeof v1) => v?.version.files.find((f) => f.path === 'style.css')?.sha256;
  assert.equal(css(v2), css(v1));
  assert.equal(blobNames().length, 3);
  assert.equal(
    text((await artifacts.readFile(id, 1, 'index.html'))?.bytes),
    '<h1>Hello</h1><p>one</p>',
  );
});

test('edits apply to the latest version, in order', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish({ title: 'N', content: 'a b c', format: 'markdown' }, 'a');
  await artifacts.publish({ id, content: 'x y z', format: 'markdown' }, 'a');
  await artifacts.publish(
    {
      id,
      edits: [
        { old: 'y', new: 'b' },
        { old: 'x b', new: 'q' },
      ],
    },
    'a',
  );
  assert.equal(text((await artifacts.readFile(id, 3, 'README.md'))?.bytes), 'q z');
});

test('a failing edit publishes nothing', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish(
    { title: 'C', content: 'let a = 1;\nlet a = 1;\nlet b = 2;', format: 'code', language: 'ts' },
    'a',
  );
  await assert.rejects(
    artifacts.publish(
      {
        id,
        edits: [
          { old: 'b', new: 'c' },
          { old: 'let a = 1;', new: '' },
        ],
      },
      'a',
    ),
    failsWith('edit_failed', { index: 1, occurrences: 2 }),
  );
  await assert.rejects(
    artifacts.publish({ id, edits: [{ old: 'missing', new: '' }] }, 'a'),
    failsWith('edit_failed', { index: 0, occurrences: 0 }),
  );
  // Overlapping matches count: "aa" occurs twice in "aaa".
  const { id: id2 } = await artifacts.publish({ title: 'O', content: 'aaa', format: 'code' }, 'a');
  await assert.rejects(
    artifacts.publish({ id: id2, edits: [{ old: 'aa', new: 'b' }] }, 'a'),
    failsWith('edit_failed', { index: 0, occurrences: 2 }),
  );
  assert.equal((await artifacts.get(id))?.artifact.latestVersion, 1);
  assert.equal((await artifacts.listVersions(id))?.length, 1);
});

test('edits reject bad input, other formats and a stale expectedVersion', async (t) => {
  const { artifacts } = setup(t);
  const pdf = Buffer.from('%PDF-1.7\n').toString('base64');
  const { id: pdfId } = await artifacts.publish({ title: 'P', content: pdf, format: 'pdf' }, 'a');
  await assert.rejects(
    artifacts.publish({ id: pdfId, edits: [{ old: 'PDF', new: 'X' }] }, 'a'),
    failsWith('invalid_input'),
  );

  const { id } = await artifacts.publish({ title: 'M', content: 'one', format: 'markdown' }, 'a');
  const bad = [
    { edits: [{ old: 'one', new: 'two' }] },
    { id, edits: [] },
    { id, edits: [{ old: '', new: 'x' }] },
    { id, edits: [{ old: 'one' }] },
    { id, edits: [{ old: 'one', new: 'two' }], content: 'x', format: 'markdown' as const },
    { id, edits: [{ old: 'one', new: 'two' }], files: { 'a.md': 'x' } },
  ];
  for (const input of bad) {
    await assert.rejects(
      artifacts.publish(input as Parameters<typeof artifacts.publish>[0], 'a'),
      failsWith('invalid_input'),
      JSON.stringify(input),
    );
  }
  await assert.rejects(
    artifacts.publish({ id: 'nope', edits: [{ old: 'one', new: 'two' }] }, 'a'),
    failsWith('not_found'),
  );

  await artifacts.publish({ id, content: 'one more', format: 'markdown' }, 'a');
  await assert.rejects(
    artifacts.publish({ id, edits: [{ old: 'one', new: 'two' }], expectedVersion: 1 }, 'a'),
    failsWith('version_conflict', { currentVersion: 2 }),
  );
  assert.equal((await artifacts.get(id))?.artifact.latestVersion, 2);
});

test('restoreVersion copies an old version as the new latest without new blobs', async (t) => {
  const { artifacts, blobNames } = setup(t);
  const { id } = await artifacts.publish(
    { title: 'R', files: { 'index.html': 'v1', 'a.css': 'a{}' }, entry: 'index.html' },
    'agent',
  );
  await artifacts.publish({ id, content: '# v2', format: 'markdown' }, 'agent');
  const blobs = blobNames();

  const result = await artifacts.restoreVersion(id, 1, 'owner@example.com');
  assert.deepEqual(result, { id, version: 3, title: 'R', url: `https://app.example/a/${id}` });
  assert.deepEqual(blobNames(), blobs);

  const [v3, v1] = [await artifacts.get(id), await artifacts.get(id, 1)];
  assert.equal(v3?.artifact.format, 'html');
  assert.equal(v3?.artifact.latestVersion, 3);
  assert.equal(v3?.version.publishedBy, 'owner@example.com (restored v1)');
  assert.equal(v3?.version.entry, 'index.html');
  assert.deepEqual(v3?.version.files, v1?.version.files);
  assert.equal(text((await artifacts.readFile(id, 3, 'a.css'))?.bytes), 'a{}');

  await assert.rejects(artifacts.restoreVersion(id, 9, 'x'), failsWith('not_found'));
  await assert.rejects(artifacts.restoreVersion('nope', 1, 'x'), failsWith('not_found'));
  await artifacts.delete(id);
  await assert.rejects(artifacts.restoreVersion(id, 1, 'x'), failsWith('not_found'));
});

test('undelete brings an artifact back from the trash', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish({ title: 'T', content: 'x', format: 'markdown' }, 'a');
  const { id: other } = await artifacts.publish({ title: 'U', content: 'y', format: 'html' }, 'a');
  assert.deepEqual(await artifacts.listDeleted(), []);
  assert.equal(await artifacts.undelete(id), false);

  await artifacts.delete(id);
  await artifacts.delete(other);
  const trash = await artifacts.listDeleted();
  assert.deepEqual(trash.map((a) => a.id).sort(), [id, other].sort());
  assert.ok(trash.every((a) => Date.parse(a.deletedAt) > 0));

  assert.equal(await artifacts.undelete(id), true);
  assert.equal(await artifacts.undelete(id), false);
  assert.equal(await artifacts.undelete('nope'), false);
  assert.equal((await artifacts.get(id))?.artifact.title, 'T');
  assert.equal(text((await artifacts.readFile(id, 1, 'README.md'))?.bytes), 'x');
  assert.deepEqual(
    (await artifacts.listDeleted()).map((a) => a.id),
    [other],
  );
});

test('purge removes artifacts deleted over 30 days ago and their unused blobs', async (t) => {
  const { artifacts, purge, blobNames } = setup(t);
  const shared = 'body{}';
  const { id: old } = await artifacts.publish(
    { title: 'Old', files: { 'index.html': 'old', 'site.css': shared }, entry: 'index.html' },
    'a',
  );
  await artifacts.publish({ id: old, content: 'old v2', format: 'markdown' }, 'a');
  const { id: kept } = await artifacts.publish(
    { title: 'Kept', files: { 'index.html': 'kept', 'site.css': shared }, entry: 'index.html' },
    'a',
  );
  const { id: trashed } = await artifacts.publish(
    { title: 'Recent', content: 'recent', format: 'markdown' },
    'a',
  );
  await artifacts.delete(old);
  await artifacts.delete(trashed);
  assert.equal(blobNames().length, 5);

  // Nothing is old enough yet.
  assert.deepEqual(await purge(Date.now() + 29 * DAY), { artifacts: 0, blobs: 0 });
  assert.equal(await artifacts.undelete(old), true);
  await artifacts.delete(old);

  // A month later, both trashed artifacts are past 30 days; the kept one and the shared css stay.
  assert.deepEqual(await purge(Date.now() + 31 * DAY), { artifacts: 2, blobs: 3 });
  assert.deepEqual(await artifacts.listDeleted(), []);
  assert.equal(await artifacts.undelete(old), false);
  assert.equal(blobNames().length, 2);
  assert.equal(text((await artifacts.readFile(kept, 1, 'site.css'))?.bytes), shared);
  assert.equal(text((await artifacts.readFile(kept, 1, 'index.html'))?.bytes), 'kept');
  assert.equal((await artifacts.list()).items.length, 1);
});

test('blob GC skips unreferenced blobs younger than an hour', async (t) => {
  const { purge, blobsDir, blobNames, artifacts } = setup(t);
  assert.deepEqual(await purge(), { artifacts: 0, blobs: 0 }); // no blobs/ dir yet

  await artifacts.publish({ title: 'A', content: 'kept', format: 'code' }, 'a');
  // Orphans, as left behind by a publish that failed after writing its blobs, or a crash mid-write.
  mkdirSync(join(blobsDir, 'ab'), { recursive: true });
  writeFileSync(join(blobsDir, 'ab', 'ab01'), 'x');
  writeFileSync(join(blobsDir, 'ab', 'ab02.1234.tmp'), 'x');
  assert.equal(blobNames().length, 3);

  assert.deepEqual(await purge(Date.now() + 59 * 60 * 1000), { artifacts: 0, blobs: 0 });
  assert.deepEqual(await purge(Date.now() + 2 * HOUR), { artifacts: 0, blobs: 2 });
  assert.equal(blobNames().length, 1);
});

test('storing a blob that already exists refreshes its mtime, so GC keeps it', async (t) => {
  const { blobsDir } = setup(t);
  const blobs = createBlobStore(blobsDir);
  const bytes = new TextEncoder().encode('same');
  const old = new Date(Date.now() - DAY);
  for (const put of [(b: Uint8Array) => blobs.put(b), (b: Uint8Array) => blobs.putSync(b)]) {
    const sha = await put(bytes);
    const path = join(blobsDir, sha.slice(0, 2), sha);
    utimesSync(path, old, old);
    assert.equal(await put(bytes), sha);
    assert.ok(statSync(path).mtimeMs > Date.now() - HOUR);
    assert.equal(text(blobs.readSync(sha)), 'same');
  }
});

test('schedulePurge runs at once and then every interval', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let runs = 0;
  const logs: string[] = [];
  const stop = schedulePurge(
    async () => {
      runs++;
      if (runs === 2) throw new Error('disk full');
      return { artifacts: runs === 3 ? 1 : 0, blobs: 0 };
    },
    HOUR,
    (message) => logs.push(message),
  );
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  assert.equal(runs, 1);
  t.mock.timers.tick(HOUR - 1);
  assert.equal(runs, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(runs, 2);
  t.mock.timers.tick(HOUR);
  await settle();
  assert.equal(runs, 3);
  assert.deepEqual(logs, ['purge failed', 'purged 1 artifacts and 0 blobs']);
  stop();
  t.mock.timers.tick(HOUR * 5);
  assert.equal(runs, 3);
});

const found = async (artifacts: ReturnType<typeof setup>['artifacts'], query: string) =>
  (await artifacts.search({ query })).items.map((hit) => hit.artifact.id);

test('search follows edits', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish(
    { title: 'Notes', content: '<p>The walrus sleeps</p>', format: 'html' },
    'a',
  );
  assert.deepEqual(await found(artifacts, 'walrus'), [id]);
  await artifacts.publish({ id, edits: [{ old: 'walrus', new: 'narwhal' }] }, 'a');
  assert.deepEqual(await found(artifacts, 'walrus'), []);
  assert.deepEqual(await found(artifacts, 'narwhal'), [id]);
  await assert.rejects(
    artifacts.publish({ id, edits: [{ old: 'missing', new: 'kraken' }] }, 'a'),
    failsWith('edit_failed'),
  );
  assert.deepEqual(await found(artifacts, 'kraken'), []);
});

test('search finds the text of a restored version', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish(
    { title: 'Plan', content: 'alpha plan', format: 'markdown' },
    'a',
  );
  await artifacts.publish({ id, content: 'beta plan', format: 'markdown' }, 'a');
  assert.deepEqual(await found(artifacts, 'alpha'), []);
  await artifacts.restoreVersion(id, 1, 'owner');
  assert.deepEqual(await found(artifacts, 'alpha'), [id]);
  assert.deepEqual(await found(artifacts, 'beta'), []);
});

test('an undeleted artifact is searchable again, a purged one leaves no search row', async (t) => {
  const { artifacts, purge, config } = setup(t);
  const { id } = await artifacts.publish(
    { title: 'Zebra', content: 'stripes', format: 'markdown' },
    'a',
  );
  await artifacts.delete(id);
  assert.deepEqual(await found(artifacts, 'stripes'), []);
  assert.equal(await artifacts.undelete(id), true);
  assert.deepEqual(await found(artifacts, 'zebra stripes'), [id]);

  await artifacts.delete(id);
  // A second connection, to look at the index and to plant a stale row a bug could leave behind.
  const db = new DatabaseSync(join(config.dataDir, 'artifacts.db'));
  t.after(() => db.close());
  const rows = () =>
    (db.prepare('SELECT count(*) AS n FROM artifacts_fts').get() as { n: number }).n;
  assert.equal(rows(), 0);
  db.prepare(
    "INSERT INTO artifacts_fts (artifact_id, title, description, body) VALUES (?, 'Zebra', '', '')",
  ).run(id);
  assert.deepEqual(await purge(Date.now() + 31 * DAY), { artifacts: 1, blobs: 1 });
  assert.equal(rows(), 0);
});

test('image artifacts, even SVG, cannot be edited', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish(
    {
      title: 'Chart',
      content: '<svg xmlns="http://www.w3.org/2000/svg"><title>Q3</title></svg>',
      format: 'image',
      language: 'svg',
    },
    'a',
  );
  assert.equal((await artifacts.get(id))?.artifact.format, 'image');
  await assert.rejects(
    artifacts.publish({ id, edits: [{ old: 'Q3', new: 'Q4' }] }, 'a'),
    failsWith('invalid_input'),
  );
  assert.equal((await artifacts.get(id))?.artifact.latestVersion, 1);
});
