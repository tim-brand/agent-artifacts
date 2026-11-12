import { Hono } from 'hono';
import { createContentRoutes } from './content/routes.ts';
import type { Deps } from './contracts.ts';
import { createMcpRoutes } from './mcp/routes.ts';
import { createOAuthRoutes } from './oauth/routes.ts';
import { createUiRoutes } from './ui/routes.ts';

/**
 * One process serves both hosts; the Host header picks the app.
 *
 * App host (behind Authentik forward auth, except /mcp, the public OAuth paths and /healthz):
 *   /mcp      MCP over streamable HTTP, bearer token auth: a PAT or an OAuth access token (mcp/)
 *   /.well-known/oauth-*, /oauth/register, /oauth/token
 *             OAuth discovery, client registration and tokens, no auth (oauth/)
 *   /healthz  liveness, no auth
 *   /*        web UI, trusts X-authentik-email (ui/), including the consent page /oauth/authorize
 * Content host (no forward auth, no cookies):
 *   /s/...    signed artifact files (content/)
 *   /p/...    public share links, rate limited (content/)
 *
 * Security: forward auth is skipped on /mcp and the public OAuth paths, so a client can send any
 * X-authentik-* header there. Only ui/ may read those headers, and ui/ must never be mounted on a
 * path the ingress leaves open (PUBLIC_OAUTH_PATHS in oauth/rules.ts lists the OAuth ones).
 */
export function createApp(deps: Deps): Hono {
  const contentHost = new URL(deps.config.contentOrigin).host;
  const app = new Hono();
  const appHost = new Hono();
  const content = createContentRoutes(deps);

  appHost.get('/healthz', (c) => c.text('ok'));
  appHost.route('/mcp', createMcpRoutes(deps));
  appHost.route('/', createOAuthRoutes(deps));
  appHost.route('/', createUiRoutes(deps));

  app.all('*', (c) => {
    const host = c.req.header('host');
    const target = host === contentHost ? content : appHost;
    return target.fetch(c.req.raw, c.env);
  });
  return app;
}
