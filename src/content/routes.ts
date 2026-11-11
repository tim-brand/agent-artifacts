import { Hono, type HonoRequest } from 'hono';
import type { ArtifactService, Deps } from '../contracts.ts';
import { createRateLimiter } from './rate-limit.ts';
import { renderCode, renderImage, renderMarkdown } from './render.ts';

/**
 * The content host: serves untrusted, agent-written files under
 *   /s/<exp>.<sig>/<id>/<version>/<path>   signed, short-lived URLs, framed by the app
 *   /p/<token>/<path>                      public share links, opened top-level
 * It has no auth and no cookies. Its isolation is the app's security boundary:
 * - every document gets a CSP sandbox (an opaque origin, even when opened directly in a tab), except
 *   PDFs, which Chrome won't render sandboxed; they still get frame-ancestors;
 * - only the app origin may frame /s/, and nothing may frame /p/;
 * - nothing here ever sets a cookie.
 */

const SANDBOX =
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads allow-modals';
const MAX_AGE = 3600;
/** Short, so a revoked pinned link stops working soon even in a browser that cached it. */
const PINNED_MAX_AGE = 300;
const TEXT = 'text/plain; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

/** How /s/ and /p/ responses differ. */
type Policy = {
  frameAncestors: string;
  cacheControl: string;
  headers?: Record<string, string>;
};

const PUBLIC: Policy = {
  frameAncestors: "'none'",
  cacheControl: 'no-store',
  headers: { 'X-Robots-Tag': 'noindex, nofollow' },
};

type Target = { exp: number; sig: string; id: string; version: number; path: string[] };

export function createContentRoutes(deps: Deps): Hono {
  const app = new Hono();
  const signed: Policy = { frameAncestors: deps.config.appOrigin, cacheControl: 'no-store' };
  const limiter = createRateLimiter({ capacity: 60, perMinute: 60 });

  const error = (status: 403 | 404 | 429 | 500, message: string, policy = signed) =>
    new Response(message, {
      status,
      headers: { ...securityHeaders(TEXT, policy), 'Cache-Control': 'no-store' },
    });

  const signedFile = async (req: HonoRequest, pathname: string) => {
    const target = parse(pathname);
    if (target === 'not_found') return error(404, 'Not found');
    if (target === 'forbidden') return error(403, 'Link expired or invalid');

    const { exp, sig, id, version } = target;
    if (!deps.signer.verify(id, version, exp, sig)) return error(403, 'Link expired or invalid');
    if (target.path.length === 0) return error(404, 'Not found');
    const policy = { ...signed, cacheControl: `private, max-age=${maxAge(exp)}` };
    const res = await serveFile(deps.artifacts, req, id, version, target.path.join('/'), policy);
    return res ?? error(404, 'Not found');
  };

  // Unknown, revoked, expired and deleted all get the same 404, so a token can't be probed.
  const publicFile = async (req: HonoRequest, pathname: string) => {
    if (!limiter.take(clientIp(req))) {
      const res = error(429, 'Too many requests', PUBLIC);
      res.headers.set('Retry-After', '1');
      return res;
    }
    const target = parsePublic(pathname);
    const shared = target ? await deps.shareLinks.resolve(target.token) : null;
    if (!target || !shared) return error(404, 'Not found', PUBLIC);
    const { artifactId } = shared.link;

    // The link itself is /p/<token>/: send it to the entry, so relative links resolve against it.
    if (target.path.length === 0) {
      const found = await deps.artifacts.get(artifactId, shared.version);
      if (!found) return error(404, 'Not found', PUBLIC);
      const entry = found.version.entry.split('/').map(encodeURIComponent).join('/');
      const headers = securityHeaders(TEXT, PUBLIC);
      headers['Cache-Control'] = 'no-store';
      headers.Location = `/p/${target.token}/${entry}`;
      return new Response(null, { status: 302, headers });
    }

    const pinned = shared.link.version !== null;
    const policy = {
      ...PUBLIC,
      cacheControl: pinned ? `private, max-age=${PINNED_MAX_AGE}` : 'no-store',
    };
    const res = await serveFile(
      deps.artifacts,
      req,
      artifactId,
      shared.version,
      target.path.join('/'),
      policy,
    );
    return res ?? error(404, 'Not found', PUBLIC);
  };

  // Hono runs HEAD through this handler as a GET and drops the body.
  app.all('*', async (c) => {
    const { pathname } = new URL(c.req.url);
    const isPublic = pathname.startsWith('/p/');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return error(404, 'Not found', isPublic ? PUBLIC : signed);
    }
    return isPublic ? publicFile(c.req, pathname) : signedFile(c.req, pathname);
  });

  app.onError((_, c) =>
    error(500, 'Internal error', new URL(c.req.url).pathname.startsWith('/p/') ? PUBLIC : signed),
  );
  return app;
}

/** One file of a version, rendered when it's a markdown, code or image entry. Null when not found. */
async function serveFile(
  artifacts: ArtifactService,
  req: HonoRequest,
  id: string,
  version: number,
  path: string,
  policy: Policy,
): Promise<Response | null> {
  const found = await artifacts.get(id, version);
  if (!found) return null;
  const file = await artifacts.readFile(id, version, path);
  if (!file) return null;

  const { format, entry, files } = found.version;
  const render =
    path === entry &&
    (format === 'markdown' || format === 'code' || format === 'image') &&
    req.query('raw') !== '1';
  const sha256 = files.find((f) => f.path === path)?.sha256;
  const contentType = render ? HTML : file.contentType;
  const headers = securityHeaders(contentType, policy);
  // Version content is immutable, so the file hash is a strong validator.
  if (sha256) headers.ETag = `"${sha256}${render ? '-rendered' : ''}"`;
  if (headers.ETag && req.header('if-none-match') === headers.ETag) {
    return new Response(null, { status: 304, headers });
  }

  if (!render) return new Response(file.bytes as Uint8Array<ArrayBuffer>, { headers });
  const { title } = found.artifact;
  if (format === 'image') return new Response(renderImage(title, path), { headers });
  const source = new TextDecoder().decode(file.bytes);
  const body =
    format === 'markdown' ? renderMarkdown(title, source) : renderCode(title, path, source);
  return new Response(body, { headers });
}

function securityHeaders(contentType: string, policy: Policy): Record<string, string> {
  const frameAncestors = `frame-ancestors ${policy.frameAncestors}`;
  const pdf = contentType.trim().toLowerCase().startsWith('application/pdf');
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': pdf ? frameAncestors : `${SANDBOX}; ${frameAncestors}`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Not same-origin or same-site: the sandbox gives artifact documents an opaque origin, so to the
    // browser the artifact's own <img>, <script> and <link> loads from this host are cross-origin and
    // a stricter CORP would block them. The URL is the capability; anyone holding it can open it
    // anyway, so CORP would protect nothing here.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    // For the same reason, module scripts and fetch() from a sandboxed artifact to its own files are
    // CORS requests with `Origin: null`. No credentials exist on this host, so `*` exposes nothing a
    // holder of the URL can't already GET.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': policy.cacheControl,
    ...policy.headers,
  };
}

/** The ingress sets X-Forwarded-For. Without it, everyone shares one bucket. */
function clientIp(req: HonoRequest): string {
  return req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

function maxAge(exp: number): number {
  return Math.max(0, Math.min(MAX_AGE, exp - Math.floor(Date.now() / 1000)));
}

/** Strict parse of /s/<exp>.<sig>/<id>/<version>/<path...>. Core validates paths too. */
function parse(pathname: string): Target | 'not_found' | 'forbidden' {
  const [empty, s, token, rawId, rawVersion, ...rest] = pathname.split('/');
  if (empty !== '' || s !== 's' || !token) return 'not_found';
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{1,128})$/.exec(token);
  const id = rawId === undefined ? null : segment(rawId);
  if (!match?.[1] || !match[2] || !id || !rawVersion || !/^[1-9]\d{0,8}$/.test(rawVersion)) {
    return 'forbidden';
  }
  const path: string[] = [];
  for (const raw of rest) {
    const decoded = segment(raw);
    if (decoded === null) return 'not_found';
    path.push(decoded);
  }
  return { exp: Number(match[1]), sig: match[2], id, version: Number(rawVersion), path };
}

/** Strict parse of /p/<token>/<path...>; an empty path is the link itself. */
function parsePublic(pathname: string): { token: string; path: string[] } | null {
  const [empty, p, token, ...rest] = pathname.split('/');
  if (empty !== '' || p !== 'p' || !token || !/^sl_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  if (rest.length === 1 && rest[0] === '') return { token, path: [] };
  const path: string[] = [];
  for (const raw of rest) {
    const decoded = segment(raw);
    if (decoded === null) return null;
    path.push(decoded);
  }
  return { token, path };
}

/** One decoded path segment, or null for anything that could escape or confuse a file path. */
function segment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded === '' || decoded === '.' || decoded === '..') return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[/\\\u0000-\u001f\u007f]/.test(decoded)) return null;
  return decoded;
}
