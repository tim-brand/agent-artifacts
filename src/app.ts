import { Hono } from 'hono';
import { createContentRoutes } from './content/routes.ts';
import type { Deps } from './contracts.ts';
import { createMcpRoutes } from './mcp/routes.ts';
import { createUiRoutes } from './ui/routes.ts';

/**
 * One process serves both hosts; the Host header picks the app.
 *
 * App host (behind Authentik forward auth, except /mcp and /healthz):
 *   /mcp      MCP over streamable HTTP, bearer token auth (mcp/)
 *   /healthz  liveness, no auth
 *   /*        web UI, trusts X-authentik-email (ui/)
 * Content host (no forward auth, no cookies):
 *   /s/...    signed artifact files (content/)
 *   /p/...    public share links, rate limited (content/)
 *
 * Security: forward auth is skipped on /mcp, so a client can send any X-authentik-* header there.
 * Only ui/ may read those headers, and ui/ must never be mounted on a path the ingress leaves open.
 */
export function createApp(deps: Deps): Hono {
  const contentHost = new URL(deps.config.contentOrigin).host;
  const app = new Hono();
  const appHost = new Hono();
  const content = createContentRoutes(deps);

  appHost.get('/healthz', (c) => c.text('ok'));
  appHost.route('/mcp', createMcpRoutes(deps));
  appHost.route('/', createUiRoutes(deps));

  app.all('*', (c) => {
    const host = c.req.header('host');
    const target = host === contentHost ? content : appHost;
    return target.fetch(c.req.raw, c.env);
  });
  return app;
}
