import { Hono } from 'hono';
import { createContentRoutes } from './content/routes.ts';
import type { Deps } from './contracts.ts';
import { createMcpRoutes } from './mcp/routes.ts';
import { createOAuthRoutes } from './oauth/routes.ts';
import { createUiRoutes } from './ui/routes.ts';

/**
 * One process serves both hosts; the Host header picks the app.
 *
 * App host (behind a sign-in proxy, except /mcp, the public OAuth paths and /healthz):
 *   /mcp      MCP over streamable HTTP, bearer token auth: a PAT or an OAuth access token (mcp/)
 *   /.well-known/oauth-*, /oauth/register, /oauth/token
 *             OAuth discovery, client registration and tokens, no auth (oauth/)
 *   /healthz  liveness, no auth, answers on any host (a probe may use the pod's IP)
 *   /*        web UI, trusts the identity header (AUTH_EMAIL_HEADER) (ui/), including the consent
 *             page /oauth/authorize
 * Content host (no forward auth, no cookies):
 *   /s/...    signed artifact files (content/)
 *   /p/...    public share links, rate limited (content/)
 * Any other Host: 404, so the UI is never reachable through a name nobody configured.
 *
 * Security: the proxy's sign-in is skipped on /mcp and the public OAuth paths, so a client can send
 * any identity header there. Only ui/ may read those headers, and ui/ must never be mounted on a
 * path the proxy leaves open (PUBLIC_OAUTH_PATHS in oauth/rules.ts lists the OAuth ones).
 */
export function createApp(deps: Deps): Hono {
  const contentHost = new URL(deps.config.contentOrigin).host.toLowerCase();
  const appHostName = new URL(deps.config.appOrigin).host.toLowerCase();
  const app = new Hono();
  const appHost = new Hono();
  const content = createContentRoutes(deps);

  appHost.get('/healthz', (c) => c.text('ok'));
  appHost.route('/mcp', createMcpRoutes(deps));
  appHost.route('/', createOAuthRoutes(deps));
  appHost.route('/', createUiRoutes(deps));

  app.all('*', (c) => {
    if (c.req.path === '/healthz' && c.req.method === 'GET') return c.text('ok');
    const host = c.req.header('host')?.toLowerCase();
    if (host === contentHost) return content.fetch(c.req.raw, c.env);
    if (host === appHostName) return appHost.fetch(c.req.raw, c.env);
    return c.text(
      'Unknown host. APP_ORIGIN and CONTENT_ORIGIN must be the public origins of this app, ' +
        'and the reverse proxy must pass the Host header through.\n',
      404,
    );
  });
  return app;
}
