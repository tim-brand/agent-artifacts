import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { AppError } from '../contracts.ts';
import { createCore } from './index.ts';

function setup(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-artifacts-'));
  const config: Config = {
    port: 0,
    dataDir: join(dataDir, 'data'),
    appOrigin: 'https://app.example',
    contentOrigin: 'https://content.example',
    signingSecret: 'x'.repeat(32),
    devUser: null,
    authEmailHeader: 'X-authentik-email',
    authNameHeader: 'X-authentik-name',
  };
  const core = createCore(config);
  t.after(() => {
    core.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const blobCount = () =>
    readdirSync(join(config.dataDir, 'blobs'), { recursive: true, withFileTypes: true }).filter(
      (e) => e.isFile(),
    ).length;
  return { ...core, config, blobCount };
}

const code = (c: AppError['code']) => (error: unknown) =>
  error instanceof AppError && error.code === c;

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test('publish a new artifact, a new version and a settings-only change', async (t) => {
  const { artifacts } = setup(t);
  const first = await artifacts.publish(
    { title: ' Hello ', content: '<h1>hi</h1>', format: 'html' },
    'agent',
  );
  assert.equal(first.version, 1);
  assert.equal(first.title, 'Hello');
  assert.match(first.id, /^[0-9A-Za-z]{12}$/);
  assert.equal(first.url, `https://app.example/a/${first.id}`);

  const got = await artifacts.get(first.id);
  assert.equal(got?.version.entry, 'index.html');
  assert.equal(got?.version.publishedBy, 'agent');
  assert.equal(got?.version.files[0]?.contentType, 'text/html; charset=utf-8');

  const second = await artifacts.publish(
    { id: first.id, content: 'print(1)', format: 'code', language: 'python' },
    'other',
  );
  assert.equal(second.version, 2);
  assert.equal(second.title, 'Hello');
  const latest = await artifacts.get(first.id);
  assert.equal(latest?.artifact.format, 'code');
  assert.equal(latest?.artifact.latestVersion, 2);
  assert.equal(latest?.version.entry, 'main.py');
  assert.equal(latest?.version.files[0]?.contentType, 'text/plain; charset=utf-8');

  const settings = await artifacts.publish(
    { id: first.id, title: 'Renamed', description: 'about' },
    'agent',
  );
  assert.equal(settings.version, 2);
  const after = await artifacts.get(first.id);
  assert.equal(after?.artifact.title, 'Renamed');
  assert.equal(after?.artifact.description, 'about');
  assert.equal((await artifacts.listVersions(first.id))?.length, 2);

  const old = await artifacts.get(first.id, 1);
  assert.equal(old?.version.format, 'html');
  assert.equal(await artifacts.get(first.id, 3), null);
  assert.equal(await artifacts.get('missing'), null);
});

test('publish rejects bad input', async (t) => {
  const { artifacts } = setup(t);
  await assert.rejects(
    artifacts.publish({ content: 'x', format: 'html' }, 'a'),
    code('invalid_input'),
  );
  await assert.rejects(artifacts.publish({ title: 't' }, 'a'), code('invalid_input'));
  await assert.rejects(artifacts.publish({ title: 't', content: 'x' }, 'a'), code('invalid_input'));
  await assert.rejects(
    artifacts.publish({ id: 'nope', content: 'x', format: 'html' }, 'a'),
    code('not_found'),
  );
  await assert.rejects(
    artifacts.publish({ title: 't', files: { 'a.html': 'x' }, entry: 'b.html' }, 'a'),
    code('invalid_input'),
  );
  await assert.rejects(
    artifacts.publish({ title: 't', files: { 'a.bin': { base64: '/9j/AAAA' } } }, 'a'),
    code('unsupported_format'),
  );
  const { id } = await artifacts.publish({ title: 't', content: 'x', format: 'markdown' }, 'a');
  await artifacts.delete(id);
  await assert.rejects(artifacts.publish({ id, title: 'again' }, 'a'), code('not_found'));
});

test('files publish with nested paths', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish(
    {
      title: 'Site',
      files: {
        'index.html': '<link rel="stylesheet" href="css/site.css">',
        'css/site.css': 'body{}',
        'img/deep/dot.png': { base64: 'iVBORw0KGgo=' },
        'lib/app.mjs': 'export {}',
      },
      entry: 'index.html',
    },
    'agent',
  );
  const got = await artifacts.get(id);
  assert.equal(got?.version.format, 'html');
  assert.deepEqual(
    got?.version.files.map((f) => [f.path, f.contentType]),
    [
      ['css/site.css', 'text/css; charset=utf-8'],
      ['img/deep/dot.png', 'image/png'],
      ['index.html', 'text/html; charset=utf-8'],
      ['lib/app.mjs', 'text/javascript; charset=utf-8'],
    ],
  );
  const png = await artifacts.readFile(id, 1, 'img/deep/dot.png');
  assert.deepEqual(png?.bytes, new Uint8Array(Buffer.from('iVBORw0KGgo=', 'base64')));

  const md = await artifacts.publish(
    { id, files: { 'docs/guide.markdown': '# Guide' }, entry: 'docs/guide.markdown' },
    'agent',
  );
  assert.equal((await artifacts.get(id, md.version))?.version.format, 'markdown');
  await assert.rejects(
    artifacts.publish({ id, files: { 'a.md': '#' }, entry: 'a.md', format: 'html' }, 'a'),
    code('invalid_input'),
  );
});

test('unchanged files are stored once across versions', async (t) => {
  const { artifacts, blobCount } = setup(t);
  const files = { 'index.html': '<p>same</p>', 'style.css': 'p{}' };
  const { id } = await artifacts.publish({ title: 'D', files, entry: 'index.html' }, 'a');
  assert.equal(blobCount(), 2);
  await artifacts.publish({ id, files, entry: 'index.html' }, 'a');
  assert.equal(blobCount(), 2);
  await artifacts.publish(
    { id, files: { ...files, 'style.css': 'p{color:red}' }, entry: 'index.html' },
    'a',
  );
  assert.equal(blobCount(), 3);
  const versions = await artifacts.listVersions(id);
  assert.deepEqual(
    versions?.map((v) => v.version),
    [3, 2, 1],
  );
  assert.equal(
    versions?.[0]?.files.find((f) => f.path === 'index.html')?.sha256,
    versions?.[2]?.files.find((f) => f.path === 'index.html')?.sha256,
  );
});

test('path validation rejects instead of normalizing', async (t) => {
  const { artifacts } = setup(t);
  const bad = [
    '/abs.html',
    '../up.html',
    'a/../b.html',
    './here.html',
    'a/./b.html',
    'a//b.html',
    'dir/',
    'back\\slash.html',
    'nul\0.html',
    '',
    `${'a'.repeat(513)}`,
  ];
  for (const path of bad) {
    await assert.rejects(
      artifacts.publish(
        { title: 't', files: { [path]: 'x', 'index.html': 'x' }, entry: 'index.html' },
        'a',
      ),
      code('invalid_input'),
      JSON.stringify(path),
    );
  }
  await artifacts.publish({ title: 't', files: { [`${'a'.repeat(507)}.html`]: 'x' } }, 'a');
});

test('limits', async (t) => {
  const { artifacts } = setup(t);
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}.txt`, 'x']));
  await assert.rejects(
    artifacts.publish({ title: 't', files: many, entry: 'f0.txt' }, 'a'),
    code('too_large'),
  );
  await assert.rejects(
    artifacts.publish(
      { title: 't', content: 'x'.repeat(10 * 1024 * 1024 + 1), format: 'code' },
      'a',
    ),
    code('too_large'),
  );
});

test('expectedVersion conflict', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish({ title: 't', content: 'a', format: 'markdown' }, 'a');
  await artifacts.publish({ id, content: 'b', format: 'markdown', expectedVersion: 1 }, 'a');
  await assert.rejects(
    artifacts.publish({ id, content: 'c', format: 'markdown', expectedVersion: 1 }, 'a'),
    (error: unknown) =>
      code('version_conflict')(error) && (error as AppError).details?.currentVersion === 2,
  );
  assert.equal((await artifacts.get(id))?.artifact.latestVersion, 2);
});

test('pdf must start with %PDF', async (t) => {
  const { artifacts } = setup(t);
  const pdf = Buffer.from('%PDF-1.7\n...').toString('base64');
  const { id } = await artifacts.publish({ title: 'p', content: pdf, format: 'pdf' }, 'a');
  const got = await artifacts.get(id);
  assert.equal(got?.version.entry, 'document.pdf');
  assert.equal(got?.version.files[0]?.contentType, 'application/pdf');
  assert.equal(
    text((await artifacts.readFile(id, 1, 'document.pdf'))?.bytes ?? new Uint8Array()),
    '%PDF-1.7\n...',
  );

  const notPdf = Buffer.from('<html>').toString('base64');
  await assert.rejects(
    artifacts.publish({ title: 'p', content: notPdf, format: 'pdf' }, 'a'),
    code('invalid_input'),
  );
  await assert.rejects(
    artifacts.publish({ title: 'p', files: { 'x.pdf': { base64: notPdf } }, entry: 'x.pdf' }, 'a'),
    code('invalid_input'),
  );
  await assert.rejects(
    artifacts.publish({ title: 'p', content: 'not base64!', format: 'pdf' }, 'a'),
    code('invalid_input'),
  );
});

const IMAGES = {
  png: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  jpg: Buffer.from('ffd8ffe000104a464946', 'hex'),
  jpeg: Buffer.from('ffd8ffdb0043', 'hex'),
  gif: Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'),
  webp: Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'),
  svg: Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'),
};

test('images: every format by content and by files', async (t) => {
  const { artifacts } = setup(t);
  for (const [ext, bytes] of Object.entries(IMAGES)) {
    const base64 = bytes.toString('base64');
    const byLanguage = await artifacts.publish(
      { title: ext, content: base64, format: 'image', language: ext.toUpperCase() },
      'a',
    );
    const got = await artifacts.get(byLanguage.id);
    assert.equal(got?.artifact.format, 'image', ext);
    assert.equal(got?.version.entry, `image.${ext}`);
    assert.match(got?.version.files[0]?.contentType ?? '', /^image\//);
    const file = await artifacts.readFile(byLanguage.id, 1, `image.${ext}`);
    assert.deepEqual(Buffer.from(file?.bytes ?? []), bytes);

    const byEntry = await artifacts.publish(
      { title: ext, content: base64, format: 'image', entry: `charts/q3.${ext}` },
      'a',
    );
    assert.equal((await artifacts.get(byEntry.id))?.version.entry, `charts/q3.${ext}`);

    const byFiles = await artifacts.publish(
      { title: ext, files: { [`shot.${ext}`]: { base64 } } },
      'a',
    );
    assert.equal((await artifacts.get(byFiles.id))?.version.format, 'image');
  }

  const svg = await artifacts.publish(
    {
      title: 'svg text',
      content: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      format: 'image',
      language: 'svg',
    },
    'a',
  );
  const got = await artifacts.get(svg.id);
  assert.equal(got?.version.files[0]?.contentType, 'image/svg+xml; charset=utf-8');
  assert.equal(
    text((await artifacts.readFile(svg.id, 1, 'image.svg'))?.bytes ?? new Uint8Array()),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  const files = await artifacts.publish(
    { title: 'svg file', files: { 'd.svg': '<svg></svg>' } },
    'a',
  );
  assert.equal((await artifacts.get(files.id))?.version.format, 'image');
});

test('images: a mismatched signature or a bad name is refused', async (t) => {
  const { artifacts } = setup(t);
  const publish = (input: Parameters<typeof artifacts.publish>[0]) =>
    artifacts.publish({ title: 't', ...input }, 'a');
  const b64 = (bytes: Buffer) => bytes.toString('base64');

  for (const [ext, wrong] of [
    ['png', IMAGES.jpg],
    ['jpg', IMAGES.png],
    ['gif', IMAGES.webp],
    ['webp', Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1')],
    ['svg', IMAGES.png],
    ['svg', Buffer.from('<html>no image here</html>')],
  ] as const) {
    await assert.rejects(
      publish({ content: b64(wrong), format: 'image', language: ext }),
      code('invalid_input'),
      ext,
    );
    await assert.rejects(
      publish({ files: { [`x.${ext}`]: { base64: b64(wrong) } } }),
      code('invalid_input'),
    );
  }
  await assert.rejects(
    publish({ content: '<svg/>', format: 'image', language: 'png' }),
    code('invalid_input'),
  );
  // A name is needed, and it must be an image name.
  await assert.rejects(
    publish({ content: b64(IMAGES.png), format: 'image' }),
    code('invalid_input'),
  );
  await assert.rejects(
    publish({ content: b64(IMAGES.png), format: 'image', language: 'bmp' }),
    code('invalid_input'),
  );
  await assert.rejects(
    publish({ content: b64(IMAGES.png), format: 'image', entry: '../x.png' }),
    code('invalid_input'),
  );
  await assert.rejects(
    publish({ content: 'not base64!', format: 'image', language: 'png' }),
    code('invalid_input'),
  );
  // One file only; images inside an html artifact are not checked as an image artifact.
  await assert.rejects(
    publish({ files: { 'a.png': { base64: b64(IMAGES.png) }, 'b.txt': 'x' }, entry: 'a.png' }),
    code('invalid_input'),
  );
  await publish({
    files: { 'index.html': '<img src="a.png">', 'a.png': { base64: 'AAAA' } },
    entry: 'index.html',
  });
});

test('list paginates newest first, filters by format, and hides deleted', async (t) => {
  const { artifacts } = setup(t);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const format = i % 2 === 0 ? 'html' : 'markdown';
    ids.push((await artifacts.publish({ title: `a${i}`, content: 'x', format }, 'a')).id);
  }
  // Touch the oldest so it moves to the top.
  await new Promise((resolve) => setImmediate(resolve));
  await artifacts.publish({ id: ids[0], title: 'a0 renamed' }, 'a');

  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await artifacts.list({ limit: 2, cursor });
    assert.ok(page.items.length <= 2);
    seen.push(...page.items.map((a) => a.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  const all = (await artifacts.list()).items;
  assert.deepEqual(
    all.map((a) => a.id),
    seen,
  );
  for (let i = 1; i < all.length; i++) {
    assert.ok((all[i - 1]?.updatedAt ?? '') >= (all[i]?.updatedAt ?? ''));
  }

  const html = await artifacts.list({ format: 'html' });
  assert.equal(html.items.length, 3);
  assert.ok(html.items.every((a) => a.format === 'html'));

  const victim = ids[1] ?? '';
  assert.equal(await artifacts.delete(victim), true);
  assert.equal(await artifacts.delete(victim), false);
  assert.equal(await artifacts.delete('missing'), false);
  assert.equal(
    (await artifacts.list()).items.some((a) => a.id === victim),
    false,
  );
  assert.equal(await artifacts.get(victim), null);
  assert.equal(await artifacts.listVersions(victim), null);
  assert.equal(await artifacts.readFile(victim, 1, 'README.md'), null);

  await assert.rejects(artifacts.list({ cursor: 'garbage' }), code('invalid_input'));
});

test('readFile only returns files of that version', async (t) => {
  const { artifacts } = setup(t);
  const { id } = await artifacts.publish(
    { title: 't', files: { 'index.html': 'v1', 'old.css': 'a{}' }, entry: 'index.html' },
    'a',
  );
  await artifacts.publish(
    { id, files: { 'index.html': 'v2', 'new.css': 'b{}' }, entry: 'index.html' },
    'a',
  );

  assert.equal(
    text((await artifacts.readFile(id, 1, 'index.html'))?.bytes ?? new Uint8Array()),
    'v1',
  );
  assert.equal(
    text((await artifacts.readFile(id, 2, 'index.html'))?.bytes ?? new Uint8Array()),
    'v2',
  );
  assert.equal(await artifacts.readFile(id, 2, 'old.css'), null);
  assert.equal(await artifacts.readFile(id, 1, 'new.css'), null);
  assert.equal(await artifacts.readFile(id, 3, 'index.html'), null);
  assert.equal(await artifacts.readFile(id, 1, '/index.html'), null);
  assert.equal(await artifacts.readFile(id, 1, '../index.html'), null);
});

test('tokens: create, verify, list, revoke', async (t) => {
  const { tokens } = setup(t);
  const { token, info } = await tokens.create('laptop');
  assert.match(token, /^aa_[A-Za-z0-9_-]{43}$/);
  assert.equal(info.lastUsedAt, null);

  const verified = await tokens.verify(token);
  assert.equal(verified?.id, info.id);
  assert.ok(verified?.lastUsedAt);
  assert.equal(await tokens.verify(`${token}x`), null);
  assert.equal(await tokens.verify('aa_nope'), null);
  assert.equal(await tokens.verify(''), null);

  assert.deepEqual(
    (await tokens.list()).map((i) => i.name),
    ['laptop'],
  );
  assert.equal(await tokens.revoke(info.id), true);
  assert.equal(await tokens.revoke(info.id), false);
  assert.equal(await tokens.verify(token), null);
  assert.deepEqual(await tokens.list(), []);
  await assert.rejects(tokens.create('  '), code('invalid_input'));
});

test('signer: round trip, tamper, expiry', async (t) => {
  const { signer } = setup(t);
  const url = new URL(signer.url('abc123', 2, 'img/a b#.png'));
  assert.equal(url.origin, 'https://content.example');
  const [, s, token, id, version, ...path] = url.pathname.split('/');
  assert.equal(s, 's');
  assert.equal(path.join('/'), 'img/a%20b%23.png');
  const [exp, sig] = (token ?? '').split('.');
  const expNum = Number(exp);
  assert.ok(expNum > Date.now() / 1000 + 3500);

  assert.equal(signer.verify(id ?? '', Number(version), expNum, sig ?? ''), true);
  assert.equal(signer.verify('abc124', 2, expNum, sig ?? ''), false);
  assert.equal(signer.verify('abc123', 3, expNum, sig ?? ''), false);
  assert.equal(signer.verify('abc123', 2, expNum + 1, sig ?? ''), false);
  assert.equal(signer.verify('abc123', 2, expNum, `${sig}A`), false);
  assert.equal(signer.verify('abc123', 2, expNum, ''), false);

  const expired = new URL(signer.url('abc123', 2, 'index.html', -10));
  const [expiredExp, expiredSig] = (expired.pathname.split('/')[2] ?? '').split('.');
  assert.equal(signer.verify('abc123', 2, Number(expiredExp), expiredSig ?? ''), false);
});
