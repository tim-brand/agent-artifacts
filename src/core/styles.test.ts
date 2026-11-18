import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { AppError, type PublishInput } from '../contracts.ts';
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
