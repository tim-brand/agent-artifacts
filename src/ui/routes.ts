import { type Context, Hono } from 'hono';
import { AppError, type Deps, type Format, type ShareLink } from '../contracts.ts';
import { createApiRoutes } from './api.ts';
import { docsRuntimePage } from './docs.ts';
import { APP_JS, contentSecurityPolicy } from './layout.ts';
import {
  artifactPage,
  connectPage,
  FORMATS,
  listPage,
  messagePage,
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

/** The expiry choices of a new share link, in days; '' never expires. */
const EXPIRY_DAYS = ['', '1', '7', '30', '90'];

/** Positive integer from a path segment, else null. */
function versionParam(value: string): number | null {
  return /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
}

/**
 * The web UI, mounted at / on the app host behind Authentik forward auth. The signed-in user comes
 * from X-authentik-email (or DEV_USER locally). Every POST must come from the app origin.
 */
export function createUiRoutes(deps: Deps): Hono {
  const { config, artifacts, comments, tokens, shareLinks, signer } = deps;
  const csp = contentSecurityPolicy(config.contentOrigin);
  const ui = new Hono<Env>();

  const notFound = (c: Context<Env>) =>
    c.html(messagePage(c.get('user') ?? null, 'Not found', 'There is nothing here.'), 404);

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
    if (!user) {
      return c.html(messagePage(null, 'Not signed in', 'Sign in through Authentik first.'), 401);
    }
    c.set('user', user);
    await next();
  });

  ui.use('*', async (c, next) => {
    const safe = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (!safe && c.req.header('origin') !== config.appOrigin) {
      return c.html(
        messagePage(c.get('user'), 'Forbidden', 'This request did not come from this site.'),
        403,
      );
    }
    await next();
  });

  ui.get('/static/app.js', (c) => {
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    return c.body(APP_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  });

  const openCounts = (items: { id: string }[]) => comments.openCounts(items.map((a) => a.id));

  ui.get('/', async (c) => {
    const format = c.req.query('format');
    const cursor = c.req.query('cursor') || undefined;
    const query = (c.req.query('q') ?? '').trim().slice(0, 200);
    if (query) {
      const page = await artifacts.search({ query, cursor, limit: 20 });
      return c.html(
        searchPage({
          user: c.get('user'),
          query,
          hits: page.items,
          nextCursor: page.nextCursor,
          openComments: await openCounts(page.items.map((hit) => hit.artifact)),
        }),
      );
    }
    const page = await artifacts.list({
      format: isFormat(format) ? format : undefined,
      cursor,
      limit: 20,
    });
    return c.html(
      listPage({
        user: c.get('user'),
        items: page.items,
        nextCursor: page.nextCursor,
        format: isFormat(format) ? format : undefined,
        openComments: await openCounts(page.items),
      }),
    );
  });

  const showArtifact = async (
    c: Context<Env>,
    id: string,
    versionNumber?: number,
    created?: { url: string; link: ShareLink },
  ) => {
    const found = await artifacts.get(id, versionNumber);
    const versions = found ? await artifacts.listVersions(id) : null;
    const links = found ? await shareLinks.list(id) : null;
    const threads = found ? await comments.list(id, 'all') : null;
    if (!found || !versions || !links || !threads) return notFound(c);
    const { artifact, version } = found;
    return c.html(
      artifactPage({
        user: c.get('user'),
        artifact,
        version,
        versions,
        threads,
        url: (path) => signer.url(artifact.id, version.version, path),
        // Rendered into the page only for an artifact that declares the viewer capability.
        viewer: artifact.capabilities.viewer
          ? { email: c.get('user'), name: c.req.header('x-authentik-name') ?? '' }
          : null,
        shareLinks: links,
        createdLink: created,
      }),
    );
  };

  ui.get('/a/:id', (c) => showArtifact(c, c.req.param('id')));
  ui.get('/a/:id/v/:version', (c) => {
    const version = versionParam(c.req.param('version'));
    return version === null ? notFound(c) : showArtifact(c, c.req.param('id'), version);
  });

  ui.post('/a/:id/delete', async (c) => {
    if (!(await artifacts.delete(c.req.param('id')))) return notFound(c);
    return c.redirect('/', 303);
  });

  ui.post('/a/:id/v/:version/restore', async (c) => {
    const version = versionParam(c.req.param('version'));
    if (version === null) return notFound(c);
    const restored = await artifacts.restoreVersion(c.req.param('id'), version, c.get('user'));
    return c.redirect(`/a/${encodeURIComponent(restored.id)}`, 303);
  });

  ui.get('/trash', async (c) =>
    c.html(trashPage({ user: c.get('user'), items: await artifacts.listDeleted() })),
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
    return showArtifact(c, id, pin, { url, link: created.link });
  });

  ui.post('/a/:id/share/:link/revoke', async (c) => {
    const id = c.req.param('id');
    if (!(await shareLinks.revoke(id, c.req.param('link')))) return notFound(c);
    return c.redirect(`/a/${encodeURIComponent(id)}`, 303);
  });

  // Comments from this UI are the signed-in owner's own words: the only place `typed` is true.
  const owner = (c: Context<Env>) => ({ name: c.get('user'), typed: true });

  /** Back to the version the form was on (the plain artifact URL for the latest), at the thread. */
  const backTo = async (c: Context<Env>, id: string, form: Form, threadId: string) => {
    const latest = (await artifacts.get(id))?.artifact.latestVersion;
    const version = versionParam(field(form, 'version'));
    const path = version && version !== latest ? `/v/${version}` : '';
    return c.redirect(`/a/${encodeURIComponent(id)}${path}#thread-${threadId}`, 303);
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

  ui.get('/settings/tokens', async (c) =>
    c.html(tokensPage({ user: c.get('user'), tokens: await tokens.list() })),
  );

  ui.post('/settings/tokens', async (c) => {
    const body = await c.req.parseBody();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) {
      const page = tokensPage({
        user: c.get('user'),
        tokens: await tokens.list(),
        error: 'Give the token a name of at most 100 characters.',
      });
      return c.html(page, 400);
    }
    const created = await tokens.create(name);
    c.header('Cache-Control', 'no-store');
    return c.html(tokensPage({ user: c.get('user'), tokens: await tokens.list(), created }));
  });

  ui.post('/settings/tokens/:id/revoke', async (c) => {
    if (!(await tokens.revoke(c.req.param('id')))) return notFound(c);
    return c.redirect('/settings/tokens', 303);
  });

  ui.get('/connect', (c) =>
    c.html(connectPage({ user: c.get('user'), appOrigin: config.appOrigin })),
  );

  ui.get('/docs/runtime', (c) => c.html(docsRuntimePage({ user: c.get('user') })));

  ui.route('/api', createApiRoutes(deps));

  ui.all('*', notFound);

  ui.onError((err, c) => {
    if (err instanceof AppError && err.code === 'not_found') return notFound(c);
    if (err instanceof AppError && err.code === 'invalid_input') {
      return c.html(messagePage(c.get('user') ?? null, 'Bad request', err.message), 400);
    }
    console.error('ui error', err);
    return c.html(
      messagePage(c.get('user') ?? null, 'Something went wrong', 'The error has been logged.'),
      500,
    );
  });

  return new Hono().route('/', ui);
}
