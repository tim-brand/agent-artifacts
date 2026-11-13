import { type Context, Hono } from 'hono';
import { clientAddress, createRateLimiter } from '../content/rate-limit.ts';
import { type Deps, OAuthError, type OAuthErrorCode, type OAuthService } from '../contracts.ts';
import { mcpResource } from './rules.ts';

/** The public part of the authorization server: discovery, registration and tokens. */
type OAuthDeps = {
  config: Deps['config'];
  oauth: Pick<OAuthService, 'register' | 'exchangeCode' | 'refresh'>;
};

const MAX_BODY_BYTES = 16 * 1024;

const STATUS: Partial<Record<OAuthErrorCode, 400 | 401 | 429 | 503>> = {
  invalid_client: 401,
  temporarily_unavailable: 503,
};

/** RFC 6749 5.2: a JSON error, never cached. */
function oauthError(
  c: Context,
  code: OAuthErrorCode,
  description: string,
  status?: 400 | 401 | 429 | 503,
) {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({ error: code, error_description: description }, status ?? STATUS[code] ?? 400);
}

const clientIp = (c: Context) => clientAddress(c.req.header('x-forwarded-for'));

async function readBody(c: Context): Promise<string | null> {
  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) return null;
  const reader = c.req.raw.body?.getReader();
  if (!reader) return '';
  // Count the bytes actually read: a chunked body has no Content-Length to trust.
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Mounted at / on the app host, before the UI, for the paths in PUBLIC_OAUTH_PATHS. Nothing here
 * reads the identity headers: the sign-in is off on these paths, so a client can send any.
 * The authorization endpoint itself (/oauth/authorize) is in ui/, behind forward auth.
 */
export function createOAuthRoutes(deps: OAuthDeps): Hono {
  const { config, oauth } = deps;
  const app = new Hono();
  const issuer = config.appOrigin;
  const resource = mcpResource(config.appOrigin);
  const registerIp = createRateLimiter({ capacity: 10, perMinute: 1 });
  const registerAll = createRateLimiter({ capacity: 60, perMinute: 10 });
  const tokenIp = createRateLimiter({ capacity: 30, perMinute: 30 });

  const protectedResource = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'Agent Artifacts',
    resource_documentation: `${issuer}/connect`,
  };
  const authorizationServer = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/connect`,
  };

  const metadata = (body: object) => (c: Context) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      c.header('Allow', 'GET');
      return c.json({ error: 'method_not_allowed' }, 405);
    }
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(body);
  };
  // RFC 9728 puts the resource's path after the well-known name; clients also try the root.
  app.all('/.well-known/oauth-protected-resource', metadata(protectedResource));
  app.all('/.well-known/oauth-protected-resource/mcp', metadata(protectedResource));
  // The issuer has no path, so RFC 8414's URL is the root one; some clients insert /mcp anyway.
  app.all('/.well-known/oauth-authorization-server', metadata(authorizationServer));
  app.all('/.well-known/oauth-authorization-server/mcp', metadata(authorizationServer));

  // Dynamic client registration (RFC 7591), public clients only.
  app.all('/oauth/register', async (c) => {
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST');
      return c.json({ error: 'method_not_allowed' }, 405);
    }
    if (!registerIp.take(clientIp(c)) || !registerAll.take('*')) {
      c.header('Retry-After', '60');
      return oauthError(
        c,
        'temporarily_unavailable',
        'Too many registrations; try again later',
        429,
      );
    }
    const text = await readBody(c);
    if (text === null) return oauthError(c, 'invalid_client_metadata', 'The request is too large');
    let meta: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      meta = parsed as Record<string, unknown>;
    } catch {
      return oauthError(c, 'invalid_client_metadata', 'The body must be a JSON object');
    }
    const grantTypes = meta.grant_types;
    if (
      grantTypes !== undefined &&
      (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code'))
    ) {
      return oauthError(
        c,
        'invalid_client_metadata',
        'grant_types must include authorization_code',
      );
    }
    const responseTypes = meta.response_types;
    if (
      responseTypes !== undefined &&
      (!Array.isArray(responseTypes) || !responseTypes.includes('code'))
    ) {
      return oauthError(c, 'invalid_client_metadata', 'response_types must include code');
    }
    try {
      const client = await oauth.register({
        clientName: meta.client_name,
        redirectUris: meta.redirect_uris,
      });
      c.header('Cache-Control', 'no-store');
      // Whatever auth method was asked for, the client is public: RFC 7591 3.2.1 lets the server
      // replace a value, and the response says what was registered.
      return c.json(
        {
          client_id: client.id,
          client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
          client_name: client.name,
          redirect_uris: client.redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        201,
      );
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(c, error.code, error.message);
      throw error;
    }
  });

  app.all('/oauth/token', async (c) => {
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST');
      return c.json({ error: 'method_not_allowed' }, 405);
    }
    if (!tokenIp.take(clientIp(c))) {
      c.header('Retry-After', '60');
      return oauthError(c, 'temporarily_unavailable', 'Too many requests; try again later', 429);
    }
    const type = c.req.header('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return oauthError(
        c,
        'invalid_request',
        'Send the parameters as application/x-www-form-urlencoded',
      );
    }
    const text = await readBody(c);
    if (text === null) return oauthError(c, 'invalid_request', 'The request is too large');
    const form = new URLSearchParams(text);
    // RFC 6749 3.2: parameters must not repeat.
    const keys = [...form.keys()];
    if (new Set(keys).size !== keys.length) {
      return oauthError(c, 'invalid_request', 'A parameter is repeated');
    }
    const param = (name: string) => form.get(name) ?? undefined;

    // A public client names itself with client_id; accept it from Basic auth too, without a secret.
    let clientId = param('client_id');
    const basic = c.req.header('authorization')?.match(/^Basic\s+(\S+)$/i)?.[1];
    if (!clientId && basic) {
      const decoded = Buffer.from(basic, 'base64').toString('utf8');
      clientId = decodeURIComponent(decoded.split(':')[0] ?? '');
    }
    if (!clientId) return oauthError(c, 'invalid_client', 'client_id is missing');

    try {
      const grantType = param('grant_type');
      let tokens: Awaited<ReturnType<OAuthDeps['oauth']['refresh']>>;
      if (grantType === 'authorization_code') {
        tokens = await oauth.exchangeCode({
          code: param('code') ?? '',
          clientId,
          redirectUri: param('redirect_uri'),
          codeVerifier: param('code_verifier'),
          resource: param('resource'),
        });
      } else if (grantType === 'refresh_token') {
        tokens = await oauth.refresh({
          refreshToken: param('refresh_token') ?? '',
          clientId,
          resource: param('resource'),
        });
      } else {
        return oauthError(
          c,
          grantType ? 'unsupported_grant_type' : 'invalid_request',
          grantType ? `grant_type ${grantType} is not supported` : 'grant_type is missing',
        );
      }
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      });
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(c, error.code, error.message);
      throw error;
    }
  });

  app.onError((error, c) => {
    // The error only: the request carries codes and tokens, so it is never logged.
    console.error('oauth error', error);
    return oauthError(c, 'temporarily_unavailable', 'Something went wrong; try again later', 503);
  });

  return app;
}
