import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { AppError, LIMITS, type PublishInput } from '../contracts.ts';
import { createCore } from './index.ts';

function setup(t: TestContext) {
  return setupWith(t).core;
}

function setupWith(t: TestContext) {
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
    proxySecret: null,
    authMode: 'proxy',
    authUsers: [],
  };
  const env = { core: createCore(config), config };
  t.after(() => {
    env.core.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return env;
}

test('the styles migration runs on an existing database', async (t) => {
  const env = setupWith(t);
  const page = await env.core.artifacts.publish(
    { title: 'Old', format: 'html', content: '<p>x</p>' },
    'a',
  );
  env.core.close();
  // Back to the schema before styles, as on a deployed instance.
  const db = new DatabaseSync(join(env.config.dataDir, 'artifacts.db'));
  db.exec(
    'DROP TABLE settings; DROP INDEX versions_by_style; ALTER TABLE versions DROP COLUMN style_version; ' +
      'ALTER TABLE versions DROP COLUMN style_id; ALTER TABLE artifacts DROP COLUMN style_id; PRAGMA user_version = 9',
  );
  db.close();
  env.core = createCore(env.config);

  const got = await env.core.artifacts.get(page.id);
  assert.equal(got?.artifact.style, null);
  assert.equal(got?.version.style, null);
  const s = await env.core.artifacts.publish(
    { title: 'Brand', format: 'style', files: styleFiles() },
    'a',
  );
  assert.equal((await env.core.artifacts.get(s.id))?.artifact.format, 'style');
});

const code = (c: AppError['code']) => (error: unknown) =>
  error instanceof AppError && error.code === c;

function styleFiles(css = ':root{--ink:#111}'): Record<string, string> {
  return {
    'style.css': css,
    'guide.md': '# Guide\nUse .card',
    'preview.html': '<!doctype html><p class="card">x</p>',
  };
}

const withoutFile = (files: Record<string, string>, name: string) =>
  Object.fromEntries(Object.entries(files).filter(([path]) => path !== name));

test('publish a style: preview.html is the entry, else guide.md', async (t) => {
  const { artifacts } = setup(t);
  const s = await artifacts.publish({ title: 'Brand', format: 'style', files: styleFiles() }, 'a');
  const got = await artifacts.get(s.id);
  assert.equal(got?.artifact.format, 'style');
  assert.equal(got?.version.format, 'style');
  assert.equal(got?.version.entry, 'preview.html');
  assert.equal(got?.artifact.style, null);
  assert.equal(got?.version.style, null);

  const noPreview = withoutFile(styleFiles(), 'preview.html');
  const bare = await artifacts.publish({ title: 'Bare', format: 'style', files: noPreview }, 'a');
  assert.equal((await artifacts.get(bare.id))?.version.entry, 'guide.md');
});

test('a style needs files with style.css and guide.md, and an entry of preview.html or guide.md', async (t) => {
  const { artifacts } = setup(t);
  const refused: PublishInput[] = [
    { title: 'x', format: 'style', content: 'body{}' },
    { title: 'x', format: 'style', files: withoutFile(styleFiles(), 'guide.md') },
    { title: 'x', format: 'style', files: withoutFile(styleFiles(), 'style.css') },
    { title: 'x', format: 'style', files: styleFiles(), entry: 'style.css' },
    {
      title: 'x',
      format: 'style',
      files: withoutFile(styleFiles(), 'preview.html'),
      entry: 'preview.html',
    },
    { title: 'x', format: 'style', files: styleFiles(), capabilities: { db: true } },
  ];
  for (const input of refused) {
    await assert.rejects(
      artifacts.publish(input, 'a'),
      code('invalid_input'),
      JSON.stringify(input),
    );
  }
});

test('a new version of a style without format stays a style', async (t) => {
  const { artifacts } = setup(t);
  const s = await artifacts.publish({ title: 'Brand', format: 'style', files: styleFiles() }, 'a');
  const next = await artifacts.publish({ id: s.id, files: styleFiles(':root{--ink:#222}') }, 'a');
  assert.equal(next.version, 2);
  const got = await artifacts.get(s.id);
  assert.equal(got?.artifact.format, 'style');
  assert.equal(got?.version.format, 'style');
});

test("a style's format never changes, and nothing else becomes a style", async (t) => {
  const { artifacts } = setup(t);
  const s = await artifacts.publish({ title: 'Brand', format: 'style', files: styleFiles() }, 'a');
  const page = await artifacts.publish({ title: 'Page', format: 'html', content: '<p>x</p>' }, 'a');
  await assert.rejects(
    artifacts.publish({ id: s.id, format: 'html', content: '<p>x</p>' }, 'a'),
    code('invalid_input'),
  );
  await assert.rejects(
    artifacts.publish({ id: s.id, files: { 'index.html': '<p>x</p>' } }, 'a'),
    code('invalid_input'),
  );
  await assert.rejects(
    artifacts.publish({ id: page.id, format: 'style', files: styleFiles() }, 'a'),
    code('invalid_input'),
  );
  assert.equal((await artifacts.get(s.id))?.artifact.latestVersion, 1);
  assert.equal((await artifacts.get(page.id))?.artifact.format, 'html');
});

test('a style gets no capabilities in a settings-only publish either', async (t) => {
  const { artifacts } = setup(t);
  const s = await artifacts.publish({ title: 'Brand', format: 'style', files: styleFiles() }, 'a');
  await assert.rejects(
    artifacts.publish({ id: s.id, capabilities: { viewer: true } }, 'a'),
    code('invalid_input'),
  );
});

test('edits work on a style entry; search indexes the guide', async (t) => {
  const { artifacts } = setup(t);
  const s = await artifacts.publish({ title: 'Brand', format: 'style', files: styleFiles() }, 'a');
  const edited = await artifacts.publish({ id: s.id, edits: [{ old: '>x<', new: '>y<' }] }, 'a');
  assert.equal(edited.version, 2);
  const got = await artifacts.get(s.id);
  assert.equal(got?.version.format, 'style');
  assert.equal(got?.version.linesAdded, 1);
  const hits = await artifacts.search({ query: 'card' });
  assert.deepEqual(
    hits.items.map((h) => h.artifact.id),
    [s.id],
  );
  // The preview's own text isn't what is indexed for a style.
  assert.equal((await artifacts.search({ query: 'doctype' })).items.length, 0);
});

// ---- Publishing with a style ----

const MOCK = '<!doctype html><p>m</p>';

type Artifacts = ReturnType<typeof setup>['artifacts'];

const publishStyle = (artifacts: Artifacts, css?: string) =>
  artifacts.publish({ title: 'Brand', format: 'style', files: styleFiles(css) }, 'a');

const mock = (artifacts: Artifacts, style: string | null, extra: Partial<PublishInput> = {}) =>
  artifacts.publish({ title: 'Mock', format: 'html', content: MOCK, style, ...extra }, 'a');

const paths = async (artifacts: Artifacts, id: string, version?: number) =>
  (await artifacts.get(id, version))?.version.files.map((f) => f.path);

const sha = async (artifacts: Artifacts, id: string, path: string, version?: number) =>
  (await artifacts.get(id, version))?.version.files.find((f) => f.path === path)?.sha256;

test('a mock with a style holds its files under _style/ and records the style version', async (t) => {
  const { artifacts } = setup(t);
  const s = await publishStyle(artifacts);
  const m = await mock(artifacts, s.id);
  const got = await artifacts.get(m.id);
  assert.deepEqual(got?.version.style, { id: s.id, version: 1 });
  assert.equal(got?.artifact.style, s.id);
  assert.equal(got?.version.entry, 'index.html');
  assert.deepEqual(await paths(artifacts, m.id), [
    '_style/guide.md',
    '_style/preview.html',
    '_style/style.css',
    'index.html',
  ]);
  assert.equal(
    await sha(artifacts, m.id, '_style/style.css'),
    await sha(artifacts, s.id, 'style.css'),
  );
  const file = await artifacts.readFile(m.id, 1, '_style/style.css');
  assert.equal(new TextDecoder().decode(file?.bytes), ':root{--ink:#111}');
});

test('a markdown artifact can use a style', async (t) => {
  const { artifacts } = setup(t);
  const s = await publishStyle(artifacts);
  const doc = await artifacts.publish(
    { title: 'Doc', format: 'markdown', content: '# Hi', style: s.id },
    'a',
  );
  assert.deepEqual((await artifacts.get(doc.id))?.version.style, { id: s.id, version: 1 });
});

test('an old version keeps its style version; a new version gets the latest', async (t) => {
  const { artifacts } = setup(t);
  const s = await publishStyle(artifacts);
  const m = await mock(artifacts, s.id);
  await artifacts.publish({ id: s.id, files: styleFiles(':root{--ink:#222}') }, 'a');
  assert.deepEqual((await artifacts.get(m.id, 1))?.version.style, { id: s.id, version: 1 });

  const next = await artifacts.publish({ id: m.id, format: 'html', content: '<p>v2</p>' }, 'a');
  assert.equal(next.version, 2);
  assert.deepEqual((await artifacts.get(m.id))?.version.style, { id: s.id, version: 2 });
  assert.equal(
    await sha(artifacts, m.id, '_style/style.css'),
    await sha(artifacts, s.id, 'style.css'),
  );
  assert.notEqual(
    await sha(artifacts, m.id, '_style/style.css', 1),
    await sha(artifacts, m.id, '_style/style.css', 2),
  );
});

test('edits on a styled artifact refresh the style files', async (t) => {
  const { artifacts } = setup(t);
  const s = await publishStyle(artifacts);
  const m = await mock(artifacts, s.id);
  // The new style version drops preview.html: the mock must not keep the old copy of it.
  await artifacts.publish(
    { id: s.id, files: withoutFile(styleFiles(':root{--ink:#222}'), 'preview.html') },
    'a',
  );
  await artifacts.publish({ id: m.id, edits: [{ old: '<p>m</p>', new: '<p>n</p>' }] }, 'a');
  assert.deepEqual(await paths(artifacts, m.id), [
    '_style/guide.md',
    '_style/style.css',
    'index.html',
  ]);
  assert.equal(
    await sha(artifacts, m.id, '_style/style.css'),
    await sha(artifacts, s.id, 'style.css'),
  );
  assert.deepEqual((await artifacts.get(m.id))?.version.style, { id: s.id, version: 2 });
});

test('restyle with id and style only; nothing is published when it is already up to date', async (t) => {
  const { artifacts } = setup(t);
  const s = await publishStyle(artifacts);
  const m = await mock(artifacts, s.id);
  await artifacts.publish({ id: s.id, files: styleFiles(':root{--ink:#222}') }, 'a');

  const restyled = await artifacts.publish({ id: m.id, style: s.id }, 'a');
  assert.equal(restyled.version, 2);
  assert.deepEqual((await artifacts.get(m.id))?.version.style, { id: s.id, version: 2 });
  assert.equal(
    await sha(artifacts, m.id, 'index.html', 2),
    await sha(artifacts, m.id, 'index.html', 1),
  );

  const again = await artifacts.publish({ id: m.id, style: s.id }, 'a');
  assert.equal(again.version, 2);
  assert.equal((await artifacts.listVersions(m.id))?.length, 2);
});

test('a style can be added to an artifact that had none', async (t) => {
  const { artifacts } = setup(t);
  const s = await publishStyle(artifacts);
  const m = await mock(artifacts, null);
  assert.equal((await artifacts.get(m.id))?.version.style, null);
  const styled = await artifacts.publish({ id: m.id, style: s.id }, 'a');
  assert.equal(styled.version, 2);
  assert.deepEqual((await artifacts.get(m.id))?.version.style, { id: s.id, version: 1 });
  // Nothing to change: no style before, none asked for.
  const other = await mock(artifacts, null);
  assert.equal((await artifacts.publish({ id: other.id, style: null }, 'a')).version, 1);
});

test('style: null removes the style and its files', async (t) => {
  const { artifacts } = setup(t);
  const s = await publishStyle(artifacts);
  const m = await mock(artifacts, s.id);
  const plain = await artifacts.publish({ id: m.id, style: null }, 'a');
  assert.equal(plain.version, 2);
  const got = await artifacts.get(m.id);
  assert.equal(got?.version.style, null);
  assert.equal(got?.artifact.style, null);
  assert.deepEqual(await paths(artifacts, m.id), ['index.html']);
  // And it stays off for later versions.
  await artifacts.publish({ id: m.id, format: 'html', content: '<p>v3</p>' }, 'a');
  assert.equal((await artifacts.get(m.id))?.version.style, null);
});

test('refused styles: unknown, not a style, wrong format, a style on a style, _style/ paths', async (t) => {
  const { artifacts } = setup(t);
  const s = await publishStyle(artifacts);
  const page = await mock(artifacts, null);
  await assert.rejects(mock(artifacts, 'nope'), code('not_found'));
  await assert.rejects(mock(artifacts, page.id), code('invalid_input'));
  await assert.rejects(
    artifacts.publish({ title: 'c', format: 'code', content: 'x', style: s.id }, 'a'),
    code('invalid_input'),
  );
  await assert.rejects(
    artifacts.publish({ title: 'st', format: 'style', files: styleFiles(), style: s.id }, 'a'),
    code('invalid_input'),
  );
  await assert.rejects(
    artifacts.publish(
      {
        title: 'f',
        files: { 'index.html': MOCK, '_style/x.css': 'a{}' },
        entry: 'index.html',
        style: s.id,
      },
      'a',
    ),
    code('invalid_input'),
  );
  // Without a style the folder isn't reserved.
  const own = await artifacts.publish(
    { title: 'f', files: { 'index.html': MOCK, '_style/x.css': 'a{}' }, entry: 'index.html' },
    'a',
  );
  assert.equal(own.version, 1);
});

test('a styled artifact that turns into code must drop its style', async (t) => {
  const { artifacts } = setup(t);
  const s = await publishStyle(artifacts);
  const m = await mock(artifacts, s.id);
  await assert.rejects(
    artifacts.publish({ id: m.id, format: 'code', content: 'x' }, 'a'),
    (error: unknown) => code('invalid_input')(error) && /style: null/.test(String(error)),
  );
  const code1 = await artifacts.publish(
    { id: m.id, format: 'code', content: 'x', style: null },
    'a',
  );
  assert.equal(code1.version, 2);
});

test('copied style files count toward the file limit', async (t) => {
  const { artifacts } = setup(t);
  const s = await artifacts.publish(
    { title: 'Brand', format: 'style', files: { ...styleFiles(), 'font.woff2': 'f' } },
    'a',
  );
  const own: Record<string, string> = { 'index.html': MOCK };
  for (let i = 1; i < LIMITS.files - 3; i++) own[`f${i}.txt`] = String(i);
  assert.equal(Object.keys(own).length, LIMITS.files - 3);
  await assert.rejects(
    artifacts.publish({ title: 'Big', files: own, entry: 'index.html', style: s.id }, 'a'),
    code('too_large'),
  );
  delete own['f1.txt'];
  const ok = await artifacts.publish(
    { title: 'Big', files: own, entry: 'index.html', style: s.id },
    'a',
  );
  assert.equal((await artifacts.get(ok.id))?.version.files.length, LIMITS.files);
});

test('restore brings back the old style version', async (t) => {
  const { artifacts } = setup(t);
  const s = await publishStyle(artifacts);
  const m = await mock(artifacts, s.id);
  await artifacts.publish({ id: s.id, files: styleFiles(':root{--ink:#222}') }, 'a');
  await artifacts.publish({ id: m.id, style: s.id }, 'a');
  await artifacts.publish({ id: m.id, style: null }, 'a');
  const restored = await artifacts.restoreVersion(m.id, 1, 'owner');
  assert.equal(restored.version, 4);
  const got = await artifacts.get(m.id);
  assert.deepEqual(got?.version.style, { id: s.id, version: 1 });
  assert.equal(got?.artifact.style, s.id);
  assert.equal(
    await sha(artifacts, m.id, '_style/style.css'),
    await sha(artifacts, m.id, '_style/style.css', 1),
  );
});

test('a deleted style: the copy stays, a new version keeps it with a warning', async (t) => {
  const { artifacts } = setup(t);
  const s = await publishStyle(artifacts);
  const m = await mock(artifacts, s.id);
  const copy = await sha(artifacts, m.id, '_style/style.css');
  await artifacts.delete(s.id);

  const next = await artifacts.publish(
    { id: m.id, edits: [{ old: '<p>m</p>', new: '<p>n</p>' }] },
    'a',
  );
  assert.equal(next.version, 2);
  assert.match(next.warning ?? '', /deleted/);
  const got = await artifacts.get(m.id);
  assert.deepEqual(got?.version.style, { id: s.id, version: 1 });
  assert.equal(await sha(artifacts, m.id, '_style/style.css'), copy);

  await assert.rejects(mock(artifacts, s.id), code('not_found'));
  // Restyling to the deleted style, explicitly, is not_found too.
  await assert.rejects(artifacts.publish({ id: m.id, style: s.id }, 'a'), code('not_found'));
});
