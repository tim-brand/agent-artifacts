import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createApp } from '../app.ts';
import type { Config } from '../config.ts';
import { createCore } from '../core/index.ts';
import { s256 } from './rules.ts';

const APP = 'https://app.test';
const MCP = `${APP}/mcp`;
const USER = { 'X-authentik-email': 'owner@example.com' };
const REDIRECT = 'http://127.0.0.1:41999/callback';
const VERIFIER = 'a-very-long-code-verifier-of-at-least-43-characters';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-flow-'));
  const config: Config = {
    port: 0,
    trustedProxies: 1,
    dataDir: dir,
    appOrigin: APP,
    contentOrigin: 'https://content.test',
    signingSecret: 'x'.repeat(32),
    devUser: null,
    authEmailHeader: 'X-authentik-email',
    authNameHeader: 'X-authentik-name',
    authMode: 'proxy',
    authUsers: [],
  };
  const core = createCore(config);
  const app = createApp({ config, ...core });
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('host', new URL(APP).host);
    return app.request(`${APP}${path}`, { ...init, headers });
  };
  return { app, core, request };
}

type Request = ReturnType<typeof setup>['request'];

const form = (body: Record<string, string>, ip = '10.0.0.1') => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
  body: new URLSearchParams(body).toString(),
});

let rpcId = 1;
const mcp = (request: Request, token: string | null, method = 'tools/list', params = {}) =>
  request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });

async function register(request: Request, body: Record<string, unknown> = {}, ip = '10.0.0.1') {
  return request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [REDIRECT], ...body }),
  });
}

const authorizeQuery = (clientId: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: s256(VERIFIER),
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: MCP,
    ...extra,
  });

/** The consent form's POST, as the browser sends it. */
const consent = (request: Request, query: URLSearchParams, decision: string, origin = APP) =>
  request('/oauth/authorize', {
    method: 'POST',
    headers: {
      ...USER,
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin ? { origin } : {}),
    },
    body: new URLSearchParams([...query, ['decision', decision]]).toString(),
  });

/** Register, allow, and trade the code: what a client does on sign-in. */
async function signIn(request: Request, clientId?: string) {
  const id = clientId ?? (await (await register(request)).json()).client_id;
  const allowed = await consent(request, authorizeQuery(id), 'allow');
  const code = new URL(allowed.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const res = await request(
    '/oauth/token',
    form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: id,
      code_verifier: VERIFIER,
      resource: MCP,
    }),
  );
  assert.equal(res.status, 200);
  return { clientId: id as string, tokens: await res.json() };
}

describe('the full sign-in', () => {
  it('discovery, registration, consent, tokens, MCP, refresh and revoke', async (t) => {
    const { request } = setup(t);

    // 1. The client tries /mcp and learns where the metadata is.
    const denied = await mcp(request, null);
    assert.equal(denied.status, 401);
    const challenge = denied.headers.get('www-authenticate') ?? '';
    const metadataUrl = challenge.match(/resource_metadata="([^"]+)"/)?.[1] ?? '';
    assert.equal(metadataUrl, `${APP}/.well-known/oauth-protected-resource`);

    // 2. Protected resource metadata (RFC 9728), at the root and with the /mcp suffix.
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await request(path);
      assert.equal(res.status, 200, path);
      const prm = await res.json();
      assert.equal(prm.resource, MCP);
      assert.deepEqual(prm.authorization_servers, [APP]);
    }

    // 3. Authorization server metadata (RFC 8414).
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/mcp',
    ]) {
      const as = await (await request(path)).json();
      assert.equal(as.issuer, APP);
      assert.equal(as.authorization_endpoint, `${APP}/oauth/authorize`);
      assert.equal(as.token_endpoint, `${APP}/oauth/token`);
      assert.equal(as.registration_endpoint, `${APP}/oauth/register`);
      assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
      assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
      assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
      assert.equal(as.authorization_response_iss_parameter_supported, true);
    }

    // 4. Dynamic client registration (RFC 7591): always a public client.
    const registered = await register(request, {
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
    });
    assert.equal(registered.status, 201);
    const client = await registered.json();
    assert.equal(client.token_endpoint_auth_method, 'none');
    assert.equal(client.client_secret, undefined);
    assert.deepEqual(client.redirect_uris, [REDIRECT]);
    assert.equal(client.client_name, 'Test Client');

    // 5. The consent page, behind forward auth, with the loopback port of this sign-in.
    const redirect = 'http://127.0.0.1:52000/callback';
    const query = authorizeQuery(client.client_id, { redirect_uri: redirect });
    const page = await request(`/oauth/authorize?${query}`, { headers: USER });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<h1>Connect Test Client\?<\/h1>/);
    assert.match(html, /127\.0\.0\.1:52000/);
    assert.match(html, /an app on this computer/);
    assert.match(html, /<input type="hidden" name="code_challenge" value="[^"]+">/);
    assert.match(
      page.headers.get('content-security-policy') ?? '',
      /form-action 'self' http:\/\/127\.0\.0\.1:52000;/,
    );
    assert.equal(page.headers.get('x-frame-options'), 'DENY');

    // 6. The consent POST needs the app Origin.
    assert.equal((await consent(request, query, 'allow', '')).status, 403);
    assert.equal((await consent(request, query, 'allow', 'https://evil.test')).status, 403);

    // 7. Allow: back to the client with the code, the state and the issuer (RFC 9207).
    const allowed = await consent(request, query, 'allow');
    assert.equal(allowed.status, 303);
    const back = new URL(allowed.headers.get('location') ?? '');
    assert.equal(`${back.origin}${back.pathname}`, redirect);
    assert.equal(back.searchParams.get('state'), 'xyz');
    assert.equal(back.searchParams.get('iss'), APP);
    const code = back.searchParams.get('code') ?? '';
    assert.match(code, /^aac_/);

    // 8. The token request, with PKCE and the resource.
    const tokenRes = await request(
      '/oauth/token',
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        client_id: client.client_id,
        code_verifier: VERIFIER,
        resource: MCP,
      }),
    );
    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.headers.get('cache-control'), 'no-store');
    const tokens = await tokenRes.json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, 3600);
    assert.match(tokens.access_token, /^aat_/);
    assert.match(tokens.refresh_token, /^aar_/);

    // 9. MCP with the access token; publishes are by the client's name.
    const list = await mcp(request, tokens.access_token);
    assert.equal(list.status, 200);
    const tools = (await list.json()).result.tools.map((x: { name: string }) => x.name);
    assert.ok(tools.includes('publish_artifact'));
    const published = await mcp(request, tokens.access_token, 'tools/call', {
      name: 'publish_artifact',
      arguments: { title: 'Hi', content: '# Hi', format: 'markdown' },
    });
    const { id } = (await published.json()).result.structuredContent;
    const versions = await mcp(request, tokens.access_token, 'tools/call', {
      name: 'list_versions',
      arguments: { id },
    });
    assert.equal(
      (await versions.json()).result.structuredContent.versions[0].publishedBy,
      'Test Client',
    );

    // 10. Refresh rotates; the old refresh token is refused, and that ends the grant.
    const refreshed = await request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
        resource: MCP,
      }),
    );
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json();
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    assert.equal((await mcp(request, next.access_token)).status, 200);
    const reused = await request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }),
    );
    assert.equal(reused.status, 400);
    assert.equal((await reused.json()).error, 'invalid_grant');
    assert.equal((await mcp(request, next.access_token)).status, 401);

    // 11. Sign in again, then revoke it on the Connections page.
    const again = await signIn(request, client.client_id);
    assert.equal((await mcp(request, again.tokens.access_token)).status, 200);
    const connections = await (await request('/settings/connections', { headers: USER })).text();
    const grantId = connections.match(/\/settings\/connections\/([^/]+)\/revoke/)?.[1] ?? '';
    assert.match(connections, /Test Client/);
    const revoked = await request(`/settings/connections/${grantId}/revoke`, {
      method: 'POST',
      headers: { ...USER, origin: APP },
    });
    assert.equal(revoked.status, 303);
    const after = await mcp(request, again.tokens.access_token);
    assert.equal(after.status, 401);
    assert.match(after.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
  });

  it('deny goes back to the client with access_denied', async (t) => {
    const { request } = setup(t);
    const { client_id } = await (await register(request)).json();
    const res = await consent(request, authorizeQuery(client_id), 'deny');
    assert.equal(res.status, 303);
    const back = new URL(res.headers.get('location') ?? '');
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('state'), 'xyz');
    assert.equal(back.searchParams.get('iss'), APP);
    assert.equal(back.searchParams.get('code'), null);
  });

  it('the consent POST is checked again, not trusted', async (t) => {
    const { request } = setup(t);
    const { client_id } = await (await register(request)).json();
    const tampered = authorizeQuery(client_id, { redirect_uri: 'https://evil.test/cb' });
    const res = await consent(request, tampered, 'allow');
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
    const plain = authorizeQuery(client_id, { code_challenge_method: 'plain' });
    const back = new URL((await consent(request, plain, 'allow')).headers.get('location') ?? '');
    assert.equal(back.searchParams.get('error'), 'invalid_request');
    assert.equal(back.searchParams.get('code'), null);
  });

  it('an unknown client or a foreign redirect_uri gets an error page, never a redirect', async (t) => {
    const { request } = setup(t);
    const { client_id } = await (await register(request)).json();
    for (const query of [
      authorizeQuery('nope'),
      authorizeQuery(client_id, { redirect_uri: 'https://evil.test/cb' }),
    ]) {
      const res = await request(`/oauth/authorize?${query}`, { headers: USER });
      assert.equal(res.status, 400);
      assert.equal(res.headers.get('location'), null);
      assert.match(await res.text(), /Cannot connect this app/);
    }
  });

  it('other request errors redirect back with error, state and iss', async (t) => {
    const { request } = setup(t);
    const { client_id } = await (await register(request)).json();
    for (const [extra, error] of [
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ resource: 'https://other.test/mcp' }, 'invalid_target'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ] as const) {
      const res = await request(`/oauth/authorize?${authorizeQuery(client_id, extra)}`, {
        headers: USER,
      });
      assert.equal(res.status, 303);
      const back = new URL(res.headers.get('location') ?? '');
      assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
      assert.equal(back.searchParams.get('error'), error);
      assert.equal(back.searchParams.get('state'), 'xyz');
      assert.equal(back.searchParams.get('iss'), APP);
    }
  });

  it('the consent page needs the forward-auth user', async (t) => {
    const { request } = setup(t);
    const { client_id } = await (await register(request)).json();
    const res = await request(`/oauth/authorize?${authorizeQuery(client_id)}`);
    assert.equal(res.status, 401);
  });
});

describe('public endpoints', () => {
  it('answer without forward auth, and only with their methods', async (t) => {
    const { request } = setup(t);
    assert.equal((await request('/.well-known/oauth-authorization-server')).status, 200);
    assert.equal(
      (await request('/.well-known/oauth-protected-resource', { method: 'POST' })).status,
      405,
    );
    assert.equal((await request('/oauth/register')).status, 405);
    assert.equal((await request('/oauth/token')).status, 405);
    // Other well-known paths are the UI's, so behind forward auth.
    assert.equal((await request('/.well-known/openid-configuration')).status, 401);
  });

  it('registration refuses bad metadata with RFC 7591 errors', async (t) => {
    const { request } = setup(t);
    const cases: [Record<string, unknown> | string, string][] = [
      ['not json', 'invalid_client_metadata'],
      ['[1]', 'invalid_client_metadata'],
      [{ redirect_uris: ['http://evil.test/cb'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: [] }, 'invalid_redirect_uri'],
      [{ redirect_uris: undefined }, 'invalid_redirect_uri'],
      [{ grant_types: ['client_credentials'] }, 'invalid_client_metadata'],
      [{ response_types: ['token'] }, 'invalid_client_metadata'],
    ];
    for (const [body, error] of cases) {
      const res =
        typeof body === 'string'
          ? await request('/oauth/register', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.1.1' },
              body,
            })
          : await register(request, body, '10.1.1.2');
      assert.equal(res.status, 400, JSON.stringify(body));
      const json = await res.json();
      assert.equal(json.error, error, JSON.stringify(body));
      assert.equal(typeof json.error_description, 'string');
    }
  });

  it('limits a body by the bytes read, with or without Content-Length', async (t) => {
    const { request } = setup(t);
    const chunk = new TextEncoder().encode(`{"client_name":"${'a'.repeat(1024)}"}`.slice(0, 1024));
    let sent = 0;
    // A streamed body has no Content-Length: only the bytes actually read can stop it.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.length;
        if (sent > 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.7.0.1' },
      body,
      duplex: 'half',
    } as RequestInit);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_client_metadata');
    assert.ok(sent < 1024 * 1024, `read ${sent} bytes`);
    const sized = await request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.7.0.2' },
      body: JSON.stringify({ client_name: 'a'.repeat(20_000) }),
    });
    assert.equal(sized.status, 400);
    assert.equal((await sized.json()).error_description, 'The request is too large');
  });

  it('registration is rate limited per client IP', async (t) => {
    const { request } = setup(t);
    for (let i = 0; i < 10; i++)
      assert.equal((await register(request, {}, '10.2.0.1')).status, 201);
    const limited = await register(request, {}, '10.2.0.1');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await register(request, {}, '10.2.0.2')).status, 201);
  });

  it('a spoofed first X-Forwarded-For entry gives no fresh bucket', async (t) => {
    const { request } = setup(t);
    for (let i = 0; i < 10; i++)
      assert.equal((await register(request, {}, `9.9.9.${i}, 10.4.0.1`)).status, 201);
    assert.equal((await register(request, {}, '8.8.8.8, 10.4.0.1')).status, 429);
    assert.equal((await register(request, {}, '8.8.8.8, 10.4.0.2')).status, 201);
    const body = { grant_type: 'refresh_token', refresh_token: 'aar_x', client_id: 'c' };
    for (let i = 0; i < 30; i++) {
      assert.equal((await request('/oauth/token', form(body, `9.9.9.${i}, 10.5.0.1`))).status, 400);
    }
    assert.equal((await request('/oauth/token', form(body, '8.8.8.8, 10.5.0.1'))).status, 429);
  });

  it('the token endpoint is rate limited per client IP', async (t) => {
    const { request } = setup(t);
    const body = { grant_type: 'refresh_token', refresh_token: 'aar_x', client_id: 'c' };
    for (let i = 0; i < 30; i++) {
      assert.equal((await request('/oauth/token', form(body, '10.3.0.1'))).status, 400);
    }
    assert.equal((await request('/oauth/token', form(body, '10.3.0.1'))).status, 429);
    assert.equal((await request('/oauth/token', form(body, '10.3.0.2'))).status, 400);
  });

  it('the token endpoint answers RFC 6749 errors as JSON', async (t) => {
    const { request } = setup(t);
    const json = async (res: Response) => ({ status: res.status, ...(await res.json()) });
    const bad = (body: Record<string, string>) => request('/oauth/token', form(body));

    let res = await json(
      await request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    assert.equal(res.error, 'invalid_request');
    res = await json(await bad({ grant_type: 'authorization_code', code: 'x' }));
    assert.deepEqual([res.status, res.error], [401, 'invalid_client']);
    res = await json(await bad({ grant_type: 'password', client_id: 'c' }));
    assert.equal(res.error, 'unsupported_grant_type');
    res = await json(await bad({ client_id: 'c' }));
    assert.equal(res.error, 'invalid_request');
    res = await json(
      await request('/oauth/token', {
        ...form({}),
        body: 'grant_type=refresh_token&client_id=a&client_id=b&refresh_token=x',
      }),
    );
    assert.equal(res.error, 'invalid_request');
    const unknown = await bad({
      grant_type: 'authorization_code',
      code: 'aac_x',
      client_id: 'c',
      code_verifier: VERIFIER,
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.headers.get('cache-control'), 'no-store');
    assert.equal((await unknown.json()).error, 'invalid_grant');
  });

  it('a public client may name itself in Basic auth', async (t) => {
    const { request, core } = setup(t);
    const { client_id } = await (await register(request)).json();
    const check = await core.oauth.checkAuthorize(Object.fromEntries(authorizeQuery(client_id)));
    assert.ok(check.ok);
    const code = await core.oauth.createCode(check.request, 'owner@example.com');
    const res = await request('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${client_id}:`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }).toString(),
    });
    assert.equal(res.status, 200);
  });
});
