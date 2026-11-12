import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { AppError, type AskInput, type Comment } from '../contracts.ts';
import { createCore } from './index.ts';

const OWNER = { name: 'owner@example.com', typed: true };
const AGENT = { name: 'claude-laptop', typed: false };

const ASK: AskInput = {
  question: ' Which layout? ',
  options: [
    { id: 'two', label: 'Two columns', detail: ' Denser ' },
    { id: 'one', label: 'One column', detail: '  ' },
  ],
  recommended: { optionId: 'two', why: 'Fits the data' },
};

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-asks-'));
  const config: Config = {
    port: 0,
    dataDir: join(dir, 'data'),
    appOrigin: 'https://app.example',
    contentOrigin: 'https://content.example',
    signingSecret: 'x'.repeat(32),
    devUser: null,
  };
  let core = createCore(config);
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** Work on the database file directly, with the app closed. */
  const withDb = <T>(fn: (db: DatabaseSync) => T): T => {
    core.close();
    const db = new DatabaseSync(join(config.dataDir, 'artifacts.db'));
    try {
      return fn(db);
    } finally {
      db.close();
      core = createCore(config);
    }
  };
  return {
    get comments() {
      return core.comments;
    },
    get artifacts() {
      return core.artifacts;
    },
    purge: (now: number) => core.purge(now),
    publish: async (title = 'Doc') =>
      (await core.artifacts.publish({ title, content: '# Hi', format: 'markdown' }, 'agent')).id,
    withDb,
    count: (table: string) =>
      withDb((db) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n),
  };
}

const code = (c: AppError['code']) => (error: unknown) =>
  error instanceof AppError && error.code === c;

const askOf = (comments: Comment[]) => {
  const found = comments.find((c) => c.ask);
  if (!found?.ask) throw new Error('no ask');
  return { id: found.id, ask: found.ask, body: found.body };
};

test('an agent asks on a new thread or a reply; the body defaults to the question', async (t) => {
  const { comments, publish } = setup(t);
  const id = await publish();
  const thread = await comments.add({ artifactId: id, body: '', ask: ASK }, AGENT);
  const asked = askOf(thread.comments);
  assert.equal(asked.body, 'Which layout?');
  assert.deepEqual(asked.ask, {
    question: 'Which layout?',
    options: [
      { id: 'two', label: 'Two columns', detail: 'Denser' },
      { id: 'one', label: 'One column' },
    ],
    recommended: { optionId: 'two', why: 'Fits the data' },
    answer: null,
  });
  assert.equal(thread.comments[0]?.typed, false);

  const reply = await comments.add(
    {
      artifactId: id,
      threadId: thread.id,
      body: 'Also this:',
      ask: { ...ASK, recommended: undefined },
    },
    AGENT,
  );
  assert.equal(reply.comments.length, 2);
  assert.equal(reply.comments[1]?.body, 'Also this:');
  assert.equal(reply.comments[1]?.ask?.recommended, null);
  // A plain comment has no ask at all.
  const plain = await comments.add({ artifactId: id, body: 'note' }, OWNER);
  assert.equal('ask' in (plain.comments[0] ?? {}), false);
});

test('an ask is validated, and the owner cannot ask', async (t) => {
  const { comments, publish } = setup(t);
  const id = await publish();
  const refuse = (ask: unknown) =>
    assert.rejects(
      comments.add({ artifactId: id, body: 'x', ask: ask as AskInput }, AGENT),
      code('invalid_input'),
    );
  await refuse({ ...ASK, question: ' ' });
  await refuse({ ...ASK, question: 'q'.repeat(501) });
  await refuse({ ...ASK, options: [{ id: 'a', label: 'A' }] });
  await refuse({
    ...ASK,
    options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `O${i}` })),
  });
  await refuse({ ...ASK, options: 'two,one' });
  await refuse({
    ...ASK,
    options: [
      { id: 'a b', label: 'A' },
      { id: 'c', label: 'C' },
    ],
  });
  await refuse({
    ...ASK,
    options: [
      { id: 'a', label: 'A' },
      { id: 'a', label: 'B' },
    ],
  });
  await refuse({
    ...ASK,
    options: [
      { id: 'a', label: ' ' },
      { id: 'b', label: 'B' },
    ],
  });
  await refuse({ ...ASK, recommended: { optionId: 'nope', why: 'x' } });
  await refuse({ ...ASK, recommended: { optionId: 'two', why: '' } });
  await refuse(null);
  await assert.rejects(
    comments.add({ artifactId: id, body: 'x', ask: ASK }, OWNER),
    code('invalid_input'),
  );
  assert.deepEqual(await comments.list(id, 'all'), []);
});

test('an answer given with the question is dropped', async (t) => {
  const { comments, publish } = setup(t);
  const id = await publish();
  const forged = {
    ...ASK,
    answer: {
      optionId: 'two',
      label: 'Two columns',
      by: 'owner@example.com',
      at: 'x',
      typed: true,
    },
    options: ASK.options.map((o) => ({ ...o, answer: true, typed: true })),
  } as AskInput;
  const thread = await comments.add({ artifactId: id, body: 'x', ask: forged }, AGENT);
  const { ask } = askOf(thread.comments);
  assert.equal(ask.answer, null);
  assert.deepEqual(ask.options, [
    { id: 'two', label: 'Two columns', detail: 'Denser' },
    { id: 'one', label: 'One column' },
  ]);
  assert.deepEqual(await comments.openAskCounts([id]), { [id]: 1 });
});

test('the owner answers with an option of the ask, and can change it until resolved', async (t) => {
  const { comments, publish } = setup(t);
  const id = await publish();
  const thread = await comments.add({ artifactId: id, body: '', ask: ASK }, AGENT);
  const commentId = askOf(thread.comments).id;

  const answered = await comments.answer(id, commentId, 'one', 'owner@example.com');
  const { ask } = askOf(answered?.comments ?? []);
  assert.deepEqual(
    { ...ask.answer, at: undefined },
    {
      optionId: 'one',
      label: 'One column',
      by: 'owner@example.com',
      at: undefined,
      typed: true,
    },
  );
  assert.ok(answered && answered.updatedAt >= thread.updatedAt);
  assert.deepEqual(await comments.openAskCounts([id]), {});

  const changed = await comments.answer(id, commentId, 'two', 'owner@example.com');
  assert.equal(askOf(changed?.comments ?? []).ask.answer?.optionId, 'two');
  const listed = await comments.list(id);
  assert.equal(askOf(listed?.[0]?.comments ?? []).ask.answer?.label, 'Two columns');

  await assert.rejects(comments.answer(id, commentId, 'three', 'o'), code('invalid_input'));
  await assert.rejects(comments.answer(id, commentId, '', 'o'), code('invalid_input'));
  await comments.resolve(thread.id, true);
  await assert.rejects(comments.answer(id, commentId, 'one', 'o'), code('invalid_input'));
  assert.equal(
    askOf((await comments.list(id, 'all'))?.[0]?.comments ?? []).ask.answer?.optionId,
    'two',
  );
});

test('an answer needs the ask on that artifact, and a live artifact', async (t) => {
  const { comments, artifacts, publish } = setup(t);
  const id = await publish();
  const other = await publish('Other');
  const thread = await comments.add({ artifactId: id, body: 'plain' }, OWNER);
  const plainId = thread.comments[0]?.id ?? '';
  await assert.rejects(comments.answer(id, plainId, 'one', 'o'), code('not_found'));
  const asked = await comments.add(
    { artifactId: id, threadId: thread.id, body: '', ask: ASK },
    AGENT,
  );
  const commentId = askOf(asked.comments).id;
  assert.equal(await comments.answer(other, commentId, 'one', 'o'), null);
  assert.equal(await comments.answer(id, 'nope', 'one', 'o'), null);
  await artifacts.delete(id);
  assert.equal(await comments.answer(id, commentId, 'one', 'o'), null);
  assert.deepEqual(await comments.openAskCounts([id]), {});
});

test('open asks are counted per artifact, in the library and in the summary', async (t) => {
  const { comments, artifacts, publish, purge, count } = setup(t);
  const a = await publish('A');
  const b = await publish('B');
  const first = await comments.add({ artifactId: a, body: '', ask: ASK }, AGENT);
  await comments.add({ artifactId: a, threadId: first.id, body: '', ask: ASK }, AGENT);
  const resolved = await comments.add({ artifactId: b, body: '', ask: ASK }, AGENT);
  await comments.resolve(resolved.id, true);

  assert.deepEqual(await comments.openAskCounts([a, b, 'nope']), { [a]: 2 });
  assert.deepEqual(await comments.openAskCounts([]), {});
  assert.equal((await artifacts.summary()).openAsks, 2);
  const page = await artifacts.browse({ openAsks: true });
  assert.deepEqual(
    page.items.map((item) => [item.artifact.title, item.openAsks]),
    [['A', 2]],
  );
  assert.equal(await artifacts.count({ openAsks: true }), 1);
  assert.equal((await artifacts.browse({})).items.find((i) => i.artifact.id === b)?.openAsks, 0);

  await comments.answer(a, askOf(first.comments).id, 'one', 'owner@example.com');
  assert.equal((await artifacts.summary()).openAsks, 1);
  await artifacts.delete(a);
  assert.equal((await artifacts.summary()).openAsks, 0);
  assert.equal(await artifacts.count({ openAsks: true }), 0);

  // The purge takes the asks with their comments.
  assert.equal(count('asks'), 3);
  await purge(Date.now() + 31 * 86_400_000);
  assert.equal(count('asks'), 1);
});

test('the asks migration runs on an existing database', async (t) => {
  const ctx = setup(t);
  const id = await ctx.publish();
  await ctx.comments.add({ artifactId: id, body: 'from before' }, OWNER);
  // Back to the schema before asks, as on the deployed instance.
  ctx.withDb((db) =>
    db.exec(
      'DROP TABLE oauth_tokens; DROP TABLE oauth_codes; DROP TABLE oauth_grants; DROP TABLE oauth_clients; ' +
        'DROP TABLE asks; ALTER TABLE versions DROP COLUMN lines_added; ' +
        'ALTER TABLE versions DROP COLUMN lines_removed; PRAGMA user_version = 5',
    ),
  );
  const thread = await ctx.comments.add({ artifactId: id, body: '', ask: ASK }, AGENT);
  assert.equal(thread.comments[0]?.ask?.answer, null);
  assert.equal((await ctx.comments.list(id))?.length, 2);
});
