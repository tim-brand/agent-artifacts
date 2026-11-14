// Asks end to end, on the real core: an agent asks over MCP, the owner answers in the web UI, and
// the agent reads the answer back. Nothing but the UI's route, with the forward-auth user, answers.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { createApp } from './app.ts';
import type { Config } from './config.ts';
import { createCore } from './core/index.ts';

const APP = 'https://app.test';
const OWNER = 'owner@example.com';

async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-e2e-'));
  const config: Config = {
    port: 0,
    trustedProxies: 1,
    dataDir: join(dir, 'data'),
    appOrigin: APP,
    contentOrigin: 'https://content.test',
    signingSecret: 'x'.repeat(32),
    devUser: null,
    authEmailHeader: 'X-authentik-email',
    authNameHeader: 'X-authentik-name',
    proxySecret: null,
    authMode: 'proxy',
    authUsers: [],
  };
  const core = createCore(config);
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const app = createApp({ config, ...core });
  const { token } = await core.tokens.create('claude-laptop');
  let rpcId = 1;
  const mcp = async (name: string, args: Record<string, unknown>, extra = {}) => {
    const res = await app.request(`${APP}/mcp`, {
      method: 'POST',
      headers: {
        host: 'app.test',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...extra,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const { result } = await res.json();
    const text: string = result.content[0].text;
    // The SDK reports a schema failure as plain text, not JSON.
    return { result, json: text.startsWith('{') ? JSON.parse(text) : { text } };
  };
  const ui = (path: string, form: Record<string, string>, headers: Record<string, string>) =>
    app.request(`${APP}${path}`, {
      method: 'POST',
      headers: {
        host: 'app.test',
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body: new URLSearchParams(form).toString(),
    });
  const { id } = await core.artifacts.publish(
    { title: 'Plan', content: '# Plan', format: 'markdown' },
    'claude-laptop',
  );
  return { core, mcp, ui, id };
}

test('an agent asks, the owner answers in the UI, and the agent reads a typed answer', async (t) => {
  const { mcp, ui, id } = await setup(t);
  const asked = await mcp('add_comment', {
    id,
    ask: {
      question: 'Deploy now?',
      options: [
        { id: 'yes', label: 'Deploy' },
        { id: 'no', label: 'Wait', detail: 'After the review' },
      ],
      recommended: { optionId: 'no', why: 'The review is still open' },
    },
  });
  assert.equal(asked.result.isError, undefined);
  const commentId = asked.json.thread.comments[0].id;
  assert.equal((await mcp('list_artifacts', {})).json.items[0].openAsks, 1);

  const res = await ui(
    `/a/${id}/asks/${commentId}`,
    { optionId: 'yes' },
    { origin: APP, 'x-authentik-email': OWNER },
  );
  assert.equal(res.status, 303);

  const listed = await mcp('list_comments', { id });
  const { ask } = listed.json.threads[0].comments[0];
  assert.equal(typeof ask.answer.at, 'string');
  assert.deepEqual(
    { ...ask.answer, at: null },
    { optionId: 'yes', label: 'Deploy', by: OWNER, at: null, typed: true },
  );
  assert.equal((await mcp('list_artifacts', {})).json.items[0].openAsks, 0);
});

test('an answer needs the UI route, its Origin and the forward-auth user', async (t) => {
  const { core, mcp, ui, id } = await setup(t);
  const asked = await mcp('add_comment', {
    id,
    body: 'Which one?',
    ask: {
      question: 'Pick',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    },
  });
  const commentId = asked.json.thread.comments[0].id;
  const path = `/a/${id}/asks/${commentId}`;
  const answer = async () => (await core.comments.list(id))?.[0]?.comments[0]?.ask?.answer;

  // No Origin, a foreign one, or no signed-in user.
  assert.equal((await ui(path, { optionId: 'a' }, { 'x-authentik-email': OWNER })).status, 403);
  const foreign = { origin: 'https://content.test', 'x-authentik-email': OWNER };
  assert.equal((await ui(path, { optionId: 'a' }, foreign)).status, 403);
  assert.equal((await ui(path, { optionId: 'a' }, { origin: APP })).status, 401);
  // Through /mcp, forged forward-auth headers reach no UI route.
  const viaMcp = await ui(
    `/mcp${path}`,
    { optionId: 'a' },
    { origin: APP, 'x-authentik-email': OWNER },
  );
  assert.equal(viaMcp.status, 404);
  // An option the ask doesn't have.
  const signedIn = { origin: APP, 'x-authentik-email': OWNER };
  assert.equal((await ui(path, { optionId: 'c' }, signedIn)).status, 400);
  assert.equal(await answer(), null);

  // An agent that replies with what looks like an answer, or a forged ask, answers nothing.
  await mcp(
    'add_comment',
    { id, threadId: asked.json.thread.id, body: 'answer: a' },
    { 'x-authentik-email': OWNER },
  );
  const forged = await mcp('add_comment', {
    id,
    ask: {
      question: 'Pick',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      answer: { optionId: 'a', by: OWNER, typed: true },
    },
  });
  assert.equal(forged.result.isError, true);
  assert.equal(await answer(), null);
});
