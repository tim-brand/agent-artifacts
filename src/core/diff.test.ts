import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { COMPARE_LIMITS } from '../contracts.ts';
import { lineCounts } from './diff.ts';
import { createCore } from './index.ts';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-diff-'));
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
  return {
    get artifacts() {
      return core.artifacts;
    },
    config,
    reopen(whileClosed: () => void) {
      core.close();
      whileClosed();
      core = createCore(config);
    },
  };
}

const lines = (n: number, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const PDF = Buffer.from('%PDF-1.7 hello').toString('base64');

test('line counts against nothing, a previous version, and only for text entries', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish(
    { title: 'Notes', content: lines(5).join('\n'), format: 'markdown' },
    'a',
  );
  const next = [...lines(5)];
  next[1] = 'changed';
  next.push('one more', 'and another');
  await artifacts.publish({ id, content: next.join('\n'), format: 'markdown' }, 'a');
  await artifacts.publish({ id, title: 'Renamed' }, 'a'); // settings only: no version
  await artifacts.publish({ id, edits: [{ old: 'changed', new: 'edited\nsplit' }] }, 'a');
  await artifacts.publish({ id, content: PDF, format: 'pdf' }, 'a');
  await artifacts.publish({ id, content: 'x\ny', format: 'code', language: 'ts' }, 'a');
  await artifacts.restoreVersion(id, 1, 'owner');

  const counts = (await artifacts.listVersions(id))
    ?.reverse()
    .map((v) => [v.version, v.linesAdded, v.linesRemoved]);
  assert.deepEqual(counts, [
    [1, 5, 0],
    [2, 4, 2], // line 2 changed, and line 5 gained a newline before the two new ones
    [3, 2, 1], // the edit
    [4, null, null], // a PDF
    [5, 2, 0], // after a PDF: against nothing
    [6, 5, 2], // the restore of v1, against v5
  ]);
});

test('an SVG image gets counts, other images none', async (t) => {
  const { artifacts } = setup(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg">\n<rect/>\n</svg>\n';
  const { id } = await artifacts.publish(
    { title: 'Chart', content: svg, format: 'image', entry: 'chart.svg' },
    'a',
  );
  await artifacts.publish(
    { id, content: svg.replace('<rect/>', '<circle/>'), format: 'image', entry: 'chart.svg' },
    'a',
  );
  await artifacts.publish({ id, content: PNG, format: 'image', language: 'png' }, 'a');
  const counts = (await artifacts.listVersions(id))?.map((v) => [v.linesAdded, v.linesRemoved]);
  assert.deepEqual(counts, [
    [null, null],
    [1, 1],
    [3, 0],
  ]);
});

test('compares the entry file as a unified diff with context', async (t) => {
  const { artifacts } = setup(t);
  const before = lines(20);
  const { id } = await artifacts.publish(
    { title: 'Code', content: `${before.join('\n')}\n`, format: 'code', language: 'ts' },
    'a',
  );
  const after = [...before];
  after[2] = 'third, changed';
  after.splice(15, 1);
  await artifacts.publish(
    { id, content: `${after.join('\n')}\n`, format: 'code', language: 'ts' },
    'a',
  );

  const result = await artifacts.compare(id, 1, 2);
  assert.ok(result);
  assert.equal(result.from.version, 1);
  assert.equal(result.to.version, 2);
  assert.equal(result.unchanged, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual([result.linesAdded, result.linesRemoved], [1, 2]);
  const [file] = result.files;
  assert.equal(result.files.length, 1);
  assert.equal(file?.path, 'main.ts');
  assert.equal(file?.status, 'changed');
  assert.equal(file?.diff, 'text');
  assert.equal(file?.hunks.length, 2);
  assert.deepEqual(file?.hunks[0], {
    oldStart: 1,
    oldLines: 6,
    newStart: 1,
    newLines: 6,
    lines: [' line 1', ' line 2', '-line 3', '+third, changed', ' line 4', ' line 5', ' line 6'],
  });
  assert.equal(
    result.patch,
    '--- a/main.ts\n+++ b/main.ts\n' +
      '@@ -1,6 +1,6 @@\n line 1\n line 2\n-line 3\n+third, changed\n line 4\n line 5\n line 6\n' +
      '@@ -13,7 +13,6 @@\n line 13\n line 14\n line 15\n-line 16\n line 17\n line 18\n line 19\n',
  );

  // Backwards works too, and a version against itself has no changes.
  const back = await artifacts.compare(id, 2, 1);
  assert.deepEqual([back?.linesAdded, back?.linesRemoved], [2, 1]);
  const same = await artifacts.compare(id, 2, 2);
  assert.deepEqual([same?.files, same?.unchanged, same?.patch], [[], 1, '']);

  assert.equal(await artifacts.compare(id, 1, 3), null);
  assert.equal(await artifacts.compare('missing', 1, 2), null);
  await artifacts.delete(id);
  assert.equal(await artifacts.compare(id, 1, 2), null);
});

test('multi-file versions: added, removed, changed and binary files, entry first', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish(
    {
      title: 'Site',
      format: 'html',
      entry: 'index.html',
      files: {
        'index.html': '<h1>Hi</h1>\n<p>old</p>\n',
        'a.css': 'body {}\n',
        'gone.js': 'console.log(1);\n',
        'logo.png': { base64: PNG },
        'same.txt': 'same\n',
      },
    },
    'a',
  );
  const png2 = Buffer.from(`${Buffer.from(PNG, 'base64').toString('hex')}00`, 'hex');
  await artifacts.publish(
    {
      id,
      format: 'html',
      entry: 'index.html',
      files: {
        'index.html': '<h1>Hi</h1>\n<p>new</p>\n',
        'a.css': 'body { margin: 0 }\n',
        'b.css': 'p {}\n',
        'logo.png': { base64: png2.toString('base64') },
        'same.txt': 'same\n',
      },
    },
    'a',
  );

  const result = await artifacts.compare(id, 1, 2);
  assert.ok(result);
  assert.deepEqual(
    result.files.map((f) => [f.path, f.status, f.diff, f.linesAdded, f.linesRemoved]),
    [
      ['index.html', 'changed', 'text', 1, 1],
      ['a.css', 'changed', 'text', 1, 1],
      ['b.css', 'added', 'text', 1, 0],
      ['gone.js', 'removed', 'text', 0, 1],
      ['logo.png', 'changed', 'binary', null, null],
    ],
  );
  assert.equal(result.unchanged, 1);
  assert.deepEqual([result.linesAdded, result.linesRemoved], [3, 3]);
  assert.deepEqual(result.files[4]?.hunks, []);
  assert.match(result.patch, /^--- a\/index\.html\n\+\+\+ b\/index\.html\n/);
  assert.match(result.patch, /--- \/dev\/null\n\+\+\+ b\/b\.css\n@@ -0,0 \+1,1 @@\n\+p \{\}\n/);
  assert.match(result.patch, /--- a\/gone\.js\n\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@\n/);
  assert.match(result.patch, /Binary files a\/logo\.png and b\/logo\.png differ\n$/);
});

test('a new entry path is a rename of the entry', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish(
    { title: 'Doc', content: '# Title\n\nText\n', format: 'markdown' },
    'a',
  );
  await artifacts.publish({ id, content: '<h1>Title</h1>\n\nText\n', format: 'html' }, 'a');
  const result = await artifacts.compare(id, 1, 2);
  assert.deepEqual(
    result?.files.map((f) => [f.oldPath, f.path, f.status, f.linesAdded, f.linesRemoved]),
    [['README.md', 'index.html', 'renamed', 1, 1]],
  );
  assert.match(result?.patch ?? '', /^--- a\/README\.md\n\+\+\+ b\/index\.html\n/);
  assert.equal((await artifacts.get(id, 2))?.version.linesAdded, 1);
});

test('the diff stops at the size limit, keeping the counts', async (t) => {
  const { artifacts } = setup(t);
  // About 120 KB of diff each for a.txt and c.txt: together over the limit.
  const big = `x\n${lines(9000, 'added').join('\n')}\n`;
  const { id } = await artifacts.publish(
    {
      title: 'Big',
      format: 'code',
      entry: 'a.txt',
      files: { 'a.txt': 'x\n', 'b.txt': 'b\n', 'c.txt': 'x\n' },
    },
    'a',
  );
  await artifacts.publish(
    { id, format: 'code', entry: 'a.txt', files: { 'a.txt': big, 'b.txt': 'B\n', 'c.txt': big } },
    'a',
  );
  const result = await artifacts.compare(id, 1, 2);
  assert.ok(result);
  assert.equal(result.truncated, true);
  const size = Buffer.byteLength(result.patch);
  assert.ok(size <= COMPARE_LIMITS.diffBytes && size > 100 * 1024, `${size}`);
  assert.deepEqual(
    result.files.map((f) => [f.path, f.linesAdded, f.hunks.length, f.truncated]),
    [
      ['a.txt', 9000, 1, false],
      ['b.txt', 1, 1, false],
      ['c.txt', 9000, 0, true],
    ],
  );
  assert.doesNotMatch(result.patch, /c\.txt/);
});

test('a diff that is too slow gives no counts', () => {
  assert.deepEqual(lineCounts('a\nb\n', 'a\nc\n'), { added: 1, removed: 1 });
  const before = lines(30_000, 'old').join('\n');
  const after = lines(30_000, 'new').join('\n');
  assert.equal(lineCounts(before, after), null);
});

test('the migration backfills counts for every version, deleted artifacts too', async (t) => {
  const env = setup(t);
  const { id } = await env.artifacts.publish(
    { title: 'Page', content: '<p>one</p>\n', format: 'html' },
    'a',
  );
  await env.artifacts.publish({ id, content: '<p>one</p>\n<p>two</p>\n', format: 'html' }, 'a');
  await env.artifacts.restoreVersion(id, 1, 'owner');
  const { id: pdfId } = await env.artifacts.publish(
    { title: 'PDF', content: PDF, format: 'pdf' },
    'a',
  );
  const { id: goneId } = await env.artifacts.publish(
    { title: 'Gone', content: 'a\nb\nc', format: 'markdown' },
    'a',
  );
  await env.artifacts.delete(goneId);

  env.reopen(() => {
    const db = new DatabaseSync(join(env.config.dataDir, 'artifacts.db'));
    db.exec(
      'DROP TABLE sessions; DROP TABLE oauth_tokens; DROP TABLE oauth_codes; DROP TABLE oauth_grants; DROP TABLE oauth_clients; ' +
        'ALTER TABLE versions DROP COLUMN lines_added; ALTER TABLE versions DROP COLUMN lines_removed; PRAGMA user_version = 6',
    );
    db.close();
  });

  const counts = async (artifactId: string) =>
    (await env.artifacts.listVersions(artifactId))?.map((v) => [v.linesAdded, v.linesRemoved]);
  assert.deepEqual(await counts(id), [
    [0, 1],
    [1, 0],
    [1, 0],
  ]);
  assert.deepEqual(await counts(pdfId), [[null, null]]);
  await env.artifacts.undelete(goneId);
  assert.deepEqual(await counts(goneId), [[3, 0]]);
});
