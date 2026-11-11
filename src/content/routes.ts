import { Hono } from 'hono';
import type { Deps } from '../contracts.ts';
import { renderCode, renderMarkdown } from './render.ts';

/**
 * The content host: serves untrusted, agent-written files under signed, short-lived URLs
 *   /s/<exp>.<sig>/<id>/<version>/<path>
 * It has no auth and no cookies. Its isolation is the app's security boundary:
 * - every document gets a CSP sandbox (an opaque origin, even when opened directly in a tab), except
 *   PDFs, which Chrome won't render sandboxed; they still get frame-ancestors;
 * - only the app origin may frame it;
 * - nothing here ever sets a cookie.
 */

const SANDBOX =
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads allow-modals';
const MAX_AGE = 3600;
const TEXT = 'text/plain; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

type Target = { exp: number; sig: string; id: string; version: number; path: string[] };

export function createContentRoutes(deps: Deps): Hono {
  const app = new Hono();
  const { appOrigin } = deps.config;

  const error = (status: 403 | 404 | 500, message: string) =>
    new Response(message, {
      status,
      headers: { ...securityHeaders(appOrigin, TEXT), 'Cache-Control': 'no-store' },
    });

  // Hono runs HEAD through this handler as a GET and drops the body.
  app.all('*', async (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return error(404, 'Not found');
    const target = parse(new URL(c.req.url).pathname);
    if (target === 'not_found') return error(404, 'Not found');
    if (target === 'forbidden') return error(403, 'Link expired or invalid');

    const { exp, sig, id, version } = target;
    if (!deps.signer.verify(id, version, exp, sig)) return error(403, 'Link expired or invalid');
    if (target.path.length === 0) return error(404, 'Not found');
    const path = target.path.join('/');

    const found = await deps.artifacts.get(id, version);
    if (!found) return error(404, 'Not found');
    const file = await deps.artifacts.readFile(id, version, path);
    if (!file) return error(404, 'Not found');

    const { format, entry, files } = found.version;
    const render =
      path === entry && (format === 'markdown' || format === 'code') && c.req.query('raw') !== '1';
    const sha256 = files.find((f) => f.path === path)?.sha256;
    const contentType = render ? HTML : file.contentType;
    const headers: Record<string, string> = {
      ...securityHeaders(appOrigin, contentType),
      'Cache-Control': `private, max-age=${maxAge(exp)}`,
    };
    // Version content is immutable, so the file hash is a strong validator.
    if (sha256) headers.ETag = `"${sha256}${render ? '-rendered' : ''}"`;
    if (headers.ETag && c.req.header('if-none-match') === headers.ETag) {
      return new Response(null, { status: 304, headers });
    }

    if (!render) return new Response(file.bytes as Uint8Array<ArrayBuffer>, { headers });
    const source = new TextDecoder().decode(file.bytes);
    const { title } = found.artifact;
    const body =
      format === 'markdown' ? renderMarkdown(title, source) : renderCode(title, path, source);
    return new Response(body, { headers });
  });

  app.onError(() => error(500, 'Internal error'));
  return app;
}

function securityHeaders(appOrigin: string, contentType: string): Record<string, string> {
  const frameAncestors = `frame-ancestors ${appOrigin}`;
  const pdf = contentType.trim().toLowerCase().startsWith('application/pdf');
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': pdf ? frameAncestors : `${SANDBOX}; ${frameAncestors}`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Not same-origin or same-site: the sandbox gives artifact documents an opaque origin, so to the
    // browser the artifact's own <img>, <script> and <link> loads from this host are cross-origin and
    // a stricter CORP would block them. The signed URL is the capability; anyone holding it can open
    // it anyway, so CORP would protect nothing here.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    // For the same reason, module scripts and fetch() from a sandboxed artifact to its own files are
    // CORS requests with `Origin: null`. No credentials exist on this host, so `*` exposes nothing a
    // holder of the URL can't already GET.
    'Access-Control-Allow-Origin': '*',
  };
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
