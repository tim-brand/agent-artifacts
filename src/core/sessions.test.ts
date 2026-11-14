import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { Config } from '../config.ts';
import { SESSION_TOUCH_MS, SESSION_TTL_MS } from '../contracts.ts';
import { sha256Hex } from './ids.ts';
import { createCore } from './index.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-06-01T12:00:00.000Z');

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-sessions-'));
  const config: Config = {
    port: 0,
    trustedProxies: 1,
    dataDir: join(dir, 'data'),
    appOrigin: 'https://app.test',
    contentOrigin: 'https://content.test',
    signingSecret: 'x'.repeat(32),
    devUser: null,
    authEmailHeader: 'X-authentik-email',
    authNameHeader: 'X-authentik-name',
    authMode: 'proxy',
    authUsers: [],
  };
  const core = createCore(config);
  const db = new DatabaseSync(join(config.dataDir, 'artifacts.db'));
  t.after(() => {
    db.close();
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // The configured accounts, as the routes see them: email to the credential of its hash text.
  const accounts = new Map([['a@example.com', sha256Hex('hash-of-a')]]);
  const credentialOf = (email: string) => accounts.get(email) ?? null;
  const rows = () => db.prepare('SELECT * FROM sessions').all() as Record<string, string>[];
  return { ...core, accounts, credentialOf, rows };
}

test('a session is created, found, and stored only as a hash of its token', async (t) => {
  const { sessions, credentialOf, rows } = setup(t);
  const { token, maxAgeSeconds } = await sessions.create(
    'a@example.com',
    sha256Hex('hash-of-a'),
    T0,
  );
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(maxAgeSeconds, 30 * 24 * 3600);
  const [row] = rows();
  assert.equal(row?.token_hash, sha256Hex(token));
  assert.equal(row?.user_email, 'a@example.com');
  assert.equal(row?.credential, sha256Hex('hash-of-a'));
  assert.ok(!JSON.stringify(rows()).includes(token));
  assert.equal(row?.expires_at, new Date(T0 + SESSION_TTL_MS).toISOString());
  const found = await sessions.verify(token, credentialOf, T0 + 1000);
  assert.deepEqual(found, { email: 'a@example.com', renewed: false, maxAgeSeconds: 2592000 });
  // Unknown, malformed and empty tokens are no session.
  assert.equal(await sessions.verify('x'.repeat(43), credentialOf, T0), null);
  assert.equal(await sessions.verify('short', credentialOf, T0), null);
  assert.equal(await sessions.verify('', credentialOf, T0), null);
});

test('every sign-in makes a new token', async (t) => {
  const { sessions, rows } = setup(t);
  const a = await sessions.create('a@example.com', sha256Hex('hash-of-a'), T0);
  const b = await sessions.create('a@example.com', sha256Hex('hash-of-a'), T0);
  assert.notEqual(a.token, b.token);
  assert.equal(rows().length, 2);
});

test('the session slides: renewed after an hour of not being used, and not written before', async (t) => {
  const { sessions, credentialOf, rows } = setup(t);
  const { token } = await sessions.create('a@example.com', sha256Hex('hash-of-a'), T0);

  const soon = await sessions.verify(token, credentialOf, T0 + SESSION_TOUCH_MS - 1000);
  assert.equal(soon?.renewed, false);
  assert.equal(rows()[0]?.last_used_at, new Date(T0).toISOString());

  const later = T0 + SESSION_TOUCH_MS + 1000;
  const renewed = await sessions.verify(token, credentialOf, later);
  assert.equal(renewed?.renewed, true);
  assert.equal(renewed?.maxAgeSeconds, 2592000);
  assert.equal(rows()[0]?.last_used_at, new Date(later).toISOString());
  assert.equal(rows()[0]?.expires_at, new Date(later + SESSION_TTL_MS).toISOString());

  // Used again at once: no new write.
  const again = await sessions.verify(token, credentialOf, later + 1000);
  assert.equal(again?.renewed, false);
  assert.equal(rows()[0]?.last_used_at, new Date(later).toISOString());
});

test('a session expires 30 days after its last renewal', async (t) => {
  const { sessions, credentialOf, rows } = setup(t);
  const { token } = await sessions.create('a@example.com', sha256Hex('hash-of-a'), T0);
  assert.ok(await sessions.verify(token, credentialOf, T0 + 29 * DAY));
  // That use renewed it, so the clock starts again from day 29.
  assert.ok(await sessions.verify(token, credentialOf, T0 + 58 * DAY));
  assert.equal(await sessions.verify(token, credentialOf, T0 + 58 * DAY + SESSION_TTL_MS), null);
  assert.equal(rows().length, 0, 'an expired session is deleted when it is found');
});

test('an unused session expires at 30 days', async (t) => {
  const { sessions, credentialOf } = setup(t);
  const { token } = await sessions.create('a@example.com', sha256Hex('hash-of-a'), T0);
  assert.equal(await sessions.verify(token, credentialOf, T0 + 30 * DAY), null);
});

test('sign-out deletes the row', async (t) => {
  const { sessions, credentialOf, rows } = setup(t);
  const { token } = await sessions.create('a@example.com', sha256Hex('hash-of-a'), T0);
  await sessions.destroy(token);
  assert.equal(rows().length, 0);
  assert.equal(await sessions.verify(token, credentialOf, T0), null);
  await sessions.destroy(token); // twice is fine
  await sessions.destroy('nonsense');
});

test('removing the account from the configuration ends its sessions', async (t) => {
  const { sessions, accounts, credentialOf, rows } = setup(t);
  const { token } = await sessions.create('a@example.com', sha256Hex('hash-of-a'), T0);
  accounts.delete('a@example.com');
  assert.equal(await sessions.verify(token, credentialOf, T0 + 1000), null);
  assert.equal(rows().length, 0);
});

test('changing the password ends the sessions made with the old one', async (t) => {
  const { sessions, accounts, credentialOf } = setup(t);
  const { token } = await sessions.create('a@example.com', sha256Hex('hash-of-a'), T0);
  accounts.set('a@example.com', sha256Hex('new-hash-of-a'));
  assert.equal(await sessions.verify(token, credentialOf, T0 + 1000), null);
  // A session made after the change works.
  const fresh = await sessions.create('a@example.com', sha256Hex('new-hash-of-a'), T0 + 2000);
  assert.ok(await sessions.verify(fresh.token, credentialOf, T0 + 3000));
});

test("one account's session is not another's", async (t) => {
  const { sessions, accounts, credentialOf } = setup(t);
  accounts.set('b@example.com', sha256Hex('hash-of-b'));
  const a = await sessions.create('a@example.com', sha256Hex('hash-of-a'), T0);
  const b = await sessions.create('b@example.com', sha256Hex('hash-of-b'), T0);
  assert.equal((await sessions.verify(a.token, credentialOf, T0))?.email, 'a@example.com');
  assert.equal((await sessions.verify(b.token, credentialOf, T0))?.email, 'b@example.com');
});

test('the purge deletes expired sessions, through the core purge, and keeps the rest', async (t) => {
  const { sessions, purge, rows } = setup(t);
  await sessions.create('a@example.com', sha256Hex('hash-of-a'), T0 - 31 * DAY);
  await sessions.create('a@example.com', sha256Hex('hash-of-a'), T0 - 29 * DAY);
  assert.equal(rows().length, 2);
  await purge(T0);
  assert.equal(rows().length, 1);
  await purge(T0 + 2 * DAY);
  assert.equal(rows().length, 0);
});
