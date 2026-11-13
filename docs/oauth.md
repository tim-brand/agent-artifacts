# Signing in to MCP with OAuth

This page describes how MCP clients (Claude Code, OpenCode, Codex and others) sign in to Agent Artifacts with OAuth: the endpoints, the rules, the lifetimes, what the consent page shows and how to revoke a sign-in. To connect an agent, see [Connecting agents over MCP](mcp.md); you do not need this page for that.

## How it works

MCP clients expect an authorization server that supports dynamic client registration, which many identity providers do not offer. So the app is its own small OAuth 2.1 authorization server (`src/core/oauth.ts` and `src/oauth/`). The sign-in itself is not done here: the consent page sits behind the same sign-in as the web UI (your proxy's, or the built-in one), so only a person who is signed in can allow an agent. With the built-in sign-in, an agent that opens the consent page sends you to the login page first, and you come back to the same consent page.

The flow:

1. The client calls `/mcp` without a token and gets a 401 with a `WWW-Authenticate` header that points to the resource metadata.
2. The client reads the metadata, registers itself (`/oauth/register`) and sends your browser to `/oauth/authorize`.
3. You see the consent page and click Allow. The browser goes back to the client with a one-time `code`.
4. The client trades the code for tokens at `/oauth/token`, and calls `/mcp` with the access token. A publish over OAuth is by the client's name, such as "Claude Code".

## Public endpoints

With a sign-in proxy, the proxy must leave these open, with no sign-in (see [Deployment](deployment.md#what-the-reverse-proxy-must-do)). With the built-in sign-in there is nothing to leave open: the app answers them before the sign-in. Nothing here reads the identity headers or the session cookie.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | Resource metadata (RFC 9728): resource `<APP_ORIGIN>/mcp`, `authorization_servers: [APP_ORIGIN]`. |
| GET | `/.well-known/oauth-authorization-server`, `/.well-known/oauth-authorization-server/mcp` | Authorization server metadata (RFC 8414). The issuer is `APP_ORIGIN`; the `/mcp` variant is for clients that insert the resource path. |
| POST | `/oauth/register` | Dynamic client registration (RFC 7591): public clients only (`token_endpoint_auth_method: none`, whatever was asked). Redirect URIs must be `https`, or `http` on `127.0.0.1`, `localhost` or `[::1]`. Rate limited to a burst of 10, then one a minute, per client IP, and a burst of 60, then 10 a minute, overall. |
| POST | `/oauth/token` | `authorization_code` with PKCE, and `refresh_token`. Form-encoded, errors as RFC 6749 JSON. Rate limited to a burst of 30, then 30 a minute, per client IP. |

The rate limits are kept in memory and use the first entry of `X-Forwarded-For` as the client IP, so the proxy must set it. The public endpoints read at most 16 KB of request body.

**Behind the sign-in:** `GET /oauth/authorize` checks the request and shows the consent page. `POST /oauth/authorize` is the Allow or Deny form, behind the web UI's Origin check: it checks everything again and redirects back with `code` or `error`, `state` and `iss` (RFC 9207). An unknown client, or a `redirect_uri` that was not registered, gets an error page instead of a redirect. The consent page widens `form-action` to the client's origin, because browsers apply it to the redirect after the form is posted.

## What the consent page shows

The page is titled "Connect <client>?" and says that the app will be able to publish, read, change and delete your artifacts, comments and live page data over MCP. It shows:

- **App:** the client's name, marked "named by the app itself". The client chooses its own name, so treat it as a claim, not proof.
- **Returns to:** the host where your browser goes after you click Allow. A loopback address is marked "an app on this computer". For any other host, a warning says that your browser goes to that site and to allow it only if you know it.
- **Signed in as:** you, from the identity header or, with the built-in sign-in, your session.

Only allow a connection that you just started yourself.

## Rules

- PKCE with `S256` is required. `plain`, or no challenge, is refused.
- `redirect_uri` must match a registered one exactly, except that a loopback URI may use any port (RFC 8252, section 7.3). If the authorization request had one, the token request must repeat it.
- `resource` (RFC 8707) must be `<APP_ORIGIN>/mcp`; an upper-case scheme or host, or a trailing slash, is accepted. If it is left out, the token is still issued for `/mcp` only. `/mcp` accepts only tokens issued for it.
- A code is single use and lives 60 seconds. A wrong `code_verifier` spends the code too. A code that is used a second time revokes the grant it made.
- Access tokens (`aat_...`) live one hour. Refresh tokens (`aar_...`) live 30 days and rotate on every use: presenting a refresh token that was already rotated revokes the whole grant, and the client has to sign in again.
- Codes and tokens are random 256-bit values, stored only as SHA-256 hashes, compared in constant time and never logged.
- Client names are cleaned to one line of plain text of at most 100 characters. A client can register at most 10 redirect URIs of at most 2,000 characters each.

## Grants and revoking

A **grant** is one sign-in of a client by a user. Signing in again with the same client replaces its earlier grant. The **Connections** page (`/settings/connections`) lists the grants (the client, when it was signed in and as whom, when it was last used) above the personal access tokens. Revoking a grant revokes all its tokens: the client loses access until it signs in again.

An hourly clean-up drops expired codes and tokens, ended grants, and registered clients that nobody used for 30 days.

Every signed-in person sees every grant and can revoke it; see [Who can see what](deployment.md#who-can-see-what).
