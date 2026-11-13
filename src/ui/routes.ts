import { createHash } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { clientAddress, createRateLimiter } from '../content/rate-limit.ts';
import {
  AppError,
  type AuthorizeParams,
  type Deps,
  type Format,
  type LibraryFilter,
  type ShareLink,
} from '../contracts.ts';
import { createPasswordChecker, type PasswordChecker } from '../core/passwords.ts';
import { PUBLIC_OAUTH_PATHS } from '../oauth/rules.ts';
import { createApiRoutes } from './api.ts';
import { MAX_EMAIL, safeNext } from './auth.ts';
import { docsRuntimePage } from './docs.ts';
import {
  contentSecurityPolicy,
  messageDocument,
  type Nav,
  type Shell,
  STATIC,
  THEMES,
  type Theme,
} from './layout.ts';
import {
  artifactPage,
  type CompareMode,
  comparePage,
  connectionsPage,
  connectPage,
  consentPage,
  FORMATS,
  LIBRARY_TABS,
  type LibraryTab,
  type LibraryView,
  libraryPage,
  loginPage,
  PANEL_TABS,
  type PanelTab,
  searchPage,
  trashPage,
} from './views.ts';

/**
 * user: the signed-in email. name: the display name. viewerName: the name the `viewer` capability
 * shows to a live page ('' when there is none). The identity middleware below is the only place
 * that decides all three, for both sign-in modes.
 */
type Env = { Variables: { user: string; name: string; viewerName: string } };
type Form = Record<string, string | File | (string | File)[]>;

/** A text form field, or '' when it is missing or not text. */
const field = (form: Form, name: string): string => {
  const value = form[name];
  return typeof value === 'string' ? value : '';
};

const isFormat = (value: string | undefined): value is Format => FORMATS.includes(value as Format);
const oneOf = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.includes(value as T) ? (value as T) : undefined;

/** The expiry choices of a new share link, in days; '' never expires. */
const EXPIRY_DAYS = ['', '1', '7', '30', '90'];

/** Preferences, kept in cookies so the server renders them without a flash. app.js sets them too. */
const COOKIES = { theme: 'aa_theme', view: 'aa_view', panel: 'aa_panel' } as const;

/** Paths answered by mcp/ and oauth/ without forward auth; the UI must never serve them. */
const PUBLIC_PATHS = new Set(PUBLIC_OAUTH_PATHS);
const isPublicPath = (path: string) =>
  path === '/mcp' || path.startsWith('/mcp/') || PUBLIC_PATHS.has(path);

/** Positive integer from a path segment, else null. */
function versionParam(value: string): number | null {
  return /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
}

/** A path on this site to go back to after a form; anything else goes to the library. */
function localPath(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  return /^\/(?![/\\])[^\\\u0000-\u001f\u007f]*$/.test(value) && value.length <= 2000 ? value : '/';
}

const TAB_FILTERS: Record<LibraryTab, LibraryFilter> = {
  all: {},
  live: { live: true },
  shared: { shared: true },
  comments: { openComments: true },
  asks: { openAsks: true },
};

/**
 * The web UI, mounted at / on the app host. Who is signed in depends on AUTH_MODE:
 *   proxy (the default): a sign-in proxy (forward auth) sends the user in the AUTH_EMAIL_HEADER
 *     request header (or DEV_USER locally). Sessions and /login do not exist.
 *   password: the user comes only from a valid session cookie, made at /login. The identity
 *     headers are never read.
 * Every POST must come from the app origin.
 */
export type UiOptions = {
  /** Replaces the password checker of the built-in sign-in. For tests. */
  checker?: PasswordChecker;
};

export function createUiRoutes(deps: Deps, options: UiOptions = {}): Hono {
  const { config, artifacts, comments, tokens, oauth, shareLinks, signer, sessions } = deps;
  const csp = contentSecurityPolicy(config.contentOrigin);
  const secure = config.appOrigin.startsWith('https:');
  const passwordMode = config.authMode === 'password';
  const ui = new Hono<Env>();

  // ---- The built-in sign-in (password mode only) ----
  // The __Host- prefix makes browsers accept the cookie only with Secure, Path=/ and no Domain.
  const sessionCookie = secure ? '__Host-aa_session' : 'aa_session';
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
  /** What a session remembers of its account: a hash of the password hash text. */
  const credentials = new Map(config.authUsers.map((u) => [u.email, sha256(u.hash)]));
  const credentialOf = (email: string) => credentials.get(email) ?? null;
  // Per client address, and per account (typed email, existing or not).
  const addressLimit = createRateLimiter({ capacity: 10, perMinute: 10 });
  const accountLimit = createRateLimiter({ capacity: 5, perMinute: 5 });
  // Only built in password mode: it makes a dummy hash, which costs a moment.
  const checker = passwordMode
    ? (options.checker ?? createPasswordChecker(config.authUsers))
    : null;
  const setSession = (c: Context<Env>, token: string, maxAgeSeconds: number) =>
    setCookie(c, sessionCookie, token, {
      path: '/',
      maxAge: maxAgeSeconds,
      httpOnly: true,
      sameSite: 'Lax',
      secure,
    });

  const remember = (c: Context<Env>, name: string, value: string) =>
    setCookie(c, name, value, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'Lax',
      secure,
    });
  const theme = (c: Context<Env>): Theme => oneOf(THEMES, getCookie(c, COOKIES.theme)) ?? 'system';

  const message = (
    c: Context<Env>,
    status: 400 | 401 | 403 | 404 | 500,
    title: string,
    text: string,
  ) =>
    c.html(
      messageDocument({
        theme: theme(c),
        signedIn: Boolean(c.get('user')),
        signIn: passwordMode && !c.get('user'),
        title,
        message: text,
        status,
      }),
      status,
    );
  const notFound = (c: Context<Env>) => message(c, 404, 'Not found', 'There is nothing here.');

  /** The sidebar's data. `path` is where the theme form comes back to: this page, by default. */
  const shell = async (
    c: Context<Env>,
    nav: Nav,
    extra: { agent?: string; query?: string; path?: string } = {},
  ): Promise<Shell> => {
    const url = new URL(c.req.url);
    const user = c.get('user');
    return {
      user,
      name: c.get('name'),
      signOut: passwordMode,
      theme: theme(c),
      summary: await artifacts.summary(),
      path: extra.path ?? `${url.pathname}${url.search}`,
      nav,
      agent: extra.agent,
      query: extra.query,
    };
  };

  ui.use('*', async (c, next) => {
    // The proxy's sign-in is skipped on /mcp and the public OAuth paths, so identity headers there
    // can be forged: never trust them. This only runs when those routes did not answer.
    if (isPublicPath(c.req.path)) return c.text('Not Found', 404);
    await next();
    if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', csp);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'DENY');
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  // Who is signed in: the one place that decides it, for both modes.
  ui.use('*', async (c, next) => {
    if (passwordMode) {
      const page = c.req.method === 'GET' || c.req.method === 'HEAD';
      // The login page needs its CSS, script and fonts without a session (reads only).
      if (page && c.req.path.startsWith('/static/')) return next();
      // Only a valid session counts. The identity headers are not read in this mode.
      const token = getCookie(c, sessionCookie);
      const session = token ? await sessions.verify(token, credentialOf) : null;
      if (token && session?.renewed) setSession(c, token, session.maxAgeSeconds);
      if (session) {
        c.set('user', session.email);
        c.set('name', session.email);
        c.set('viewerName', '');
        return next();
      }
      // Open without a session: the login page, and a sign-out (a no-op then; it still passes the
      // Origin check below). A sign-out with an ended session should land on the login page.
      if (c.req.path === '/login') return next();
      if (c.req.path === '/logout' && c.req.method === 'POST') return next();
      if (page && !c.req.path.startsWith('/api/')) {
        const url = new URL(c.req.url);
        const back = new URLSearchParams({ next: `${url.pathname}${url.search}` });
        return c.redirect(`/login?${back}`, 302);
      }
      return message(c, 401, 'Not signed in', 'Sign in first.');
    }
    // loadConfig makes sure that the email header or DEV_USER is set.
    const emailHeader = config.authEmailHeader;
    const user = (emailHeader && c.req.header(emailHeader)) || config.devUser;
    if (!user) {
      return message(
        c,
        401,
        'Not signed in',
        `This app has no sign-in of its own. A sign-in proxy in front of it must send the signed-in user's email in the ${emailHeader ?? 'AUTH_EMAIL_HEADER'} request header, and that header is missing.`,
      );
    }
    const headerName = config.authNameHeader ? c.req.header(config.authNameHeader) : undefined;
    c.set('user', user);
    c.set('name', headerName || user);
    c.set('viewerName', headerName ?? '');
    await next();
  });

  ui.use('*', async (c, next) => {
    const safe = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (!safe && c.req.header('origin') !== config.appOrigin) {
      return message(c, 403, 'Forbidden', 'This request did not come from this site.');
    }
    await next();
  });

  // Form posts are small (the largest field is a 2,000 character comment). /api has its own limit.
  const formLimit = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.text('The request body is too large', 413),
  });
  ui.use('*', (c, next) => (c.req.path.startsWith('/api/') ? next() : formLimit(c, next)));

  if (passwordMode) {
    const SIGN_IN_FAILED = 'Wrong email or password.';
    const TOO_MANY = 'Too many attempts. Wait a minute and try again.';

    ui.get('/login', (c) => {
      const next = safeNext(c.req.query('next'), config.appOrigin);
      if (c.get('user')) return c.redirect(next, 302);
      return c.html(loginPage({ theme: theme(c), email: '', next }));
    });

    // The Origin check above is what stops a cross-site sign-in. Whatever goes wrong gets the same
    // answer, so the page does not tell an unknown email from a wrong password.
    ui.post('/login', async (c) => {
      // Anyone can post here, so a body that cannot be read is a plain 400, not a logged error.
      const form = await c.req.parseBody().catch(() => null);
      if (!form) return message(c, 400, 'Bad request', 'The form could not be read.');
      const next = safeNext(field(form, 'next'), config.appOrigin);
      const email = field(form, 'email').trim().toLowerCase().slice(0, MAX_EMAIL);
      const password = field(form, 'password');
      const again = (status: 401 | 429, error: string) =>
        c.html(loginPage({ theme: theme(c), email, next, error }), status);

      // Both limits are checked before any password is, so a flood costs no scrypt work.
      const address = clientAddress(c.req.header('x-forwarded-for'));
      if (!addressLimit.take(address) || !accountLimit.take(email)) return again(429, TOO_MANY);

      const result = await (checker as NonNullable<typeof checker>).check(email, password);
      if (result === 'busy') return again(429, TOO_MANY);
      if (result !== 'ok') return again(401, SIGN_IN_FAILED);

      // A new token every time (no session fixation); a session the browser already had is ended.
      const old = getCookie(c, sessionCookie);
      if (old) await sessions.destroy(old);
      const session = await sessions.create(email, credentialOf(email) ?? '');
      setSession(c, session.token, session.maxAgeSeconds);
      return c.redirect(next, 303);
    });

    ui.post('/logout', async (c) => {
      const token = getCookie(c, sessionCookie);
      if (token) await sessions.destroy(token);
      deleteCookie(c, sessionCookie, { path: '/', secure });
      return c.redirect('/login', 303);
    });
  }

  // The URLs of app.js and app.css carry a hash of their content; the fonts never change.
  ui.get('/static/*', (c) => {
    const file = STATIC.get(c.req.path.slice('/static/'.length));
    if (!file) return notFound(c);
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    return c.body(file.body as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': file.type });
  });

  ui.get('/', async (c) => {
    const cursor = c.req.query('cursor') || undefined;
    const query = (c.req.query('q') ?? '').trim().slice(0, 200);
    if (query) {
      const page = await artifacts.search({ query, cursor, limit: 20 });
      return c.html(
        searchPage({
          shell: await shell(c, 'library', { query }),
          query,
          hits: page.items,
          nextCursor: page.nextCursor,
          openComments: await comments.openCounts(page.items.map((hit) => hit.artifact.id)),
        }),
      );
    }

    const format = c.req.query('format');
    const agent = (c.req.query('agent') ?? '').slice(0, 200) || undefined;
    const asked = oneOf<LibraryView>(['grid', 'list'], c.req.query('view'));
    if (asked) remember(c, COOKIES.view, asked);
    const state = {
      tab: oneOf(LIBRARY_TABS, c.req.query('tab')) ?? 'all',
      format: isFormat(format) ? format : undefined,
      agent,
      sort: c.req.query('sort') === 'title' ? ('title' as const) : ('updated' as const),
      view: asked ?? oneOf<LibraryView>(['grid', 'list'], getCookie(c, COOKIES.view)) ?? 'grid',
    };
    const filter: LibraryFilter = {
      ...(state.format ? { format: state.format } : {}),
      ...(agent ? { agent } : {}),
    };
    const [page, ...counts] = await Promise.all([
      artifacts.browse({
        ...filter,
        ...TAB_FILTERS[state.tab],
        sort: state.sort,
        cursor,
        limit: 24,
      }),
      ...LIBRARY_TABS.map((tab) => artifacts.count({ ...filter, ...TAB_FILTERS[tab] })),
    ]);
    return c.html(
      libraryPage({
        shell: await shell(c, state.tab === 'asks' ? 'asks' : 'library', { agent }),
        state,
        items: page.items,
        nextCursor: page.nextCursor,
        counts: Object.fromEntries(LIBRARY_TABS.map((tab, i) => [tab, counts[i] ?? 0])) as Record<
          LibraryTab,
          number
        >,
        // Live previews: the entry in a frame without scripts. A PDF gets the format tile.
        preview: ({ artifact: a, entry }) =>
          a.format === 'pdf' ? null : signer.url(a.id, a.latestVersion, entry),
      }),
    );
  });

  /** The side panel: ?panel=<tab> opens a tab, ?panel=closed closes it; a cookie remembers. */
  const panelState = (c: Context<Env>, given?: PanelTab) => {
    const asked = c.req.query('panel');
    const tab = given ?? oneOf(PANEL_TABS, asked);
    if (tab || asked === 'closed') remember(c, COOKIES.panel, tab ?? 'closed');
    const saved = getCookie(c, COOKIES.panel);
    if (tab) return { tab, open: true };
    const remembered = oneOf(PANEL_TABS, saved) ?? 'comments';
    return { tab: remembered, open: asked !== 'closed' && saved !== 'closed' };
  };

  const showArtifact = async (
    c: Context<Env>,
    id: string,
    versionNumber?: number,
    extra: { created?: { url: string; link: ShareLink }; tab?: PanelTab } = {},
  ) => {
    const found = await artifacts.get(id, versionNumber);
    const versions = found ? await artifacts.listVersions(id) : null;
    const links = found ? await shareLinks.list(id) : null;
    const threads = found ? await comments.list(id, 'all') : null;
    if (!found || !versions || !links || !threads) return notFound(c);
    const { artifact, version } = found;
    const user = c.get('user');
    return c.html(
      artifactPage({
        user,
        name: c.get('name'),
        signOut: passwordMode,
        theme: theme(c),
        artifact,
        version,
        versions,
        threads,
        url: (path) => signer.url(artifact.id, version.version, path),
        // Rendered into the page only for an artifact that declares the viewer capability.
        viewer: artifact.capabilities.viewer ? { email: user, name: c.get('viewerName') } : null,
        shareLinks: links,
        createdLink: extra.created,
        panel: panelState(c, extra.tab),
      }),
    );
  };

  /** The artifact page at a version (the plain URL for the latest), with a panel tab open. */
  const artifactUrl = async (id: string, version: number | null, tab: PanelTab) => {
    const latest = (await artifacts.get(id))?.artifact.latestVersion;
    const path = version && version !== latest ? `/v/${version}` : '';
    return `/a/${encodeURIComponent(id)}${path}?panel=${tab}`;
  };

  ui.get('/a/:id', (c) => showArtifact(c, c.req.param('id')));
  ui.get('/a/:id/v/:version', (c) => {
    const version = versionParam(c.req.param('version'));
    return version === null ? notFound(c) : showArtifact(c, c.req.param('id'), version);
  });

  // ?from=&to= (default: the latest against the one before it), &mode=side for the two frames.
  ui.get('/a/:id/compare', async (c) => {
    const id = c.req.param('id');
    const latest = (await artifacts.get(id))?.artifact.latestVersion;
    const given = (name: string) => {
      const value = c.req.query(name);
      return value === undefined || value === '' ? undefined : versionParam(value);
    };
    const to = given('to');
    const from = given('from');
    if (!latest || to === null || from === null) return notFound(c);
    const end = to ?? latest;
    const comparison = await artifacts.compare(id, from ?? Math.max(1, end - 1), end);
    const versions = comparison && (await artifacts.listVersions(id));
    if (!comparison || !versions) return notFound(c);
    const user = c.get('user');
    return c.html(
      comparePage({
        user,
        name: c.get('name'),
        signOut: passwordMode,
        theme: theme(c),
        comparison,
        versions,
        mode: oneOf<CompareMode>(['changes', 'side'], c.req.query('mode')) ?? 'changes',
        url: (version, path) => signer.url(id, version, path),
      }),
    );
  });

  ui.post('/a/:id/delete', async (c) => {
    if (!(await artifacts.delete(c.req.param('id')))) return notFound(c);
    return c.redirect('/', 303);
  });

  // Rename: a settings-only publish, which makes no new version.
  ui.post('/a/:id/settings', async (c) => {
    const id = c.req.param('id');
    const form = await c.req.parseBody();
    if (!(await artifacts.get(id))) return notFound(c);
    await artifacts.publish(
      { id, title: field(form, 'title'), description: field(form, 'description') },
      c.get('user'),
    );
    return c.redirect(await artifactUrl(id, versionParam(field(form, 'version')), 'details'), 303);
  });

  ui.post('/a/:id/v/:version/restore', async (c) => {
    const version = versionParam(c.req.param('version'));
    if (version === null) return notFound(c);
    const restored = await artifacts.restoreVersion(c.req.param('id'), version, c.get('user'));
    return c.redirect(`/a/${encodeURIComponent(restored.id)}?panel=versions`, 303);
  });

  ui.get('/trash', async (c) =>
    c.html(trashPage({ shell: await shell(c, 'trash'), items: await artifacts.listDeleted() })),
  );

  ui.post('/trash/:id/restore', async (c) => {
    if (!(await artifacts.undelete(c.req.param('id')))) return notFound(c);
    return c.redirect('/trash', 303);
  });

  ui.post('/a/:id/share', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const pin = body.version === 'latest' ? undefined : versionParam(String(body.version ?? ''));
    const days = typeof body.expires === 'string' ? body.expires : '';
    if (pin === null || !EXPIRY_DAYS.includes(days)) {
      throw new AppError('invalid_input', 'Choose a version and an expiry from the form.');
    }
    const created = await shareLinks.create(id, {
      version: pin,
      label: typeof body.label === 'string' ? body.label : '',
      expiresAt: days ? new Date(Date.now() + Number(days) * 86_400_000).toISOString() : undefined,
    });
    // The URL holds the token, which is shown only on this page.
    c.header('Cache-Control', 'no-store');
    const url = `${config.contentOrigin}/p/${created.token}/`;
    return showArtifact(c, id, pin, { created: { url, link: created.link }, tab: 'share' });
  });

  ui.post('/a/:id/share/:link/revoke', async (c) => {
    const id = c.req.param('id');
    if (!(await shareLinks.revoke(id, c.req.param('link')))) return notFound(c);
    return c.redirect(`/a/${encodeURIComponent(id)}?panel=share`, 303);
  });

  // Comments from this UI are the signed-in owner's own words: the only place `typed` is true.
  const owner = (c: Context<Env>) => ({ name: c.get('user'), typed: true });

  /** Back to the version the form was on, at the thread. */
  const backTo = async (c: Context<Env>, id: string, form: Form, threadId: string) => {
    const url = await artifactUrl(id, versionParam(field(form, 'version')), 'comments');
    return c.redirect(`${url}#thread-${threadId}`, 303);
  };

  ui.post('/a/:id/comments', async (c) => {
    const id = c.req.param('id');
    const form = await c.req.parseBody();
    const threadId = field(form, 'threadId') || undefined;
    const exact = field(form, 'exact');
    const thread = await comments.add(
      threadId
        ? { artifactId: id, threadId, body: field(form, 'body') }
        : {
            artifactId: id,
            body: field(form, 'body'),
            version: versionParam(field(form, 'version')) ?? undefined,
            anchor: exact.trim()
              ? {
                  kind: 'text',
                  exact,
                  prefix: field(form, 'prefix'),
                  suffix: field(form, 'suffix'),
                }
              : { kind: 'note' },
          },
      owner(c),
    );
    return backTo(c, id, form, thread.id);
  });

  // The thread's reply form posts here too (Resolve/Reopen), so a reply typed first isn't lost.
  ui.post('/a/:id/comments/:threadId/resolve', async (c) => {
    const id = c.req.param('id');
    const threadId = c.req.param('threadId');
    const form = await c.req.parseBody();
    const body = field(form, 'body');
    if (body.trim()) await comments.add({ artifactId: id, threadId, body }, owner(c));
    const thread = await comments.resolve(threadId, field(form, 'resolved') !== '0', id);
    if (!thread) return notFound(c);
    return backTo(c, id, form, thread.id);
  });

  // The only way to answer an ask: the owner, signed in through forward auth, clicks an option.
  // The answerer is the signed-in user; nothing in the form says who answered.
  ui.post('/a/:id/asks/:commentId', async (c) => {
    const id = c.req.param('id');
    const form = await c.req.parseBody();
    const thread = await comments.answer(
      id,
      c.req.param('commentId'),
      field(form, 'optionId'),
      c.get('user'),
    );
    if (!thread) return notFound(c);
    return backTo(c, id, form, thread.id);
  });

  ui.post('/settings/theme', async (c) => {
    const form = await c.req.parseBody();
    const chosen = oneOf(THEMES, field(form, 'theme'));
    if (!chosen) throw new AppError('invalid_input', 'Choose light, dark or system.');
    remember(c, COOKIES.theme, chosen);
    return c.redirect(localPath(field(form, 'back')), 303);
  });

  const connections = async (
    c: Context<Env>,
    extra: { created?: Parameters<typeof connectionsPage>[0]['created']; error?: string } = {},
  ) =>
    connectionsPage({
      shell: await shell(c, 'connections', { path: '/settings/connections' }),
      grants: await oauth.listGrants(),
      tokens: await tokens.list(),
      ...extra,
    });

  ui.get('/settings/connections', async (c) => c.html(await connections(c)));
  // The page was called Tokens before.
  ui.get('/settings/tokens', (c) => c.redirect('/settings/connections', 301));

  ui.post('/settings/tokens', async (c) => {
    const body = await c.req.parseBody();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) {
      const error = 'Give the token a name of at most 100 characters.';
      return c.html(await connections(c, { error }), 400);
    }
    const created = await tokens.create(name);
    c.header('Cache-Control', 'no-store');
    return c.html(await connections(c, { created }));
  });

  ui.post('/settings/tokens/:id/revoke', async (c) => {
    if (!(await tokens.revoke(c.req.param('id')))) return notFound(c);
    return c.redirect('/settings/connections', 303);
  });

  ui.post('/settings/connections/:id/revoke', async (c) => {
    if (!(await oauth.revokeGrant(c.req.param('id')))) return notFound(c);
    return c.redirect('/settings/connections', 303);
  });

  // ---- OAuth authorization endpoint (behind the sign-in proxy) ----

  /** The answer to the client: a redirect to its redirect_uri with the code or the error, and iss. */
  const answer = (redirectUri: string, params: Record<string, string | null>) => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null) url.searchParams.set(key, value);
    }
    url.searchParams.set('iss', config.appOrigin);
    return url.toString();
  };

  const authorize = async (c: Context<Env>, params: AuthorizeParams, decision?: string) => {
    const check = await oauth.checkAuthorize(params);
    if (!check.ok && check.redirect === null) {
      return message(c, 400, 'Cannot connect this app', check.description);
    }
    if (!check.ok) {
      const to = answer(check.redirect, {
        error: check.error,
        error_description: check.description,
        state: check.state,
      });
      return c.redirect(to, 303);
    }
    const { request } = check;
    if (decision === undefined) {
      // Browsers apply form-action to the redirect after the POST too: allow the client's origin.
      // CSP can't name an IPv6 literal, so [::1] gets the scheme.
      const target = new URL(request.redirectUri);
      const source = target.hostname.startsWith('[') ? target.protocol : target.origin;
      c.header('Content-Security-Policy', contentSecurityPolicy(config.contentOrigin, [source]));
      const user = c.get('user');
      return c.html(
        consentPage({
          theme: theme(c),
          user,
          name: c.get('name'),
          request,
          params,
        }),
      );
    }
    if (decision !== 'allow') {
      const to = answer(request.redirectUri, {
        error: 'access_denied',
        error_description: 'The user denied the request',
        state: request.state,
      });
      return c.redirect(to, 303);
    }
    const code = await oauth.createCode(request, c.get('user'));
    c.header('Cache-Control', 'no-store');
    return c.redirect(answer(request.redirectUri, { code, state: request.state }), 303);
  };

  const AUTHORIZE_KEYS = [
    'response_type',
    'client_id',
    'redirect_uri',
    'code_challenge',
    'code_challenge_method',
    'state',
    'resource',
    'scope',
  ] as const;
  const pick = (get: (key: string) => string | undefined): AuthorizeParams =>
    Object.fromEntries(
      AUTHORIZE_KEYS.map((key) => [key, get(key)]).filter(([, value]) => value !== undefined),
    );

  ui.get('/oauth/authorize', (c) =>
    authorize(
      c,
      pick((key) => c.req.query(key)),
    ),
  );

  // The consent form; the Origin check above guards it. Everything is checked again.
  ui.post('/oauth/authorize', async (c) => {
    const form = await c.req.parseBody();
    const value = (key: string) => (typeof form[key] === 'string' ? form[key] : undefined);
    return authorize(c, pick(value), value('decision') ?? 'deny');
  });

  ui.get('/connect', async (c) =>
    c.html(connectPage({ shell: await shell(c, 'connect'), appOrigin: config.appOrigin })),
  );

  ui.get('/docs/runtime', async (c) => c.html(docsRuntimePage({ shell: await shell(c, 'docs') })));

  ui.route('/api', createApiRoutes(deps));

  ui.all('*', notFound);

  ui.onError((err, c) => {
    if (err instanceof AppError && err.code === 'not_found') return notFound(c);
    if (err instanceof AppError && err.code === 'invalid_input') {
      return message(c, 400, 'Bad request', err.message);
    }
    console.error('ui error', err);
    return message(c, 500, 'Something went wrong', 'The error has been logged.');
  });

  return new Hono().route('/', ui);
}
