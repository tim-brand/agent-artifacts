import { type Context, Hono } from 'hono';
import { AppError, type Deps, type Format } from '../contracts.ts';
import { contentSecurityPolicy } from './layout.ts';
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

const isFormat = (value: string | undefined): value is Format => FORMATS.includes(value as Format);

/** Positive integer from a path segment, else null. */
function versionParam(value: string): number | null {
  return /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
}

/**
 * The web UI, mounted at / on the app host behind Authentik forward auth. The signed-in user comes
 * from X-authentik-email (or DEV_USER locally). Every POST must come from the app origin.
 */
export function createUiRoutes(deps: Deps): Hono {
  const { config, artifacts, tokens, signer } = deps;
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

  ui.get('/', async (c) => {
    const format = c.req.query('format');
    const cursor = c.req.query('cursor') || undefined;
    const query = (c.req.query('q') ?? '').trim().slice(0, 200);
    if (query) {
      const page = await artifacts.search({ query, cursor, limit: 20 });
      return c.html(
        searchPage({ user: c.get('user'), query, hits: page.items, nextCursor: page.nextCursor }),
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
      }),
    );
  });

  const showArtifact = async (c: Context<Env>, id: string, versionNumber?: number) => {
    const found = await artifacts.get(id, versionNumber);
    const versions = found ? await artifacts.listVersions(id) : null;
    if (!found || !versions) return notFound(c);
    const { artifact, version } = found;
    return c.html(
      artifactPage({
        user: c.get('user'),
        artifact,
        version,
        versions,
        url: (path) => signer.url(artifact.id, version.version, path),
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
