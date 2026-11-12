import { type Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  AppError,
  type Deps,
  type Format,
  type LibraryFilter,
  type ShareLink,
} from '../contracts.ts';
import { createApiRoutes } from './api.ts';
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
  connectPage,
  FORMATS,
  LIBRARY_TABS,
  type LibraryTab,
  type LibraryView,
  libraryPage,
  PANEL_TABS,
  type PanelTab,
  searchPage,
  tokensPage,
  trashPage,
} from './views.ts';

type Env = { Variables: { user: string } };
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
 * The web UI, mounted at / on the app host behind Authentik forward auth. The signed-in user comes
 * from X-authentik-email (or DEV_USER locally). Every POST must come from the app origin.
 */
export function createUiRoutes(deps: Deps): Hono {
  const { config, artifacts, comments, tokens, shareLinks, signer } = deps;
  const csp = contentSecurityPolicy(config.contentOrigin);
  const secure = config.appOrigin.startsWith('https:');
  const ui = new Hono<Env>();

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
      name: c.req.header('x-authentik-name') || user,
      theme: theme(c),
      summary: await artifacts.summary(),
      path: extra.path ?? `${url.pathname}${url.search}`,
      nav,
      agent: extra.agent,
      query: extra.query,
    };
  };

  ui.use('*', async (c, next) => {
    // Forward auth is skipped on /mcp, so its X-authentik-* headers can be forged: never trust them
    // there. This only runs when the MCP routes did not answer the request themselves.
    if (c.req.path === '/mcp' || c.req.path.startsWith('/mcp/')) return c.text('Not Found', 404);
    await next();
    c.header('Content-Security-Policy', csp);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'DENY');
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  ui.use('*', async (c, next) => {
    const user = c.req.header('x-authentik-email') || config.devUser;
    if (!user) return message(c, 401, 'Not signed in', 'Sign in through Authentik first.');
    c.set('user', user);
    await next();
  });

  ui.use('*', async (c, next) => {
    const safe = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (!safe && c.req.header('origin') !== config.appOrigin) {
      return message(c, 403, 'Forbidden', 'This request did not come from this site.');
    }
    await next();
  });

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
        name: c.req.header('x-authentik-name') || user,
        theme: theme(c),
        artifact,
        version,
        versions,
        threads,
        url: (path) => signer.url(artifact.id, version.version, path),
        // Rendered into the page only for an artifact that declares the viewer capability.
        viewer: artifact.capabilities.viewer
          ? { email: user, name: c.req.header('x-authentik-name') ?? '' }
          : null,
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
        name: c.req.header('x-authentik-name') || user,
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

  ui.get('/settings/tokens', async (c) =>
    c.html(tokensPage({ shell: await shell(c, 'tokens'), tokens: await tokens.list() })),
  );

  ui.post('/settings/tokens', async (c) => {
    const body = await c.req.parseBody();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const tokenShell = () => shell(c, 'tokens', { path: '/settings/tokens' });
    if (!name || name.length > 100) {
      const page = tokensPage({
        shell: await tokenShell(),
        tokens: await tokens.list(),
        error: 'Give the token a name of at most 100 characters.',
      });
      return c.html(page, 400);
    }
    const created = await tokens.create(name);
    c.header('Cache-Control', 'no-store');
    return c.html(tokensPage({ shell: await tokenShell(), tokens: await tokens.list(), created }));
  });

  ui.post('/settings/tokens/:id/revoke', async (c) => {
    if (!(await tokens.revoke(c.req.param('id')))) return notFound(c);
    return c.redirect('/settings/tokens', 303);
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
