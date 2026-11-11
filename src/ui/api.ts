import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createRateLimiter } from '../content/rate-limit.ts';
import { AppError, DATA_LIMITS, type DataDoc, type Deps } from '../contracts.ts';

type Env = { Variables: { user: string } };

const STATUS = {
  not_found: 404,
  invalid_input: 400,
  forbidden: 403,
  too_large: 413,
} as const;

/**
 * The data API of live pages, for the shell in app.js; mounted at /api in the UI, so it sits behind
 * forward auth and the UI's Origin check on every write. The artifact page's frame never calls it
 * itself: it has an opaque origin and no session.
 *
 *   GET    /api/artifacts/:id/data?cursor=&limit=   list, by id
 *   GET    /api/artifacts/:id/data?since=<rev>      changes, for polling
 *   GET    /api/artifacts/:id/data/:doc             { doc } (null when missing)
 *   PUT    /api/artifacts/:id/data/:doc             { data } -> { doc }
 *   PATCH  /api/artifacts/:id/data/:doc             { fields } -> { doc }, top-level merge
 *   DELETE /api/artifacts/:id/data/:doc             { deleted }
 *   POST   /api/artifacts/:id/query                 { where, orderBy, order, limit } -> { items }
 *
 * The data service checks the artifact's db capability on every call. updatedBy is someone's
 * email, so it is only shown to a page that declares the viewer capability.
 */
export function createApiRoutes(deps: Deps): Hono<Env> {
  const { artifacts, data } = deps;
  const api = new Hono<Env>();
  // Per artifact: a burst of 60 writes, then one a second, so a runaway loop can't churn the disk.
  const writes = createRateLimiter({ capacity: 60, perMinute: 60 });

  // A document's JSON plus its envelope ({"data": ...}).
  api.use(
    '*',
    bodyLimit({
      maxSize: DATA_LIMITS.docBytes + 1024,
      onError: (c) => c.json({ error: 'too_large', message: 'The request body is too large' }, 413),
    }),
  );

  const viewerSees = async (id: string) =>
    (await artifacts.get(id))?.artifact.capabilities.viewer === true;
  const shown = async (id: string) => {
    const withAuthor = await viewerSees(id);
    return <T extends Omit<DataDoc, 'data'>>(doc: T) => {
      if (withAuthor) return doc;
      const { updatedBy: _, ...rest } = doc;
      return rest;
    };
  };

  const body = async (c: Context<Env>): Promise<Record<string, unknown>> => {
    const value: unknown = await c.req.json().catch(() => undefined);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new AppError('invalid_input', 'The body is a JSON object');
    }
    return value as Record<string, unknown>;
  };

  api.on(['PUT', 'PATCH', 'DELETE'], '/artifacts/:id/data/:doc', async (c, next) => {
    if (!writes.take(c.req.param('id'))) {
      c.header('Retry-After', '1');
      return c.json({ error: 'rate_limited', message: 'Too many writes; slow down' }, 429);
    }
    await next();
  });

  api.get('/artifacts/:id/data', async (c) => {
    const id = c.req.param('id');
    const since = c.req.query('since');
    const show = await shown(id);
    if (since !== undefined) {
      if (!/^\d{1,15}$/.test(since)) throw new AppError('invalid_input', 'since is a revision');
      const changes = await data.changes(id, Number(since));
      return c.json({ ...changes, items: changes.items.map(show) });
    }
    const limit = c.req.query('limit');
    const page = await data.list(id, {
      cursor: c.req.query('cursor'),
      limit: limit === undefined ? undefined : Number(limit),
    });
    return c.json({ ...page, items: page.items.map(show) });
  });

  api.get('/artifacts/:id/data/:doc', async (c) => {
    const id = c.req.param('id');
    const doc = await data.get(id, c.req.param('doc'));
    return c.json({ doc: doc && (await shown(id))(doc) });
  });

  api.put('/artifacts/:id/data/:doc', async (c) => {
    const id = c.req.param('id');
    const { data: value } = await body(c);
    const doc = await data.set(id, c.req.param('doc'), value as DataDoc['data'], c.get('user'));
    return c.json({ doc: (await shown(id))(doc) });
  });

  api.patch('/artifacts/:id/data/:doc', async (c) => {
    const id = c.req.param('id');
    const { fields } = await body(c);
    const doc = await data.update(id, c.req.param('doc'), fields as DataDoc['data'], c.get('user'));
    return c.json({ doc: (await shown(id))(doc) });
  });

  api.delete('/artifacts/:id/data/:doc', async (c) => {
    const deleted = await data.delete(c.req.param('id'), c.req.param('doc'), c.get('user'));
    return c.json({ deleted });
  });

  api.post('/artifacts/:id/query', async (c) => {
    const id = c.req.param('id');
    const { where, orderBy, order, limit } = await body(c);
    const items = await data.query(id, {
      where: where as never,
      orderBy: orderBy as never,
      order: order as never,
      limit: limit as never,
    });
    const show = await shown(id);
    return c.json({ items: items.map(show) });
  });

  api.all('*', (c) => c.json({ error: 'not_found', message: 'No such API route' }, 404));

  api.onError((err, c) => {
    if (err instanceof AppError && err.code in STATUS) {
      return c.json(
        { error: err.code, message: err.message },
        STATUS[err.code as keyof typeof STATUS],
      );
    }
    console.error('api error', err);
    return c.json({ error: 'internal_error', message: 'Something went wrong' }, 500);
  });

  return api;
}
