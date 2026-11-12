import { createHash, timingSafeEqual } from 'node:crypto';

// The OAuth 2.1 rules shared by the token store (core/oauth.ts), the public endpoints (routes.ts)
// and the consent page (ui/). Pure functions only.

export const OAUTH_TTL = {
  /** Authorization codes are single-use and short-lived. */
  codeSeconds: 60,
  accessSeconds: 60 * 60,
  /** A refresh token lives this long; every refresh rotates it and starts over. */
  refreshSeconds: 30 * 24 * 60 * 60,
  /** A registered client nobody signed in with (or used) for this long is removed. */
  unusedClientDays: 30,
} as const;

export const OAUTH_LIMITS = {
  redirectUris: 10,
  redirectUriLength: 2000,
  clientName: 100,
  state: 1000,
  scope: 1000,
} as const;

/**
 * The OAuth paths the proxy leaves open (no sign-in, identity headers blanked), each exact:
 * GET for the metadata, POST for register and token. The consent page, /oauth/authorize, is not
 * one of them: it stays behind forward auth.
 */
export const PUBLIC_OAUTH_PATHS: readonly string[] = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/mcp',
  '/oauth/register',
  '/oauth/token',
];

/** The MCP endpoint is the only protected resource (RFC 8707, RFC 9728). */
export const mcpResource = (appOrigin: string) => `${appOrigin}/mcp`;

/** Where the metadata of the protected resource lives (RFC 9728); the 401 points here. */
export const resourceMetadataUrl = (appOrigin: string) =>
  `${appOrigin}/.well-known/oauth-protected-resource`;

// A loopback redirect: RFC 8252 7.3. The port is the client's choice per sign-in, so matching
// ignores it. Captures: host, port, rest (path, query).
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?(\/[^#]*)?$/;

/** Why a redirect URI can't be registered, or null when it can: https, or http on loopback. */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri) return 'a redirect URI must be a non-empty string';
  if (uri.length > OAUTH_LIMITS.redirectUriLength) return 'a redirect URI is too long';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000- \u007f\\]/.test(uri)) return 'a redirect URI must not contain spaces';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `${uri} is not an absolute URL`;
  }
  if (uri.includes('#')) return 'a redirect URI must not have a fragment';
  if (url.username || url.password) return 'a redirect URI must not carry credentials';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK.test(uri)) return null;
  return 'a redirect URI must be https, or http on 127.0.0.1, localhost or [::1]';
}

/**
 * Exact string match, except that for a loopback URI the port may differ (RFC 8252 7.3): host,
 * path and query must still match exactly.
 */
export function redirectUriMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  const a = LOOPBACK.exec(registered);
  const b = LOOPBACK.exec(given);
  if (!a || !b) return false;
  return a[1] === b[1] && (a[3] ?? '') === (b[3] ?? '') && validPort(b[2]);
}

const validPort = (port: string | undefined) =>
  port === undefined || (Number(port) > 0 && Number(port) < 65536);

/** Loopback redirects say "an app on this computer"; others show their host. */
export const isLoopback = (uri: string) => LOOPBACK.test(uri);

// PKCE (RFC 7636): verifier and challenge are 43 to 128 unreserved characters.
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;
export const isPkceValue = (value: string) => PKCE.test(value);

export const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** Constant-time: does the verifier hash to the challenge? */
export function pkceMatches(challenge: string, verifier: string): boolean {
  if (!isPkceValue(verifier)) return false;
  return safeEqual(s256(verifier), challenge);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * A `resource` parameter names the MCP endpoint when it is that URL, accepting an upper-case scheme
 * or host and a trailing slash. Anything else, a query or a fragment included, does not.
 */
export function isMcpResource(resource: string, appOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return false;
  }
  if (url.search || url.hash || resource.includes('#')) return false;
  const path = url.pathname.replace(/\/$/, '');
  return `${url.origin}${path}` === mcpResource(appOrigin);
}

/** Client names are shown on the consent page: one line of plain text. */
export function cleanClientName(name: unknown): string {
  const text = typeof name === 'string' ? name : '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what goes
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ');
  return clean.replace(/\s+/g, ' ').trim().slice(0, OAUTH_LIMITS.clientName) || 'MCP client';
}
