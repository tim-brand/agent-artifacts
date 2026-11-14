# Security policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability", or go to <https://github.com/tim-brand/agent-artifacts/security/advisories/new>.

Do not report a vulnerability in a public issue or pull request.

A report helps most when it has:

- the version or commit you ran;
- how it is deployed (Docker or not, which reverse proxy, whether the app and content hosts are separate);
- steps to reproduce it, as short as you can make them;
- the impact: what an attacker gains, and what they need to start.

## What to expect

One person maintains this project in their spare time. Reports are read and answered as soon as possible, but there is no guaranteed response time. Fixes go to `master`. Only the latest version is supported.

## What counts as a vulnerability

The app makes these promises. Breaking one is a vulnerability:

- Artifact content only runs on the content origin, never on the app origin.
- The identity headers are trusted only in the web UI, and only with `AUTH_MODE=proxy` (the default), where the UI sits behind the sign-in proxy. Nothing else reads them: not `/mcp`, not the content host, not a public endpoint. With `AUTH_MODE=password` they are not read at all.
- With the built-in sign-in (`AUTH_MODE=password`), a request is signed in only by a valid session cookie, and only the web UI reads that cookie. The content host sets no cookie.
- Tokens and other credentials the app issues are stored only as hashes, compared in constant time, and never logged. Passwords are only ever kept as scrypt hashes, and session tokens as SHA-256.
- Sign-in attempts are rate limited, an unknown email costs as much as a wrong password for the most expensive account, and sign-in and sign-out pass the Origin check.
- Writes from the web UI pass the Origin check (CSRF).
- Everything that comes from an artifact, an agent or a user is escaped.
- Artifact frames keep their iframe sandbox rules.
- Nothing sent over MCP can create or forge the owner's own words or decisions.

`AGENTS.md` has the full rules.

## What does not count

With `AUTH_MODE=proxy`, the app trusts the identity header that the reverse proxy in front of it sends. An instance that can be reached without that proxy, or whose proxy passes a client's own identity headers through, is a deployment mistake, not a vulnerability in the app. The deployment section of the README explains what the proxy must do. As one more layer, `PROXY_SECRET` makes the web UI accept the identity header only on a request that carries a shared secret that the proxy sets; the app keeps a SHA-256 digest of it, compares in constant time and never logs it. It does not replace keeping the port private and stripping client-sent headers.

The built-in sign-in is small on purpose. A weak password, a leaked `AUTH_USERS` value, serving it without HTTPS, a proxy that does not set `X-Forwarded-For` (so the address limit is shared), and a `TRUSTED_PROXIES` that does not match the number of proxies (a shared limit when too low, a bucket the client chooses when too high) are deployment mistakes. The missing password reset, second factor and lockout beyond the rate limit are known limits of the design, not vulnerabilities: see [Built-in sign-in](docs/deployment.md#built-in-sign-in).
