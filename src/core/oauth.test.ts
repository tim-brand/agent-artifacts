import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  type AuthorizeParams,
  type AuthorizeRequest,
  OAuthError,
  type OAuthErrorCode,
} from '../contracts.ts';
import { redirectUriMatches, redirectUriProblem, s256 } from '../oauth/rules.ts';
import { createBlobStore } from './blobs.ts';
import { openDb } from './db.ts';
import { createOAuthService } from './oauth.ts';

const APP = 'https://app.example';
const RESOURCE = `${APP}/mcp`;
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = s256(VERIFIER);
const REDIRECT = 'http://127.0.0.1:33418/callback';
const USER = 'owner@example.com';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-oauth-'));
  const db = openDb(dir, createBlobStore(join(dir, 'blobs')));
  let time = Date.parse('2026-06-01T12:00:00.000Z');
  const oauth = createOAuthService(db, APP, () => time);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const advance = (ms: number) => {
    time += ms;
  };

  const client = (redirectUris: string[] = [REDIRECT], clientName = 'Claude Code') =>
    oauth.register({ clientName, redirectUris });

  const params = (clientId: string, extra: AuthorizeParams = {}): AuthorizeParams => ({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: RESOURCE,
    ...extra,
  });

  const request = async (clientId: string, extra: AuthorizeParams = {}) => {
    const check = await oauth.checkAuthorize(params(clientId, extra));
    assert.ok(check.ok, JSON.stringify(check));
    return check.request;
  };

  /** Consent, code and token exchange: a signed-in client. */
  const signIn = async (clientId?: string) => {
    const id = clientId ?? (await client()).id;
    const code = await oauth.createCode(await request(id), USER);
    const tokens = await oauth.exchangeCode({
      code,
      clientId: id,
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
    });
    return { clientId: id, code, tokens };
  };

  return { db, oauth, advance, client, params, request, signIn };
}

const fails = (code: OAuthErrorCode, pattern?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof OAuthError, String(error));
  assert.equal(error.code, code);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

// ---- Registration ----

test('registers public clients with loopback or https redirect URIs', async (t) => {
  const { oauth } = setup(t);
  const uris = [
    'http://127.0.0.1:8080/callback',
    'http://localhost/cb',
    'http://[::1]:9000/oauth/callback?x=1',
    'https://example.com/callback',
  ];
  const client = await oauth.register({ clientName: ' Claude\u0007 Code ', redirectUris: uris });
  assert.match(client.id, /^[0-9A-Za-z]{24}$/);
  assert.equal(client.name, 'Claude Code');
  assert.deepEqual(client.redirectUris, uris);
  assert.deepEqual(await oauth.getClient(client.id), client);
  assert.equal((await oauth.register({ redirectUris: uris })).name, 'MCP client');
  assert.equal(
    (await oauth.register({ clientName: 'x'.repeat(300), redirectUris: uris })).name.length,
    100,
  );
});

test('refuses other redirect URIs', async (t) => {
  const { oauth } = setup(t);
  for (const uris of [
    [],
    'http://127.0.0.1/cb',
    ['http://example.com/callback'],
    ['http://127.0.0.2/callback'],
    ['http://localhost.evil.com/cb'],
    ['http://127.0.0.1.evil.com/cb'],
    ['https://example.com/cb#frag'],
    ['https://user:pw@example.com/cb'],
    ['javascript:alert(1)'],
    ['cursor://callback'],
    ['/relative'],
    ['https://example.com/a b'],
    [42],
    Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`),
  ]) {
    await assert.rejects(
      oauth.register({ clientName: 'x', redirectUris: uris }),
      fails('invalid_redirect_uri'),
      JSON.stringify(uris),
    );
  }
});

test('redirect URIs match exactly, except a loopback port (RFC 8252)', () => {
  assert.ok(redirectUriMatches('https://a.example/cb', 'https://a.example/cb'));
  assert.ok(!redirectUriMatches('https://a.example/cb', 'https://a.example/cb/'));
  assert.ok(!redirectUriMatches('https://a.example/cb', 'https://a.example:8443/cb'));
  assert.ok(!redirectUriMatches('https://a.example/cb', 'https://A.example/cb'));
  assert.ok(redirectUriMatches('http://127.0.0.1:1000/cb', 'http://127.0.0.1:2000/cb'));
  assert.ok(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1:2000/cb'));
  assert.ok(redirectUriMatches('http://localhost:1/cb', 'http://localhost:65535/cb'));
  assert.ok(redirectUriMatches('http://[::1]:1/cb', 'http://[::1]:2/cb'));
  assert.ok(!redirectUriMatches('http://127.0.0.1:1000/cb', 'http://127.0.0.1:2000/cb2'));
  assert.ok(!redirectUriMatches('http://127.0.0.1:1000/cb', 'http://localhost:1000/cb'));
  assert.ok(!redirectUriMatches('http://127.0.0.1:1000/cb', 'http://127.0.0.1:2000/cb?x=1'));
  assert.ok(!redirectUriMatches('http://127.0.0.1:1000/cb', 'http://127.0.0.1:99999/cb'));
  assert.equal(redirectUriProblem('http://127.0.0.1:1234/cb'), null);
});

// ---- Authorization requests ----

test('an unknown client or a mismatched redirect_uri gets an error page, not a redirect', async (t) => {
  const { oauth, client, params } = setup(t);
  const { id } = await client(['http://127.0.0.1:1/callback', 'http://localhost:1/callback']);
  for (const p of [
    { ...params(id), client_id: undefined },
    params('unknown'),
    params(id, { redirect_uri: 'https://evil.example/callback' }),
    params(id, { redirect_uri: 'http://127.0.0.1:5/other' }),
    // Two registered: redirect_uri can't be left out.
    params(id, { redirect_uri: undefined }),
  ]) {
    const check = await oauth.checkAuthorize(p);
    assert.equal(check.ok, false);
    assert.equal(!check.ok && check.redirect, null, JSON.stringify(p));
  }
});

test('a loopback redirect_uri may use any port; the only registered one is the default', async (t) => {
  const { oauth, client, params } = setup(t);
  const { id } = await client(['http://127.0.0.1:1/callback']);
  const check = await oauth.checkAuthorize(
    params(id, { redirect_uri: 'http://127.0.0.1:54321/callback' }),
  );
  assert.ok(check.ok);
  assert.equal(check.request.redirectUri, 'http://127.0.0.1:54321/callback');
  assert.equal(check.request.redirectUriGiven, true);

  const omitted = await oauth.checkAuthorize(params(id, { redirect_uri: undefined }));
  assert.ok(omitted.ok);
  assert.equal(omitted.request.redirectUri, 'http://127.0.0.1:1/callback');
  assert.equal(omitted.request.redirectUriGiven, false);
});

test('requires response_type code and PKCE S256, redirecting back with the error', async (t) => {
  const { oauth, client, params } = setup(t);
  const { id } = await client();
  const cases: [AuthorizeParams, OAuthErrorCode][] = [
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ response_type: undefined }, 'unsupported_response_type'],
    [{ code_challenge: undefined }, 'invalid_request'],
    [{ code_challenge_method: undefined }, 'invalid_request'],
    [{ code_challenge_method: 'plain', code_challenge: VERIFIER }, 'invalid_request'],
    [{ code_challenge: 'short' }, 'invalid_request'],
    [{ code_challenge: `${'a'.repeat(42)}!` }, 'invalid_request'],
    [{ state: 'x'.repeat(1001) }, 'invalid_request'],
  ];
  for (const [extra, error] of cases) {
    const check = await oauth.checkAuthorize(params(id, extra));
    assert.ok(!check.ok && check.redirect === REDIRECT, JSON.stringify(extra));
    assert.equal(check.error, error, JSON.stringify(extra));
    assert.equal(check.state, extra.state ? null : 'st-1');
  }
});

test('resource must be the MCP endpoint (RFC 8707); left out, it is', async (t) => {
  const { oauth, client, params } = setup(t);
  const { id } = await client();
  for (const resource of [
    'https://app.example',
    'https://app.example/',
    'https://app.example/mcp/x',
    'https://app.example/mcp?x=1',
    'https://app.example/mcp#x',
    'https://other.example/mcp',
    'http://app.example/mcp',
    'not a url',
  ]) {
    const check = await oauth.checkAuthorize(params(id, { resource }));
    assert.ok(!check.ok && check.redirect, resource);
    assert.equal(check.error, 'invalid_target', resource);
  }
  for (const resource of [RESOURCE, 'HTTPS://APP.EXAMPLE/mcp', `${RESOURCE}/`, undefined]) {
    const check = await oauth.checkAuthorize(params(id, { resource }));
    assert.ok(check.ok, String(resource));
    assert.equal(check.request.resource, RESOURCE);
  }
});

// ---- Codes ----

test('a code gives an access and a refresh token, stored only as hashes', async (t) => {
  const { db, oauth, signIn } = setup(t);
  const { code, tokens } = await signIn();
  assert.match(tokens.accessToken, /^aat_[A-Za-z0-9_-]{43}$/);
  assert.match(tokens.refreshToken, /^aar_[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.expiresIn, 3600);
  const access = await oauth.verifyAccess(tokens.accessToken, RESOURCE);
  assert.equal(access?.clientName, 'Claude Code');
  assert.equal(access?.user, USER);

  const dump = JSON.stringify(
    ['oauth_codes', 'oauth_tokens', 'oauth_grants', 'oauth_clients'].map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    ),
  );
  for (const plain of [code, tokens.accessToken, tokens.refreshToken, VERIFIER]) {
    assert.ok(!dump.includes(plain));
  }
  assert.ok(!dump.includes(code.slice(4)));
});

test('the code_verifier must match the challenge, and a wrong one burns the code', async (t) => {
  const { oauth, client, request } = setup(t);
  const { id } = await client();
  const code = await oauth.createCode(await request(id), USER);
  const exchange = (codeVerifier?: string) =>
    oauth.exchangeCode({ code, clientId: id, redirectUri: REDIRECT, codeVerifier });
  await assert.rejects(exchange(undefined), fails('invalid_request'));
  await assert.rejects(exchange('w'.repeat(43)), fails('invalid_grant', /code_verifier/));
  await assert.rejects(exchange(VERIFIER), fails('invalid_grant', /already used/));
});

test('PKCE plain is refused: the verifier itself is not a valid challenge', async (t) => {
  const { oauth, client, request } = setup(t);
  const { id } = await client();
  // An S256 request whose challenge is the verifier itself, as plain would send.
  const code = await oauth.createCode(await request(id, { code_challenge: VERIFIER }), USER);
  await assert.rejects(
    oauth.exchangeCode({ code, clientId: id, redirectUri: REDIRECT, codeVerifier: VERIFIER }),
    fails('invalid_grant'),
  );
});

test('a code works once; reusing it revokes the grant it made', async (t) => {
  const { oauth, signIn } = setup(t);
  const { clientId, code, tokens } = await signIn();
  await assert.rejects(
    oauth.exchangeCode({ code, clientId, redirectUri: REDIRECT, codeVerifier: VERIFIER }),
    fails('invalid_grant', /already used/),
  );
  assert.equal(await oauth.verifyAccess(tokens.accessToken, RESOURCE), null);
  await assert.rejects(
    oauth.refresh({ refreshToken: tokens.refreshToken, clientId }),
    fails('invalid_grant'),
  );
  assert.deepEqual(await oauth.listGrants(), []);
});

test('a code expires after 60 seconds', async (t) => {
  const { oauth, client, request, advance } = setup(t);
  const { id } = await client();
  const late = await oauth.createCode(await request(id), USER);
  const onTime = await oauth.createCode(await request(id), USER);
  advance(59_000);
  await oauth.exchangeCode({
    code: onTime,
    clientId: id,
    redirectUri: REDIRECT,
    codeVerifier: VERIFIER,
  });
  advance(1_000);
  await assert.rejects(
    oauth.exchangeCode({ code: late, clientId: id, redirectUri: REDIRECT, codeVerifier: VERIFIER }),
    fails('invalid_grant', /expired/),
  );
});

test('the code is bound to its client, redirect_uri and resource', async (t) => {
  const { oauth, client, request } = setup(t);
  const { id } = await client();
  const other = await client();
  const fresh = async () => oauth.createCode(await request(id), USER);
  const base = { clientId: id, redirectUri: REDIRECT, codeVerifier: VERIFIER };
  await assert.rejects(
    oauth.exchangeCode({ ...base, code: await fresh(), clientId: other.id }),
    fails('invalid_grant', /another client/),
  );
  await assert.rejects(
    oauth.exchangeCode({ ...base, code: await fresh(), redirectUri: undefined }),
    fails('invalid_grant', /redirect_uri/),
  );
  await assert.rejects(
    oauth.exchangeCode({
      ...base,
      code: await fresh(),
      redirectUri: 'http://127.0.0.1:1/callback',
    }),
    fails('invalid_grant', /redirect_uri/),
  );
  await assert.rejects(
    oauth.exchangeCode({ ...base, code: await fresh(), resource: 'https://other.example/mcp' }),
    fails('invalid_target'),
  );
  await assert.rejects(oauth.exchangeCode({ ...base, code: 'aac_nope' }), fails('invalid_grant'));
});

test('without redirect_uri in the request, the token request may leave it out', async (t) => {
  const { oauth, client, request } = setup(t);
  const { id } = await client();
  const req: AuthorizeRequest = await request(id, { redirect_uri: undefined });
  const code = await oauth.createCode(req, USER);
  const tokens = await oauth.exchangeCode({ code, clientId: id, codeVerifier: VERIFIER });
  assert.ok(await oauth.verifyAccess(tokens.accessToken, RESOURCE));
});

// ---- Tokens ----

test('refresh rotates the refresh token; reusing an old one revokes the grant', async (t) => {
  const { oauth, signIn } = setup(t);
  const { clientId, tokens } = await signIn();
  const next = await oauth.refresh({
    refreshToken: tokens.refreshToken,
    clientId,
    resource: RESOURCE,
  });
  assert.notEqual(next.refreshToken, tokens.refreshToken);
  assert.notEqual(next.accessToken, tokens.accessToken);
  assert.ok(await oauth.verifyAccess(next.accessToken, RESOURCE));

  await assert.rejects(
    oauth.refresh({ refreshToken: tokens.refreshToken, clientId }),
    fails('invalid_grant', /already used/),
  );
  // The whole grant is gone: the new tokens too.
  assert.equal(await oauth.verifyAccess(next.accessToken, RESOURCE), null);
  await assert.rejects(
    oauth.refresh({ refreshToken: next.refreshToken, clientId }),
    fails('invalid_grant'),
  );
  assert.deepEqual(await oauth.listGrants(), []);
});

test('refresh checks the client and the resource', async (t) => {
  const { oauth, client, signIn } = setup(t);
  const { clientId, tokens } = await signIn();
  const other = await client();
  await assert.rejects(
    oauth.refresh({ refreshToken: tokens.refreshToken, clientId: other.id }),
    fails('invalid_grant', /another client/),
  );
  await assert.rejects(
    oauth.refresh({
      refreshToken: tokens.refreshToken,
      clientId,
      resource: 'https://x.example/mcp',
    }),
    fails('invalid_target'),
  );
  await assert.rejects(oauth.refresh({ refreshToken: '', clientId }), fails('invalid_request'));
  await assert.rejects(
    oauth.refresh({ refreshToken: 'aar_nope', clientId }),
    fails('invalid_grant'),
  );
});

test('access tokens last an hour, refresh tokens 30 days from their last use', async (t) => {
  const { oauth, signIn, advance } = setup(t);
  const { clientId, tokens } = await signIn();
  advance(3_599_000);
  assert.ok(await oauth.verifyAccess(tokens.accessToken, RESOURCE));
  advance(1_000);
  assert.equal(await oauth.verifyAccess(tokens.accessToken, RESOURCE), null);

  const next = await oauth.refresh({ refreshToken: tokens.refreshToken, clientId });
  advance(30 * 86_400_000 - 1_000);
  assert.equal((await oauth.listGrants()).length, 1);
  advance(1_000);
  assert.deepEqual(await oauth.listGrants(), []);
  await assert.rejects(
    oauth.refresh({ refreshToken: next.refreshToken, clientId }),
    fails('invalid_grant', /expired/),
  );
});

test('an access token only works for the resource it was issued for', async (t) => {
  const { db, oauth, signIn } = setup(t);
  const { tokens } = await signIn();
  assert.equal(await oauth.verifyAccess(tokens.accessToken, 'https://other.example/mcp'), null);
  db.exec(`UPDATE oauth_grants SET resource = 'https://other.example/mcp'`);
  assert.equal(await oauth.verifyAccess(tokens.accessToken, RESOURCE), null);
  assert.equal(await oauth.verifyAccess('aa_pat', RESOURCE), null);
  assert.equal(await oauth.verifyAccess('aat_unknown', RESOURCE), null);
});

test('grants are listed, revoked with their tokens, and replaced by signing in again', async (t) => {
  const { oauth, signIn, advance } = setup(t);
  const first = await signIn();
  advance(1_000);
  const [grant] = await oauth.listGrants();
  assert.equal(grant?.clientName, 'Claude Code');
  assert.equal(grant?.user, USER);
  assert.equal(grant?.lastUsedAt, null);
  await oauth.verifyAccess(first.tokens.accessToken, RESOURCE);
  assert.ok((await oauth.listGrants())[0]?.lastUsedAt);

  // The same client signs in again: one grant, the new one.
  const again = await signIn(first.clientId);
  const grants = await oauth.listGrants();
  assert.equal(grants.length, 1);
  assert.notEqual(grants[0]?.id, grant?.id);
  assert.equal(await oauth.verifyAccess(first.tokens.accessToken, RESOURCE), null);

  // Another client is a grant of its own.
  const other = await signIn();
  assert.equal((await oauth.listGrants()).length, 2);

  assert.equal(await oauth.revokeGrant(grants[0]?.id ?? ''), true);
  assert.equal(await oauth.revokeGrant(grants[0]?.id ?? ''), false);
  assert.equal(await oauth.verifyAccess(again.tokens.accessToken, RESOURCE), null);
  await assert.rejects(
    oauth.refresh({ refreshToken: again.tokens.refreshToken, clientId: first.clientId }),
    fails('invalid_grant'),
  );
  assert.ok(await oauth.verifyAccess(other.tokens.accessToken, RESOURCE));
});

test('purge drops expired codes and tokens, ended grants and clients unused for 30 days', async (t) => {
  const { db, oauth, client, signIn, advance } = setup(t);
  const unused = await client();
  const used = await signIn();
  const count = (table: string) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  advance(2 * 3_600_000);
  oauth.purge();
  assert.equal(count('oauth_tokens'), 1); // the refresh token
  assert.equal(count('oauth_clients'), 2);

  advance(15 * 86_400_000);
  await oauth.refresh({ refreshToken: used.tokens.refreshToken, clientId: used.clientId });
  advance(15 * 86_400_000);
  oauth.purge();
  assert.equal(await oauth.getClient(unused.id), null);
  assert.ok(await oauth.getClient(used.clientId));
  assert.equal(count('oauth_codes'), 0);
  assert.equal(count('oauth_tokens'), 1); // the new refresh token; the rotated one expired
  assert.equal((await oauth.listGrants()).length, 1);

  advance(31 * 86_400_000);
  oauth.purge();
  assert.equal(count('oauth_grants'), 0);
  assert.equal(count('oauth_tokens'), 0);
  assert.equal(await oauth.getClient(used.clientId), null);
});
