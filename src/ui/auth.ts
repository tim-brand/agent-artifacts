// Helpers of the built-in sign-in (AUTH_MODE=password). Only src/ui/ may read the session cookie.

/** The longest `next` value accepted. */
const MAX_NEXT = 4096;

/**
 * Where to go after signing in: a path (and query) on this app, else '/'. The value comes from a
 * query string or a form field, so it is untrusted. It must start with a single "/", have no
 * backslash or control character, and resolve to the app's own origin. Only the path and query of
 * the parsed result are used, and that result is checked again for a leading "//" because dot
 * segments are removed while parsing ("/.//evil.example" becomes "//evil.example"). The sign-in
 * pages themselves are never a target.
 */
export function safeNext(value: unknown, appOrigin: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NEXT) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  // A percent-encoded backslash is a harmless path character, but some clients decode it: refuse.
  if (/%5c/i.test(value)) return '/';
  let url: URL;
  try {
    url = new URL(value, appOrigin);
  } catch {
    return '/';
  }
  if (url.origin !== appOrigin) return '/';
  const next = `${url.pathname}${url.search}`;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  // The router decodes percent-escapes, so compare the decoded path: "/%6Cogin" is /login.
  let decoded = url.pathname;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return '/';
  }
  if (['/login', '/logout'].includes(decoded.replace(/\/+$/, ''))) return '/';
  return next;
}

/** The most characters of an email that are kept (the longest legal address is 254). */
export const MAX_EMAIL = 254;
