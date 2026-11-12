import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { AppError } from '../contracts.ts';
import { createCore } from './index.ts';
import { htmlToText, indexText, toFtsQuery } from './search.ts';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-search-'));
  const config: Config = {
    port: 0,
    dataDir: join(dir, 'data'),
    appOrigin: 'https://app.example',
    contentOrigin: 'https://content.example',
    signingSecret: 'x'.repeat(32),
    devUser: null,
    authEmailHeader: 'X-authentik-email',
    authNameHeader: 'X-authentik-name',
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

const titles = async (
  artifacts: ReturnType<typeof setup>['artifacts'],
  query: string,
): Promise<string[]> => (await artifacts.search({ query })).items.map((h) => h.artifact.title);

test('node:sqlite has FTS5 with the unicode61 tokenizer', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'unicode61 remove_diacritics 2')");
  db.close();
});

test('htmlToText strips tags, scripts, styles and comments, and decodes entities', () => {
  const html = `<!doctype html><html><head><title>Q&amp;A</title>
<style>body { color: red }</style><script>var secret = "<p>no</p>";</script>
<SCRIPT type="module">alsoHidden()</SCRIPT></head>
<body><h1>Caf&eacute; &lt;menu&gt;</h1><!-- hidden comment --><p>Fish&nbsp;&amp; chips &#8364;5 &#x1F600; 1 < 2</p>
<br/>end<script>unclosed`;
  assert.equal(htmlToText(html), 'Q&A Caf&eacute; <menu> Fish & chips €5 😀 1 < 2 end');
  assert.equal(htmlToText('a < b <3'), 'a < b <3');
  assert.equal(htmlToText('a<div class="x'), 'a');
  assert.equal(htmlToText('&#0; &#x110000; &bogus;'), '&#0; &#x110000; &bogus;');
});

test('indexText: html as text, others as-is, pdf and images empty, capped at 256 KB', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  assert.equal(indexText('html', bytes('<p>hi</p>')), 'hi');
  assert.equal(indexText('markdown', bytes('# <b>Title</b>')), '# <b>Title</b>');
  assert.equal(indexText('code', bytes('const a = 1;')), 'const a = 1;');
  assert.equal(indexText('pdf', bytes('%PDF-1.7 text')), '');
  assert.equal(indexText('image', bytes('\x89PNG binary')), '');
  const long = indexText('markdown', bytes(`${'a'.repeat(256 * 1024 - 1)}é`));
  assert.equal(Buffer.byteLength(long), 256 * 1024 - 1);
  assert.ok(!long.includes('�'));
});

test('toFtsQuery quotes every term and makes the last a prefix', () => {
  assert.equal(toFtsQuery('hello world'), '"hello" "world"*');
  assert.equal(toFtsQuery('a AND b'), '"a" "AND" "b"*');
  assert.equal(toFtsQuery('say "hi'), '"say" """hi"*');
  assert.equal(toFtsQuery('title:x NEAR(a b)'), '"title:x" "NEAR(a" "b)"*');
  assert.equal(toFtsQuery('  '), null);
  assert.equal(toFtsQuery('* - ^ "" ()'), null);
  assert.equal(
    toFtsQuery(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '))?.split(' ').length,
    20,
  );
});

test('search ranks title matches first, matches prefixes and ignores diacritics', async (t) => {
  const { artifacts } = setup(t);
  await artifacts.publish(
    { title: 'Notes', content: 'Something about a gazebo somewhere.', format: 'markdown' },
    'a',
  );
  await artifacts.publish(
    { title: 'Gazebo plans', content: '<p>Wood and nails</p>', format: 'html' },
    'a',
  );
  await artifacts.publish(
    { title: 'Other', description: 'gazebo budget', content: 'x', format: 'code' },
    'a',
  );
  await artifacts.publish({ title: 'Crème brûlée', content: 'dessert', format: 'markdown' }, 'a');

  assert.deepEqual(await titles(artifacts, 'gazebo'), ['Gazebo plans', 'Other', 'Notes']);
  assert.deepEqual(await titles(artifacts, 'gaz'), ['Gazebo plans', 'Other', 'Notes']);
  assert.deepEqual(await titles(artifacts, 'creme brul'), ['Crème brûlée']);
  assert.deepEqual(await titles(artifacts, 'wood nails'), ['Gazebo plans']);
  assert.deepEqual(await titles(artifacts, 'wood missing'), []);

  const [hit] = (await artifacts.search({ query: 'somewhere' })).items;
  assert.equal(hit?.snippet, 'Something about a gazebo «somewhere».');
});

test('FTS syntax in a query matches as text and never throws', async (t) => {
  const { artifacts } = setup(t);
  await artifacts.publish(
    { title: 'Ops', content: 'deploy AND rollback NOT now', format: 'markdown' },
    'a',
  );
  for (const query of [
    'AND',
    'OR NOT',
    'NEAR(deploy rollback, 1)',
    'title:Ops',
    '"unbalanced',
    'deploy*',
    '^deploy',
    '-deploy',
    '(',
    '{title body}: x',
    '"" * ""',
    "'; DROP TABLE artifacts; --",
  ]) {
    await artifacts.search({ query });
  }
  assert.deepEqual(await titles(artifacts, 'AND rollback'), ['Ops']);
  // As a column filter this would find Ops; as text it is the phrase "title ops", which isn't there.
  assert.deepEqual(await titles(artifacts, 'title:Ops'), []);
  assert.deepEqual(await titles(artifacts, '"deploy'), ['Ops']);
  assert.deepEqual(await titles(artifacts, ''), []);
});

test('a new version replaces the old text; settings change title and description', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish(
    { title: 'Report', content: '<p>first draft about apples</p>', format: 'html' },
    'a',
  );
  assert.deepEqual(await titles(artifacts, 'apples'), ['Report']);

  await artifacts.publish({ id, content: 'second draft about pears', format: 'markdown' }, 'a');
  assert.deepEqual(await titles(artifacts, 'apples'), []);
  assert.deepEqual(await titles(artifacts, 'pears'), ['Report']);

  await artifacts.publish({ id, title: 'Fruit summary', description: 'seasonal' }, 'a');
  assert.deepEqual(await titles(artifacts, 'report'), []);
  assert.deepEqual(await titles(artifacts, 'fruit'), ['Fruit summary']);
  assert.deepEqual(await titles(artifacts, 'seasonal pears'), ['Fruit summary']);

  // A failed publish leaves the index as it was.
  await assert.rejects(
    artifacts.publish({ id, content: 'plums', format: 'markdown', expectedVersion: 1 }, 'a'),
  );
  assert.deepEqual(await titles(artifacts, 'plums'), []);
});

test('deleted artifacts are left out', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish(
    { title: 'Secret plan', content: 'x', format: 'code' },
    'a',
  );
  await artifacts.publish({ title: 'Public plan', content: 'x', format: 'code' }, 'a');
  assert.equal((await titles(artifacts, 'plan')).length, 2);
  assert.equal(await artifacts.delete(id), true);
  assert.deepEqual(await titles(artifacts, 'plan'), ['Public plan']);
});

test('search paginates with a cursor', async (t) => {
  const { artifacts } = setup(t);
  for (let i = 0; i < 5; i++) {
    await artifacts.publish(
      { title: `Page ${i}`, content: 'common word', format: 'markdown' },
      'a',
    );
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await artifacts.search({ query: 'common', limit: 2, cursor });
    assert.ok(page.items.length <= 2);
    seen.push(...page.items.map((h) => h.artifact.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(new Set(seen).size, 5);
  await assert.rejects(
    artifacts.search({ query: 'common', cursor: 'nope!' }),
    (error: unknown) => error instanceof AppError && error.code === 'invalid_input',
  );
});

test('the migration backfills existing artifacts', async (t) => {
  const env = setup(t);
  const { id: htmlId } = await env.artifacts.publish(
    { title: 'Old page', content: '<script>hidden()</script><p>visible words</p>', format: 'html' },
    'a',
  );
  await env.artifacts.publish({ id: htmlId, content: '<p>newest words</p>', format: 'html' }, 'a');
  const { id: goneId } = await env.artifacts.publish(
    { title: 'Gone words', content: 'x', format: 'markdown' },
    'a',
  );
  await env.artifacts.delete(goneId);
  const pdf = Buffer.from('%PDF-1.7 words').toString('base64');
  await env.artifacts.publish({ title: 'A pdf', content: pdf, format: 'pdf' }, 'a');

  // Roll the database back to before the search migration, as on the deployed instance.
  env.reopen(() => {
    const db = new DatabaseSync(join(env.config.dataDir, 'artifacts.db'));
    // Later steps run again too, so their tables go as well.
    db.exec(
      'DROP TABLE oauth_tokens; DROP TABLE oauth_codes; DROP TABLE oauth_grants; DROP TABLE oauth_clients; ' +
        'DROP TABLE artifacts_fts; DROP TABLE share_links; DROP TABLE asks; DROP TABLE comments; DROP TABLE threads; ' +
        'DROP TABLE artifact_data; ALTER TABLE artifacts DROP COLUMN capabilities; ALTER TABLE artifacts DROP COLUMN data_rev; ALTER TABLE artifacts DROP COLUMN data_floor; ' +
        'ALTER TABLE versions DROP COLUMN lines_added; ALTER TABLE versions DROP COLUMN lines_removed; PRAGMA user_version = 1',
    );
    db.close();
  });

  assert.deepEqual(await titles(env.artifacts, 'newest'), ['Old page']);
  assert.deepEqual(await titles(env.artifacts, 'visible'), []);
  assert.deepEqual(await titles(env.artifacts, 'hidden'), []);
  assert.deepEqual(await titles(env.artifacts, 'words'), ['Old page']);
  assert.deepEqual(await titles(env.artifacts, 'pdf'), ['A pdf']);
});
