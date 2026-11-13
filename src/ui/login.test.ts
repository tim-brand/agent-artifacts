import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createApp } from '../app.ts';
import type { Config } from '../config.ts';
import { sha256Hex } from '../core/ids.ts';
import { createCore } from '../core/index.ts';
import { createPasswordChecker, hashPassword, type PasswordChecker } from '../core/passwords.ts';
import { s256 } from '../oauth/rules.ts';
import { safeNext } from './auth.ts';

// The built-in sign-in, end to end through the whole app (both hosts, /mcp, OAuth), with a small
// scrypt cost so the suite stays fast. Proxy mode is covered by routes.test.ts and the rest.

const COST = { logN: 14, p: 1 };
const HASH_A = await hashPassword('password of a', COST);
const HASH_B = await hashPassword('password of b', COST);
const HTTPS = { app: 'https://app.test', content: 'https://content.test' };
const HTTP = { app: 'http://localhost:3000', content: 'http://content.localhost:3000' };
const FORGED = { 'X-authentik-email': 'intruder@example.com', 'X-authentik-name': 'Intruder' };
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

type Options = {
  origins?: typeof HTTPS;
  mode?: 'password' | 'proxy';
  checker?: PasswordChecker;
};

function setup(t: TestContext, options: Options = {}) {
  const origins = options.origins ?? HTTPS;
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-login-'));
  const password = (options.mode ?? 'password') === 'password';
  const config: Config = {
    port: 0,
    dataDir: dir,
    appOrigin: origins.app,
    contentOrigin: origins.content,
    signingSecret: 'x'.repeat(32),
    devUser: null,
    authEmailHeader: 'X-authentik-email',
    authNameHeader: 'X-authentik-name',
    authMode: password ? 'password' : 'proxy',
    authUsers: password
      ? [
          { email: 'a@example.com', hash: HASH_A },
          { email: 'b@example.com', hash: HASH_B },
        ]
      : [],
  };
  const core = createCore(config);
  const checks: string[] = [];
  const real = createPasswordChecker(config.authUsers, { cost: COST });
  const checker: PasswordChecker = options.checker ?? {
    check: (email, pw) => {
      checks.push(email);
      return real.check(email, pw);
    },
  };
  const app = createApp({ config, ...core }, { checker });
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let ip = 0;
  const request = (
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      cookie?: string;
      origin?: string | null;
      address?: string;
      host?: string;
    } = {},
  ) => {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = { ...init.headers };
    headers['x-forwarded-for'] = init.address ?? `10.9.${Math.floor(++ip / 250)}.${ip % 250}`;
    if (init.cookie) headers.cookie = init.cookie;
    if (method !== 'GET' && init.origin !== null) headers.origin = init.origin ?? origins.app;
    return app.request(`${origins.app}${path}`, {
      method,
      headers: { host: init.host ?? new URL(origins.app).host, ...headers },
      body: init.body,
      redirect: 'manual',
    });
  };
  const login = (
    body: Record<string, string>,
    init: Parameters<typeof request>[1] = {},
  ): Response | Promise<Response> =>
    request('/login', {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams(body).toString(),
      ...init,
    });
  /** Signs in and returns the cookie header to send back. */
  const signIn = async (email = 'a@example.com', pw = 'password of a') => {
    const res = await login({ email, password: pw, next: '/' });
    assert.equal(res.status, 303);
    return cookieOf(res);
  };
  const cookieName = origins.app.startsWith('https:') ? '__Host-aa_session' : 'aa_session';
  const cookieOf = (res: Response) => {
    const line = res.headers.getSetCookie().find((c) => c.startsWith(`${cookieName}=`)) ?? '';
    return line.split(';')[0] ?? '';
  };
  return { app, core, config, request, login, signIn, checks, cookieOf, cookieName };
}

const body = (res: Response) => res.text();
const location = (res: Response) => res.headers.get('location');
/** The page without what the user typed, to compare error pages. */
const withoutEmail = (page: string) => page.replace(/name="email" value="[^"]*"/, 'name="email"');

describe('without a session', () => {
  it('redirects a page to /login with where it was going', async (t) => {
    const { request } = setup(t);
    for (const path of ['/', '/trash', '/a/abc?panel=share', '/?q=a%20b&tab=live', '/connect']) {
      const res = await request(path);
      assert.equal(res.status, 302, path);
      assert.equal(location(res), `/login?${new URLSearchParams({ next: path })}`);
    }
    const head = await request('/trash', { method: 'HEAD' });
    assert.equal(head.status, 302);
  });

  it('answers 401 to a write and to /api, without a redirect', async (t) => {
    const { request } = setup(t);
    for (const [path, method] of [
      ['/settings/theme', 'POST'],
      ['/a/abc/delete', 'POST'],
      ['/api/artifacts/abc/data', 'GET'],
      ['/api/artifacts/abc/data/doc', 'PUT'],
    ] as const) {
      const res = await request(path, {
        method,
        body: method === 'GET' ? undefined : 'theme=dark',
        headers: FORM,
      });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(location(res), null);
      const page = await body(res);
      assert.match(page, /Sign in first/);
      assert.doesNotMatch(page, /proxy|header/i);
    }
    // Also without an Origin: the 401 comes first, as in proxy mode.
    const bare = await request('/settings/theme', { method: 'POST', origin: null });
    assert.equal(bare.status, 401);
  });

  it('serves /static/ and /login, and nothing else', async (t) => {
    const { request } = setup(t);
    const login = await request('/login');
    assert.equal(login.status, 200);
    const page = await body(login);
    for (const url of page.match(/(?:href|src)="(\/static\/[^"]+)"/g) ?? []) {
      const path = url.replace(/^(?:href|src)="/, '').replace(/"$/, '');
      const res = await request(path);
      assert.equal(res.status, 200, path);
    }
    assert.equal((await request('/static/app.css')).status, 200);
    assert.equal((await request('/static/fonts/Geist-Variable.woff2')).status, 200);
    assert.equal((await request('/static/nope.css')).status, 404);
    // Only reads: a write under /static/ is a write without a session.
    const write = await request('/static/app.css', { method: 'POST', body: 'x', headers: FORM });
    assert.equal(write.status, 401);
    // A path that merely looks like /static/ does not reach another page.
    assert.equal((await request('/static/..%2Ftrash')).status, 404);
    // The URL parser turns this one into /trash, which has no session: sent to the login.
    assert.equal((await request('/static/%2e%2e/trash')).status, 302);
    assert.equal((await request('/docs/runtime')).status, 302);
    assert.equal((await request('/settings/connections')).status, 302);
    assert.equal((await request('/oauth/authorize')).status, 302);
  });

  it('answers /healthz and any unknown host as before', async (t) => {
    const { request } = setup(t);
    const ok = await request('/healthz');
    assert.equal(ok.status, 200);
    assert.equal(await body(ok), 'ok');
    const other = await request('/healthz', { host: 'probe.internal' });
    assert.equal(other.status, 200);
    const unknown = await request('/', { host: 'unknown.example' });
    assert.equal(unknown.status, 404);
  });
});

describe('the login page', () => {
  it('renders the form, with the right attributes and headers', async (t) => {
    const { request } = setup(t);
    const res = await request('/login?next=/trash');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.doesNotMatch(csp, /unsafe/);
    assert.match(csp, /form-action 'self'/);
    const page = await body(res);
    assert.match(page, /<form method="post" action="\/login"/);
    assert.match(page, /<input type="hidden" name="next" value="\/trash">/);
    assert.match(page, /<label class="field"><span>Email<\/span><input[^>]*type="email"/);
    assert.match(page, /type="email" name="email"[^>]*autocomplete="username"[^>]*autofocus/);
    assert.match(page, /type="password" name="password"[^>]*autocomplete="current-password"/);
    assert.match(page, /<button class="btn primary wide" type="submit">Sign in<\/button>/);
    // No inline script or style, and the password is not put back.
    assert.doesNotMatch(page, /<script(?![^>]*\ssrc=)/);
    assert.doesNotMatch(page, /\sstyle=/);
    assert.doesNotMatch(page, /type="password"[^>]*value=/);
  });

  it('keeps a hostile next out of the page unescaped, and sends it to / when it is not local', async (t) => {
    const { request } = setup(t);
    const page = await body(
      await request(`/login?next=${encodeURIComponent('"><script>x</script>')}`),
    );
    assert.doesNotMatch(page, /<script>x/);
    assert.match(page, /name="next" value="\/"/);
  });

  it('redirects to next when already signed in', async (t) => {
    const { request, signIn } = setup(t);
    const cookie = await signIn();
    const res = await request('/login?next=/trash', { cookie });
    assert.equal(res.status, 302);
    assert.equal(location(res), '/trash');
    assert.equal(location(await request('/login', { cookie })), '/');
    assert.equal(location(await request('/login?next=//evil.example', { cookie })), '/');
  });
});

describe('signing in', () => {
  it('sets the session cookie with the right attributes on https, and redirects', async (t) => {
    const { login, request, cookieName } = setup(t);
    assert.equal(cookieName, '__Host-aa_session');
    const res = await login({ email: 'a@example.com', password: 'password of a', next: '/trash' });
    assert.equal(res.status, 303);
    assert.equal(location(res), '/trash');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const [line] = res.headers.getSetCookie();
    assert.match(line ?? '', /^__Host-aa_session=[A-Za-z0-9_-]{43};/);
    for (const part of ['Max-Age=2592000', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      assert.ok(line?.includes(part), `${part} in ${line}`);
    }
    assert.doesNotMatch(line ?? '', /Domain/i);
    assert.equal(res.headers.getSetCookie().length, 1);
    // The cookie works.
    const cookie = line?.split(';')[0] ?? '';
    assert.equal((await request('/trash', { cookie })).status, 200);
  });

  it('sets the http variant of the cookie on localhost', async (t) => {
    const { login, request, cookieName } = setup(t, { origins: HTTP });
    assert.equal(cookieName, 'aa_session');
    const res = await login({ email: 'a@example.com', password: 'password of a', next: '/' });
    assert.equal(res.status, 303);
    const [line] = res.headers.getSetCookie();
    assert.match(line ?? '', /^aa_session=[A-Za-z0-9_-]{43};/);
    for (const part of ['Max-Age=2592000', 'Path=/', 'HttpOnly', 'SameSite=Lax']) {
      assert.ok(line?.includes(part), `${part} in ${line}`);
    }
    assert.doesNotMatch(line ?? '', /Secure|Domain/i);
    const cookie = line?.split(';')[0] ?? '';
    assert.equal((await request('/trash', { cookie })).status, 200);
  });

  it('matches the email in any case and ignores spaces around it, but not the password', async (t) => {
    const { login } = setup(t);
    const ok = await login({ email: '  A@Example.COM ', password: 'password of a', next: '/' });
    assert.equal(ok.status, 303);
    for (const password of ['Password of a', 'password of a ', ' password of a', 'password of b']) {
      const res = await login({ email: 'a@example.com', password, next: '/' });
      assert.equal(res.status, 401, password);
    }
  });

  it('answers a wrong password, an unknown email and empty fields with one message', async (t) => {
    const { login, checks } = setup(t);
    const wrong = await login({ email: 'a@example.com', password: 'nope', next: '/' });
    const unknown = await login({
      email: 'a@example.com'.replace('a@', 'zz@'),
      password: 'nope',
      next: '/',
    });
    const noPassword = await login({ email: 'a@example.com', password: '', next: '/' });
    const noEmail = await login({ email: '', password: 'nope', next: '/' });
    const nothing = await login({});
    const huge = await login({ email: 'a@example.com', password: 'x'.repeat(5000), next: '/' });
    const pages = [];
    for (const res of [wrong, unknown, noPassword, noEmail, nothing, huge]) {
      assert.equal(res.status, 401);
      assert.equal(res.headers.getSetCookie().length, 0);
      pages.push(withoutEmail(await body(res)));
    }
    for (const page of pages) {
      assert.match(page, /Wrong email or password\./);
      assert.equal(page, pages[0]);
    }
    // An unknown email still goes through the checker, which runs a verification for it.
    assert.ok(checks.includes('zz@example.com'));
  });

  it('shows the form again with the email kept and escaped, and not the password', async (t) => {
    const { login } = setup(t);
    const hostile = '"><script>alert(1)</script>@example.com';
    const res = await login({ email: hostile, password: 'my secret pw', next: '/trash' });
    assert.equal(res.status, 401);
    const page = await body(res);
    assert.doesNotMatch(page, /<script>alert/);
    assert.match(page, /value="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;@example\.com"/);
    assert.doesNotMatch(page, /my secret pw/);
    assert.match(page, /name="next" value="\/trash"/);
    assert.match(page, /role="alert">Wrong email or password\./);
  });

  it('refuses a sign-in from another site, or without an Origin', async (t) => {
    const { login, config } = setup(t);
    const good = { email: 'a@example.com', password: 'password of a', next: '/' };
    for (const origin of [
      'https://evil.example',
      'null',
      'http://app.test',
      'https://app.test:8443',
    ]) {
      const res = await login(good, { origin });
      assert.equal(res.status, 403, origin);
      assert.equal(res.headers.getSetCookie().length, 0);
    }
    const none = await login(good, { origin: null });
    assert.equal(none.status, 403);
    assert.equal(none.headers.getSetCookie().length, 0);
    assert.equal(config.appOrigin, 'https://app.test');
  });

  it('limits the body to 64 KB', async (t) => {
    const { login } = setup(t);
    const res = await login({
      email: 'a@example.com',
      password: 'x',
      next: '/',
      pad: 'a'.repeat(70 * 1024),
    });
    assert.equal(res.status, 413);
  });

  it('always makes a new token, and ends the session the browser had', async (t) => {
    const { request, login, cookieOf, signIn } = setup(t);
    const first = await signIn();
    const res = await login(
      { email: 'a@example.com', password: 'password of a', next: '/' },
      { cookie: first },
    );
    const second = cookieOf(res);
    assert.notEqual(second, first);
    assert.equal((await request('/trash', { cookie: second })).status, 200);
    assert.equal((await request('/trash', { cookie: first })).status, 302, 'the old token is dead');
    // A cookie that is not a session is not adopted either.
    const planted = `${first.split('=')[0]}=${'A'.repeat(43)}`;
    const fixed = await login(
      { email: 'a@example.com', password: 'password of a', next: '/' },
      { cookie: planted },
    );
    assert.notEqual(cookieOf(fixed), planted);
    assert.equal((await request('/trash', { cookie: planted })).status, 302);
  });
});

describe('where to go after signing in', () => {
  const APP = 'https://app.test';
  const cases: [string, string][] = [
    ['//evil.example', '/'],
    ['///evil.example', '/'],
    ['/\\evil.example', '/'],
    ['\\\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['https://app.test/trash', '/'],
    ['/%5Cevil.example', '/'],
    ['/%5cevil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['/path\nSet-Cookie: x=1', '/'],
    ['/path\rx', '/'],
    ['/a\tb', '/'],
    ['/\t/evil.example', '/'],
    ['/\u0000x', '/'],
    ['/.//evil.example', '/'],
    ['/..//evil.example', '/'],
    ['/a/..//evil.example', '/'],
    ['', '/'],
    ['evil.example', '/'],
    ['?x=1', '/'],
    ['/login', '/'],
    ['/login?next=/trash', '/'],
    ['/login/', '/'],
    ['/%6Cogin', '/'],
    ['/logout', '/'],
    [`/${'a'.repeat(5000)}`, '/'],
    ['/', '/'],
    ['/trash', '/trash'],
    ['/a/abc?panel=share', '/a/abc?panel=share'],
    ['/?q=a+b&tab=live', '/?q=a+b&tab=live'],
    [
      '/oauth/authorize?client_id=x&state=%2F%2Fevil',
      '/oauth/authorize?client_id=x&state=%2F%2Fevil',
    ],
    ['/a/../trash', '/trash'],
    ['/trash#frag', '/trash'],
  ];
  for (const [given, expected] of cases) {
    it(`${JSON.stringify(given.slice(0, 40))} goes to ${JSON.stringify(expected)}`, () => {
      assert.equal(safeNext(given, APP), expected);
    });
  }
  it('is not a string: /', () => {
    for (const value of [undefined, null, 5, {}, ['/trash']])
      assert.equal(safeNext(value, APP), '/');
  });

  it('applies to the redirect after a real sign-in, from the form and from the query', async (t) => {
    const { login, request, cookieOf } = setup(t);
    const hostile = [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      '/%5Cevil.example',
      'javascript:alert(1)',
      '/a\nb',
    ];
    // From the form. Three sign-ins stay inside the limit of five per account.
    let cookie = '';
    for (const next of hostile.slice(0, 3)) {
      const res = await login({ email: 'a@example.com', password: 'password of a', next });
      assert.equal(res.status, 303);
      assert.equal(location(res), '/', JSON.stringify(next));
      cookie = cookieOf(res);
    }
    // From the query, when already signed in: the same check.
    for (const next of hostile) {
      const again = await request(`/login?next=${encodeURIComponent(next)}`, { cookie });
      assert.equal(location(again), '/', JSON.stringify(next));
    }
  });
});

describe('who is signed in', () => {
  it('ignores the identity headers: without a session they sign no one in', async (t) => {
    const { request } = setup(t);
    for (const path of ['/', '/trash', '/settings/connections']) {
      const res = await request(path, { headers: FORGED });
      assert.equal(res.status, 302, path);
      assert.match(location(res) ?? '', /^\/login\?/);
    }
    const write = await request('/settings/theme', {
      method: 'POST',
      headers: { ...FORGED, ...FORM },
      body: 'theme=dark',
    });
    assert.equal(write.status, 401);
    const api = await request('/api/artifacts/x/data', { headers: FORGED });
    assert.equal(api.status, 401);
    // And a forged header does not get a form past the sign-in either.
    const attempt = await request('/login', {
      method: 'POST',
      headers: { ...FORGED, ...FORM },
      body: 'email=intruder%40example.com&password=x',
    });
    assert.equal(attempt.status, 401);
    assert.equal(attempt.headers.getSetCookie().length, 0);
  });

  it('ignores the identity headers with a session too: the user is the session', async (t) => {
    const { request, signIn } = setup(t);
    const cookie = await signIn('b@example.com', 'password of b');
    const page = await body(await request('/', { cookie, headers: FORGED }));
    assert.match(page, /<span class="who-name">b@example\.com<\/span>/);
    assert.doesNotMatch(page, /intruder|Intruder/);
    // The display name is the email, whatever the name header says.
    assert.match(page, /<small>signed in<\/small>/);
    const consentless = await body(await request('/connect', { cookie, headers: FORGED }));
    assert.doesNotMatch(consentless, /Intruder|intruder/);
  });

  it('records the session user as the author of an owner action', async (t) => {
    const { request, signIn, core } = setup(t);
    const cookie = await signIn('b@example.com', 'password of b');
    const published = await core.artifacts.publish(
      { title: 'T', content: '<p>x</p>', format: 'html' },
      'agent',
    );
    const res = await request(`/a/${published.id}/comments`, {
      method: 'POST',
      cookie,
      headers: { ...FORM, ...FORGED },
      body: new URLSearchParams({ body: 'hello', exact: '' }).toString(),
    });
    assert.equal(res.status, 303);
    const threads = await core.comments.list(published.id, 'all');
    const comment = threads?.[0]?.comments[0];
    assert.equal(comment?.author, 'b@example.com');
    assert.equal(comment?.typed, true);
  });

  it('ignores a session cookie in proxy mode', async (t) => {
    // The same app, in proxy mode: a cookie of the right name signs no one in.
    const password = setup(t);
    const cookie = await password.signIn();
    const proxy = setup(t, { mode: 'proxy' });
    const res = await proxy.request('/', { cookie });
    assert.equal(res.status, 401);
    assert.match(await body(res), /no sign-in of its own/);
    const named = await proxy.request('/', {
      cookie: 'aa_session=whatever; __Host-aa_session=whatever',
    });
    assert.equal(named.status, 401);
  });
});

describe('the sidebar and signing out', () => {
  it('shows a Sign out form in the sidebar in password mode', async (t) => {
    const { request, signIn } = setup(t);
    const cookie = await signIn();
    const page = await body(await request('/', { cookie }));
    assert.match(
      page,
      /<form class="signout" method="post" action="\/logout"><button class="btn sm wide" type="submit">Sign out<\/button><\/form>/,
    );
    assert.match(page, /<span class="who-name">a@example\.com<\/span>/);
  });

  it('has no Sign out button in proxy mode', async (t) => {
    const { request } = setup(t, { mode: 'proxy' });
    const res = await request('/', { headers: { 'X-authentik-email': 'owner@example.com' } });
    assert.equal(res.status, 200);
    const page = await body(res);
    assert.doesNotMatch(page, /Sign out|\/logout|signout/);
  });

  it('has /login and /logout in proxy mode as unknown paths', async (t) => {
    const { request } = setup(t, { mode: 'proxy' });
    const headers = { 'X-authentik-email': 'owner@example.com' };
    const get = await request('/login', { headers });
    assert.equal(get.status, 404);
    assert.equal(location(get), null);
    const post = await request('/login', {
      method: 'POST',
      headers: { ...headers, ...FORM },
      body: 'email=a%40example.com&password=x',
    });
    assert.equal(post.status, 404);
    assert.equal(post.headers.getSetCookie().length, 0);
    const out = await request('/logout', { method: 'POST', headers });
    assert.equal(out.status, 404);
    // Without the header they are as unreachable as any path: the proxy-mode 401.
    assert.equal((await request('/login')).status, 401);
  });

  it('puts Sign out in the account menu of the artifact page too', async (t) => {
    const { request, signIn, core } = setup(t);
    const cookie = await signIn();
    const { id } = await core.artifacts.publish(
      { title: 'T', content: '<p>x</p>', format: 'html' },
      'agent',
    );
    const page = await body(await request(`/a/${id}`, { cookie }));
    assert.match(page, /action="\/logout"/);
  });

  it('signs out: deletes the session, clears the cookie, and the old cookie stops working', async (t) => {
    const { request, signIn, core } = setup(t);
    const cookie = await signIn();
    const res = await request('/logout', { method: 'POST', cookie });
    assert.equal(res.status, 303);
    assert.equal(location(res), '/login');
    const [cleared] = res.headers.getSetCookie();
    assert.match(cleared ?? '', /^__Host-aa_session=;/);
    assert.match(cleared ?? '', /Max-Age=0/);
    assert.ok(cleared?.includes('Secure') && cleared.includes('Path=/'));
    const after = await request('/trash', { cookie });
    assert.equal(after.status, 302);
    assert.match(location(after) ?? '', /^\/login\?/);
    // The row is gone, not just the cookie.
    const credentialOf = () => sha256Hex(HASH_A);
    assert.equal(await core.sessions.verify(cookie.split('=')[1] ?? '', credentialOf), null);
  });

  it('sends a sign-out without a session to the login page, and still checks the Origin', async (t) => {
    const { request } = setup(t);
    for (const cookie of [undefined, `__Host-aa_session=${'x'.repeat(43)}`]) {
      const res = await request('/logout', { method: 'POST', cookie });
      assert.equal(res.status, 303);
      assert.equal(location(res), '/login');
    }
    assert.equal(
      (await request('/logout', { method: 'POST', origin: 'https://evil.example' })).status,
      403,
    );
    // Only the POST is open: a GET is a page like any other.
    const get = await request('/logout');
    assert.equal(get.status, 302);
    assert.equal(location(get), '/login?next=%2Flogout');
  });

  it('refuses a sign-out from another site, or without an Origin, and keeps the session', async (t) => {
    const { request, signIn } = setup(t);
    const cookie = await signIn();
    for (const origin of ['https://evil.example', 'null', null]) {
      const res = await request('/logout', { method: 'POST', cookie, origin });
      assert.equal(res.status, 403, String(origin));
      assert.equal(res.headers.getSetCookie().length, 0);
    }
    assert.equal((await request('/trash', { cookie })).status, 200);
  });
});

describe('sessions', () => {
  it('redirects to login when the session has expired', async (t) => {
    const { request, core } = setup(t);
    const old = await core.sessions.create(
      'a@example.com',
      sha256Hex(HASH_A),
      Date.now() - 31 * 86_400_000,
    );
    const cookie = `__Host-aa_session=${old.token}`;
    const res = await request('/trash', { cookie });
    assert.equal(res.status, 302);
    assert.equal(location(res), `/login?${new URLSearchParams({ next: '/trash' })}`);
  });

  it('sets the cookie again with a fresh Max-Age when it slides', async (t) => {
    const { request, core } = setup(t);
    const fresh = await core.sessions.create('a@example.com', sha256Hex(HASH_A));
    const cookie = `__Host-aa_session=${fresh.token}`;
    const quick = await request('/trash', { cookie });
    assert.equal(quick.status, 200);
    assert.equal(quick.headers.getSetCookie().length, 0, 'not set again within the hour');

    const stale = await core.sessions.create(
      'a@example.com',
      sha256Hex(HASH_A),
      Date.now() - 2 * 3_600_000,
    );
    const res = await request('/trash', { cookie: `__Host-aa_session=${stale.token}` });
    assert.equal(res.status, 200);
    const [line] = res.headers.getSetCookie();
    assert.ok(line?.startsWith(`__Host-aa_session=${stale.token};`), String(line));
    assert.ok(
      line?.includes('Max-Age=2592000') && line.includes('HttpOnly') && line.includes('Secure'),
    );
  });

  it('ends when the account is no longer configured or its password changed', async (t) => {
    const { core, config, request } = setup(t);
    const a = await core.sessions.create('a@example.com', sha256Hex(HASH_A));
    const old = await core.sessions.create('b@example.com', sha256Hex('an older hash of b'));
    assert.equal((await request('/trash', { cookie: `__Host-aa_session=${a.token}` })).status, 200);
    // The password of b was changed since this session was made.
    assert.equal(
      (await request('/trash', { cookie: `__Host-aa_session=${old.token}` })).status,
      302,
    );
    // Removing a from the configuration: a new app on the same database, without the account.
    const reduced = {
      ...config,
      authUsers: config.authUsers.filter((u) => u.email !== 'a@example.com'),
    };
    const app = createApp({ config: reduced, ...core });
    const res = await app.request(`${reduced.appOrigin}/trash`, {
      headers: { host: 'app.test', cookie: `__Host-aa_session=${a.token}` },
    });
    assert.equal(res.status, 302);
  });

  it('does not take a session cookie from the wrong cookie name', async (t) => {
    const { request, core } = setup(t);
    const { token } = await core.sessions.create('a@example.com', sha256Hex(HASH_A));
    // On https the cookie is __Host-aa_session: the plain name is not read.
    assert.equal((await request('/trash', { cookie: `aa_session=${token}` })).status, 302);
  });
});

describe('rate limits', () => {
  it('limits attempts per client address, and does not check the password when limited', async (t) => {
    const { login, checks } = setup(t);
    const address = '203.0.113.5';
    for (let i = 0; i < 10; i++) {
      const res = await login(
        { email: `user${i}@example.com`, password: 'nope', next: '/' },
        { address },
      );
      assert.equal(res.status, 401, `attempt ${i + 1}`);
    }
    assert.equal(checks.length, 10);
    // The right password, from the limited address: refused, and never checked.
    const limited = await login(
      { email: 'a@example.com', password: 'password of a', next: '/trash' },
      { address },
    );
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.getSetCookie().length, 0);
    const page = await body(limited);
    assert.match(page, /Too many attempts\. Wait a minute and try again\./);
    assert.match(page, /name="email" value="a@example\.com"/);
    assert.match(page, /name="next" value="\/trash"/);
    assert.equal(checks.length, 10, 'the password was not checked');
    // Another address is not affected.
    const other = await login(
      { email: 'a@example.com', password: 'password of a', next: '/' },
      { address: '203.0.113.6' },
    );
    assert.equal(other.status, 303);
  });

  it('limits attempts per account, whatever the address, and for unknown emails too', async (t) => {
    const { login, checks } = setup(t);
    for (let i = 0; i < 5; i++) {
      const res = await login({ email: 'a@example.com', password: `wrong ${i}`, next: '/' });
      assert.equal(res.status, 401, `attempt ${i + 1}`);
    }
    const limited = await login({ email: 'A@example.com', password: 'password of a', next: '/' });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.getSetCookie().length, 0);
    assert.equal(checks.length, 5, 'the password was not checked');
    // The other account signs in.
    assert.equal(
      (await login({ email: 'b@example.com', password: 'password of b', next: '/' })).status,
      303,
    );
    // An email that does not exist is limited the same way.
    for (let i = 0; i < 5; i++)
      await login({ email: 'ghost@example.com', password: 'x', next: '/' });
    const ghost = await login({ email: 'ghost@example.com', password: 'x', next: '/' });
    assert.equal(ghost.status, 429);
  });

  it('shares one bucket when there is no X-Forwarded-For', async (t) => {
    const { app, config } = setup(t);
    const attempt = () =>
      app.request(`${config.appOrigin}/login`, {
        method: 'POST',
        headers: { host: 'app.test', origin: config.appOrigin, ...FORM },
        body: new URLSearchParams({
          email: `u${Math.random()}@example.com`,
          password: 'x',
        }).toString(),
      });
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await attempt()).status);
    assert.deepEqual(statuses, [...Array(10).fill(401), 429, 429]);
  });

  it('answers 429, without a password check, when too many checks are already waiting', async (t) => {
    let calls = 0;
    const busy: PasswordChecker = {
      check: async () => {
        calls++;
        return 'busy';
      },
    };
    const { login } = setup(t, { checker: busy });
    const res = await login({ email: 'a@example.com', password: 'password of a', next: '/' });
    assert.equal(res.status, 429);
    assert.equal(calls, 1);
    assert.equal(res.headers.getSetCookie().length, 0);
    assert.match(await body(res), /Too many attempts/);
  });
});

describe('the consent page', () => {
  const REDIRECT = 'http://127.0.0.1:41999/callback';
  const VERIFIER = 'a-very-long-code-verifier-of-at-least-43-characters';

  it('sends a signed-out browser to login and back to the same URL with its whole query', async (t) => {
    const { request, login, cookieOf } = setup(t);
    const registered = await request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [REDIRECT] }),
    });
    const { client_id: clientId } = await registered.json();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: s256(VERIFIER),
      code_challenge_method: 'S256',
      state: 'xyz & <b>',
      resource: `${HTTPS.app}/mcp`,
    });
    const authorizeUrl = `/oauth/authorize?${query}`;

    const first = await request(authorizeUrl);
    assert.equal(first.status, 302);
    const loginUrl = location(first) ?? '';
    assert.ok(loginUrl.startsWith('/login?next='));

    const form = await body(await request(loginUrl));
    const next = new URL(loginUrl, HTTPS.app).searchParams.get('next');
    assert.equal(next, authorizeUrl);

    const signedIn = await login({
      email: 'a@example.com',
      password: 'password of a',
      next: next ?? '',
    });
    assert.equal(signedIn.status, 303);
    assert.equal(location(signedIn), authorizeUrl);
    assert.match(form, /name="next"/);

    const consent = await request(authorizeUrl, { cookie: cookieOf(signedIn) });
    assert.equal(consent.status, 200);
    const page = await body(consent);
    assert.match(page, /Connect Test Client\?/);
    assert.match(page, /<dd>a@example\.com<\/dd>/);

    // Allow, from the consent form: the code goes to the client, for the signed-in user.
    const allowed = await request('/oauth/authorize', {
      method: 'POST',
      cookie: cookieOf(signedIn),
      headers: FORM,
      body: new URLSearchParams([...query, ['decision', 'allow']]).toString(),
    });
    assert.equal(allowed.status, 303);
    assert.match(location(allowed) ?? '', /^http:\/\/127\.0\.0\.1:41999\/callback\?code=/);
  });

  it('refuses the consent form without a session', async (t) => {
    const { request } = setup(t);
    const res = await request('/oauth/authorize', {
      method: 'POST',
      headers: { ...FORM, ...FORGED },
      body: 'decision=allow',
    });
    assert.equal(res.status, 401);
  });
});

describe('the paths that are not the UI', () => {
  // The same request to a proxy-mode app and a password-mode app, with and without a session
  // cookie and forged identity headers: the answers must not differ.
  async function same(t: TestContext, path: string, init: RequestInit = {}) {
    const proxy = setup(t, { mode: 'proxy' });
    const password = setup(t);
    const cookie = await password.signIn();
    const results: {
      status: number;
      body: string;
      challenge: string | null;
      type: string | null;
    }[] = [];
    for (const [app, extra] of [
      [proxy, {}],
      [password, {}],
      [password, { cookie }],
      [password, { headers: FORGED }],
    ] as const) {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
      const res = await app.request(path, {
        method: init.method,
        body: init.body as string | undefined,
        origin: null,
        ...extra,
        headers: { ...headers, ...(extra as { headers?: Record<string, string> }).headers },
      });
      results.push({
        status: res.status,
        body: await res.text(),
        challenge: res.headers.get('www-authenticate'),
        type: res.headers.get('content-type'),
      });
      assert.equal(res.headers.getSetCookie().length, 0, `${path} sets no cookie`);
    }
    for (const result of results.slice(1)) assert.deepEqual(result, results[0], path);
    return results[0];
  }

  it('/mcp answers as before, with and without a session cookie', async (t) => {
    const unauthorized = await same(t, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(unauthorized?.status, 401);
    assert.match(unauthorized?.challenge ?? '', /resource_metadata=/);
  });

  it('the public OAuth paths answer as before, with and without a session cookie', async (t) => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/mcp',
    ]) {
      const res = await same(t, path);
      assert.equal(res?.status, 200, path);
    }
    const register = await same(t, '/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.ok(register && register.status >= 400 && register.status < 500);
    const token = await same(t, '/oauth/token', {
      method: 'POST',
      headers: FORM,
      body: 'grant_type=authorization_code',
    });
    assert.ok(token && token.status >= 400 && token.status < 500);
  });

  it('a personal access token still works on /mcp with a session cookie present', async (t) => {
    const { request, signIn, core } = setup(t);
    const cookie = await signIn();
    const { token } = await core.tokens.create('test');
    const res = await request('/mcp', {
      method: 'POST',
      cookie,
      origin: null,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 200);
  });

  it('the public OAuth paths are not the UI, so a GET is never sent to the login', async (t) => {
    const { request, signIn } = setup(t);
    const cookie = await signIn();
    for (const path of ['/oauth/register', '/oauth/token']) {
      // GET is answered by the OAuth routes (method not allowed), never redirected to the login.
      const res = await request(path, { cookie });
      assert.equal(res.status, 405, path);
      assert.equal(location(res), null);
    }
  });

  it('the content host sets no cookie, ignores the session cookie and the identity headers', async (t) => {
    const { app, signIn, core } = setup(t);
    const cookie = await signIn();
    const { id } = await core.artifacts.publish(
      { title: 'T', content: '<p>x</p>', format: 'html' },
      'agent',
    );
    // A signed content URL, as the app page embeds it.
    const url = core.signer.url(id, 1, 'index.html');
    const res = await app.request(url, {
      headers: { host: new URL(HTTPS.content).host, cookie, ...FORGED },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.getSetCookie().length, 0);
    assert.equal(res.headers.get('set-cookie'), null);
    // The sign-in routes do not exist on the content host.
    const login = await app.request(`${HTTPS.content}/login`, {
      method: 'POST',
      headers: { host: new URL(HTTPS.content).host, origin: HTTPS.app, ...FORM },
      body: 'email=a%40example.com&password=password+of+a',
    });
    assert.equal(login.status, 404);
    assert.equal(login.headers.getSetCookie().length, 0);
    const page = await app.request(`${HTTPS.content}/`, {
      headers: { host: new URL(HTTPS.content).host, cookie },
    });
    assert.equal(page.status, 404);
  });
});
