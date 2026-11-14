# Deploying Agent Artifacts

This page explains how to run your own instance: what the pieces are, how people sign in, what the reverse proxy in front of the app must do, and how to back up and upgrade. For a quick try on your own computer, see the [Quick start](../README.md#quick-start) in the README instead.

People sign in in one of two ways, chosen with `AUTH_MODE`:

- **The built-in sign-in** (`AUTH_MODE=password`): a few accounts, each an email and a password, listed in a setting. For one person or a few. See [Built-in sign-in](#built-in-sign-in).
- **A sign-in proxy** (`AUTH_MODE=proxy`, the default): a **reverse proxy** in front of the app signs people in and tells the app who they are in a request header. Use this for an identity provider. If the proxy is wrong, or can be bypassed, anyone can act as any user. Read [What the reverse proxy must do](#what-the-reverse-proxy-must-do) before you put the app on a network.

In both ways a reverse proxy still sits in front of the app, to serve HTTPS and both hostnames.

## What the pieces are

- **One process.** It serves the web UI, the MCP endpoint (`/mcp`), the OAuth endpoints and the artifact content. It listens on one port (`PORT`, default `3000`) on all interfaces.
- **Two hostnames.** The process answers to the host of `APP_ORIGIN` (the web UI and `/mcp`) and the host of `CONTENT_ORIGIN` (artifact files). They must be different hostnames, and both must point to the same process. The reason is explained in [Architecture](architecture.md#two-hosts).
- **One data directory** (`DATA_DIR`). It holds one SQLite database and the stored files. See [Backups](#backups).

Read the [Who can see what](#who-can-see-what) section before you decide who gets access.

## Getting the image

Build it from a clone of the repository:

```bash
docker build -t agent-artifacts .
```

Or pull the image that the project's CI publishes, for `linux/amd64` and `linux/arm64` (a Raspberry Pi, an ARM server, Docker on an Apple-silicon Mac). Releases up to 0.3.0 are `linux/amd64` only:

```bash
docker pull ghcr.io/tim-brand/agent-artifacts:0.4.0
```

Each [release](https://github.com/tim-brand/agent-artifacts/releases) has a tag like `0.4.0` that never changes. The built-in sign-in needs release 0.2.0 or later. `latest` is the newest commit on `master`, released or not; use it only if you want to follow the development.

The image runs as the user `node`, sets `NODE_ENV=production`, listens on port 3000, and writes only to `/data`. Mount a persistent volume there. A directory you mount from the host must be writable by the `node` user (uid 1000). A minimal run command looks like this. It does not start as it is: add the settings for how people sign in, either `AUTH_EMAIL_HEADER` for a sign-in proxy or `AUTH_MODE=password` with `AUTH_USERS` for the built-in sign-in. The proxy still has to be set up as described below:

```bash
docker run -d --name agent-artifacts \
  -p 127.0.0.1:3000:3000 \
  -v agent-artifacts-data:/data \
  -e APP_ORIGIN=https://artifacts.example.com \
  -e CONTENT_ORIGIN=https://artifacts-content.example.com \
  -e SIGNING_SECRET="$(openssl rand -base64 32)" \
  agent-artifacts
```

Generate the `SIGNING_SECRET` once and keep it: the command above makes a new one each time you run it, which would break content links after a restart. Store it in a file or a secret manager.

For a complete, tested setup with Docker Compose, Caddy and the built-in sign-in, use [`examples/compose/`](../examples/compose/). It is meant for one person or a few people who have no identity provider, and it serves `http://localhost:8080` for a local trial.

You do not need Docker: the app is plain Node 24 and runs with `pnpm install --prod` and `pnpm start`. Set `NODE_ENV=production` in that case.

## Settings

These are environment variables. `pnpm dev` also reads a `.env` file; the image does not.

| Variable | Required | What it does |
| --- | --- | --- |
| `APP_ORIGIN` | yes | The public origin of the app host, for example `https://artifacts.example.com`. It must be exactly what the browser shows: scheme, host and port. |
| `CONTENT_ORIGIN` | yes | The public origin of the content host. Its host must differ from the host of `APP_ORIGIN`. |
| `SIGNING_SECRET` | yes | At least 32 characters. Signs the links to artifact content. Make one with `openssl rand -base64 32`. A value that starts with `change-me` is refused outside local development. |
| `PORT` | no | The port to listen on. Default `3000`. |
| `TRUSTED_PROXIES` | no | How many reverse proxies sit between the internet and the app and append to `X-Forwarded-For`. The rate limits take the client address that many entries from the right. A whole number from 1 to 32. Default `1`. See rule 6 below. |
| `DATA_DIR` | no | Where the database and files are kept. Default `./data`, and `/data` in the image. |
| `AUTH_MODE` | no | `proxy` (the default) or `password`. An empty value means the default. Any other value is refused. |
| `AUTH_USERS` | in `password` mode | The accounts of the built-in sign-in: `email:hash` entries, separated by commas and/or white space (new lines too). Make an entry with `node src/hash-password.ts you@example.com`. At least one is required in `password` mode; the app refuses to start if it is set in `proxy` mode. See [Built-in sign-in](#built-in-sign-in). |
| `AUTH_EMAIL_HEADER` | in `proxy` mode | The request header in which the proxy sends the signed-in user's email. There is no default, because every proxy names it differently: see [Header names that sign-in proxies send](#header-names-that-sign-in-proxies-send). Letters, digits and `-` only. Only local development with `DEV_USER` works without it. Not used in `password` mode. |
| `AUTH_NAME_HEADER` | no | Proxy mode: the request header for the user's display name. There is no default: without it the email is shown. Not used in `password` mode. |
| `PROXY_SECRET` | no | Proxy mode: a shared secret that the proxy sends with every request to the app host. At least 32 visible ASCII characters, no spaces. Make one with `openssl rand -base64 32`. An empty value means not set. The app refuses to start with it in `password` mode. See [A shared secret between the proxy and the app](#a-shared-secret-between-the-proxy-and-the-app). |
| `PROXY_SECRET_HEADER` | no | Proxy mode: the request header in which the proxy sends `PROXY_SECRET`. Default `X-Proxy-Secret`. Letters, digits and `-` only, and not the same header as `AUTH_EMAIL_HEADER` or `AUTH_NAME_HEADER`. The app refuses to start with it when `PROXY_SECRET` is not set. |
| `NODE_ENV` | no | `production` turns local development off. The image sets it. |
| `DEV_USER` | no | Local development only, proxy mode only: the user everyone is signed in as when no identity header is present. The app refuses to start with it outside local development, and with `AUTH_MODE=password`. |

**Local development** means: `NODE_ENV` is not `production`, and the host name of `APP_ORIGIN` is `localhost`, a name that ends in `.localhost`, `127.0.0.1` or `[::1]`. Anywhere else, `DEV_USER` and a `SIGNING_SECRET` that starts with `change-me` make the app refuse to start.

## Built-in sign-in

The built-in sign-in is for one person or a few people who have no identity provider. The accounts are in a setting, people sign in on a page of the app, and no sign-in proxy is needed. It is off by default.

### Make an account

Run the command once for each person. It asks for a password twice, without showing it, and prints one line to standard output: the entry for `AUTH_USERS`.

```bash
node src/hash-password.ts you@example.com
```

```text
Password:
Password again:
you@example.com:scrypt.15.8.3.…
```

In a clone of the repository, `pnpm hash-password you@example.com` does the same. With the Docker image, run the command inside it. It needs a terminal (`-it`) to ask for the password:

```bash
docker run --rm -it ghcr.io/tim-brand/agent-artifacts:0.4.0 node src/hash-password.ts you@example.com
```

Notes:

- The password is never an argument, because an argument would land in your shell history and in the process list. If standard input is not a terminal, the command reads the first line of it as the password. That is for scripts: pipe the password from a password manager or a file, and do not type it in the command line. Without an email argument the command prints only the hash.
- It refuses an empty password and one over 1,024 characters. It warns, but accepts, a password under 12 characters. The password is used exactly as typed: no trimming and no change of case. Use a long one.
- The hash holds no `$`, comma, colon or white space, so it needs no quoting in a `.env` file or in `docker run -e`. Its form is `scrypt.<log2 N>.<r>.<p>.<salt>.<key>`: scrypt with N = 2^15, r = 8, p = 3, a random 16 byte salt and a 32 byte key. One check takes about 100 ms and 32 MiB.

### Turn it on

Set these, and restart the app:

```text
AUTH_MODE=password
AUTH_USERS=you@example.com:scrypt.15.8.3.…,friend@example.com:scrypt.15.8.3.…
```

- An entry is `email:hash`. The email is everything before the first colon. Emails are compared in lower case, and an email must have no white space, comma or colon. Entries are separated by commas and/or white space, so in a file that allows it you can put one entry on each line.
- `AUTH_USERS` needs at least one account, and no email may appear twice. A bad entry stops the app at startup with a message that names the entry's position (and its email), and never prints a hash.
- `DEV_USER` must not be set. `APP_ORIGIN` must be `https`, so that the cookie is never sent over plain HTTP. The one exception is a local address: `localhost`, a name ending in `.localhost`, `127.0.0.1` or `[::1]`. This exception does not depend on `NODE_ENV`, so you can try the image on `http://localhost`.
- The hashes are not passwords, but treat `AUTH_USERS` as a secret anyway: whoever has a hash can try passwords against it offline.
- The app reads the accounts at startup. To add a person, change a password or remove a person, change `AUTH_USERS` and restart.
- At startup the app logs how many accounts it has, as a number, and nothing else about them.
- In this mode the app does not read the identity headers at all, on any path. `AUTH_EMAIL_HEADER` and `AUTH_NAME_HEADER` are not used, and a request that carries them and no session is not signed in. The name shown is the email.

### What people see

A request for a page without a session is redirected to `/login?next=<the page>`. The form asks for an email and a password. After a correct sign-in the browser goes back to the page it asked for. `next` is only ever a path on the app itself; anything else goes to `/`. The OAuth consent page, `/oauth/authorize`, works the same way: an agent that opens it sends you to the login page, and you come back to the same consent page.

Anything else without a session gets a 401 page that says "Sign in first.", with no redirect: a write, and everything under `/api/`. Only `/login`, a sign-out (`POST /logout`, which then just goes to the login page), `/static/` (the page's CSS, script and fonts), `/mcp`, `/healthz` and the six public OAuth paths answer without a session. `/mcp` and the OAuth paths use their own tokens, and never look at a session.

A wrong email and a wrong password get the same answer, "Wrong email or password.", and take about the same time: an unknown email is checked against a dummy hash made at startup, with the cost of the most expensive hash in `AUTH_USERS`. The command always writes the same cost; if you mix hashes of different costs, the cheaper accounts answer faster than an unknown email. The sidebar shows a **Sign out** button under the theme switch. The account menu of the artifact page has one too.

### The session

- A sign-in makes a random 32 byte token. The browser keeps it in a cookie, and the app stores only its SHA-256 in the `sessions` table. Every sign-in makes a new token.
- The cookie is `__Host-aa_session` when `APP_ORIGIN` is `https`, and `aa_session` on a local `http` address. It is `HttpOnly`, `SameSite=Lax`, `Path=/`, has no `Domain`, is `Secure` on https, and lasts 30 days. Because it has no `Domain`, the browser never sends it to the content host. (On a local trial, cookies ignore the port: other programs on `localhost` get the `aa_session` cookie too.)
- The session slides. When it is used more than an hour after it was last renewed, its expiry moves to 30 days from now and the cookie is set again. A session that is not used for 30 days ends.
- A session is valid only while its email is still in `AUTH_USERS` and the password has not changed. Each session remembers a SHA-256 of its account's hash text. So removing a person from `AUTH_USERS`, or giving them a new password, ends all their sessions at the next restart, with no other step. The rows stay until they expire: if you put the same entry back within 30 days (or switch to `AUTH_MODE=proxy` and back), those sessions work again. A new password for the account ends them for good.
- **Sign out** deletes the row and clears the cookie. Expired rows are deleted by the hourly clean-up.

### Limits and what is missing

- **Rate limits**, in memory: per client address, 10 attempts at once, refilled at 10 a minute; per account, 5 at once, refilled at 5 a minute. The account is the email as typed, whether or not it exists. Both are checked before any password is, and an attempt over a limit gets "Too many attempts. Wait a minute and try again." with status 429. The client address is an entry of `X-Forwarded-For`, counted from the right (rule 6 below). A person who is locked out by someone typing their email five times a minute must wait; there is no other lockout.
- At most 4 password checks run at the same time (each uses memory and CPU), and at most 16 more wait. Beyond that, a sign-in attempt gets the same 429.
- **No password reset.** To change a password, make a new entry with the command, replace the old entry in `AUTH_USERS` and restart. Nobody gets an email.
- **No sign-up, no roles, no second factor, no lockout beyond the rate limit.** Everyone who can sign in sees everything, as in [Who can see what](#who-can-see-what).

### What the reverse proxy must still do

Put the app behind a reverse proxy that does only this:

- **Serve HTTPS** for both hostnames. The sign-in cookie and the passwords travel over this connection.
- **Pass the `Host` header through unchanged** (rule 2 below), and answer on both hostnames: `APP_ORIGIN` and `CONTENT_ORIGIN`.
- **Make the proxy next to the app set or append `X-Forwarded-For`** (rule 6 below). The sign-in limits use it. Without it, every client shares one address limit of 10 attempts a minute. If `TRUSTED_PROXIES` is set higher than the number of proxies you have, an attacker can pick their own address bucket and get past the address limit; the account limit and the cap on password checks still hold.
- **Allow the body sizes** of rule 8: at least 51 MiB on `/mcp`. The UI's forms take 64 KB.
- **Keep the app's port private** (rule 1 below): the cookie and the passwords would otherwise travel in clear text, and the address limit would trust a header that the client sets.
- **Add no sign-in of its own**, such as basic auth. The proxy must not ask for credentials on `/mcp` or the OAuth paths, or agents cannot connect.

Of the numbered rules in [What the reverse proxy must do](#what-the-reverse-proxy-must-do), rules 1, 2, 5, 6, 7 and 8 apply. Two do not:

- **Rule 3 (the list of paths that stay open)** does not apply. The proxy signs no one in, so it has no sign-in to skip. The app answers `/mcp`, `/healthz` and the six OAuth paths itself, and sends everything else to `/login`.
- **Rule 4 (set the identity headers and remove the client's)** does not apply, because the app does not read them in this mode. Removing them is harmless but not needed.

Rule 7 is stricter in this mode: the app refuses to start unless `APP_ORIGIN` is `https` (or local).

## What the reverse proxy must do

This section is for the sign-in proxy (`AUTH_MODE=proxy`, the default). With the built-in sign-in, see [what the proxy must still do](#what-the-reverse-proxy-must-still-do) above: it says which of these rules apply.

In proxy mode the app trusts the identity header completely. These rules keep that safe. Check your own proxy configuration against each one.

1. **Never expose the app's port directly.** Only the proxy may reach it. Publish the port on `127.0.0.1` or on a private network, and block it in the firewall. Anyone who can reach the port can send any identity header. A [shared secret](#a-shared-secret-between-the-proxy-and-the-app) adds a second lock, but does not replace this rule.
2. **Pass the `Host` header through unchanged.** The app picks what to serve from `Host`. It must equal the host of `APP_ORIGIN` or of `CONTENT_ORIGIN`, including the port if there is one (the comparison ignores case). Any other host gets a plain-text 404.
3. **On the app host, require sign-in on every path except exactly these:**
   - `/mcp`: the MCP endpoint. Agents sign in here with a bearer token, not with the proxy.
   - `/healthz`: answers `ok`. It also works on any host, so a health check can call the app by its address.
   - The six public OAuth paths, which MCP clients call before they have a token. They are listed in `PUBLIC_OAUTH_PATHS` in `src/oauth/rules.ts`:

     | Method | Path |
     | --- | --- |
     | GET | `/.well-known/oauth-protected-resource` |
     | GET | `/.well-known/oauth-protected-resource/mcp` |
     | GET | `/.well-known/oauth-authorization-server` |
     | GET | `/.well-known/oauth-authorization-server/mcp` |
     | POST | `/oauth/register` |
     | POST | `/oauth/token` |

   These are exact matches, not prefixes. In particular, do not open `/oauth/` as a whole: `/oauth/authorize` is the consent page where you allow an agent to connect, and it must stay behind sign-in. See [Signing in to MCP](oauth.md).
4. **Set the identity headers yourself, and remove any that the client sent.** On every path of the app host, on the content host, and on the open paths from rule 3, delete `AUTH_EMAIL_HEADER` and `AUTH_NAME_HEADER` from the incoming request. On paths that require sign-in, set them from the signed-in user. The app only reads these headers in the web UI, but a proxy that lets a client's header through anywhere is a mistake waiting to happen. The app uses the values as they are, without decoding them.
5. **No sign-in and no cookies on the content host.** The content host serves untrusted artifact HTML. It must be a different hostname from the app host, and the app's sign-in cookie should not be sent to it: scope the proxy's session cookie to the app host, not to the parent domain. The content host does its own access control with signed links, and the app sets no cookies on it.
6. **Set or append `X-Forwarded-For` at the proxy nearest to the app.** The rate limits on public share links (60 requests a minute), on the OAuth endpoints and, with the built-in sign-in, on sign-in attempts use this header. The app takes the entry `TRUSTED_PROXIES` from the right, so the entries your own proxies added count and anything the client sent does not. With one proxy the default of `1` is right: the last entry is the address that connected to your proxy. Behind two proxies, for example a CDN or a load balancer in front of the reverse proxy, set `TRUSTED_PROXIES=2`, and make each proxy append to the header it received: one that replaces it (Caddy does, unless its `trusted_proxies` names the proxy in front) hides the entries before it. If you leave it at `1`, every visitor shares the outer proxy's bucket, and one busy visitor can use up the limit for all. If you set it too high, a client can choose its own bucket by sending the header itself. Without the header, every client counts as the same client and shares one limit.
7. **Use HTTPS for both origins.** If `APP_ORIGIN` starts with `https:`, the app marks its cookies (the theme, view and panel preferences, and the session of the built-in sign-in) `Secure`. The artifact page of an `https` app cannot show an `http` content host, because browsers block that mixed content. Some MCP clients may also refuse to sign in over plain `http` unless it is `localhost`. The web UI checks that every write comes with an `Origin` header equal to `APP_ORIGIN`, so `APP_ORIGIN` must also match the address people really use (see [What goes wrong when](#what-goes-wrong-when)).
8. **Allow large request bodies on `/mcp`.** The largest request is a publish, which sends the file contents inside the call. A publish may hold up to 25 MiB of files, and as base64 or escaped JSON it can take up to twice that. The app accepts a body of up to 51 MiB (`MAX_BODY_BYTES` in `src/mcp/routes.ts`). Set the proxy's body limit to at least 51 MiB on `/mcp`. Many proxies default to 1 MB or less, which makes larger publishes fail. All other paths take small bodies: 64 KB on the UI's forms, 16 KB on the public OAuth endpoints.

`/mcp` answers with plain JSON, not an event stream, so it needs no special streaming settings.

### A shared secret between the proxy and the app

Optional, proxy mode only. Without it, the app trusts the identity header from whatever can reach its port. With `PROXY_SECRET` set, the web UI accepts a request only when it carries the secret in the `PROXY_SECRET_HEADER` header (default `X-Proxy-Secret`). A request without the right secret gets a 401 "Not signed in" page, even if it carries an identity header, and even with `DEV_USER`.

It turns two deployment mistakes into a refused request instead of a sign-in bypass:

- The app's port can be reached directly, without the proxy.
- A path of the proxy forwards the identity headers that a client sent, without the proxy's sign-in.

It is one more layer, not the only one. You still must not expose the app's port (rule 1), and the proxy must still remove client-sent identity headers (rule 4). Anyone who learns the secret and can reach the port can send any identity header again.

To set it up:

1. Make a secret: `openssl rand -base64 32`. Put it in `PROXY_SECRET` of the app, and in the proxy's configuration. Keep it out of logs and out of the repository.
2. Make the proxy **set** the header on every request that it forwards to the app host, so that it overwrites whatever a client sent. Do not send the secret to the content host, and do not log the header.

Caddy:

```caddyfile
artifacts.example.com {
	reverse_proxy app:3000 {
		header_up X-Proxy-Secret {env.PROXY_SECRET}
	}
}
```

nginx:

```nginx
location / {
    proxy_set_header X-Proxy-Secret "<the secret>";
    proxy_pass http://app:3000;
}
```

With forward auth (Traefik, an Authentik outpost, oauth2-proxy in `auth_request` mode), the sign-in service does not forward the request to the app. The reverse proxy does, so add the header there, not in the sign-in service. In Traefik that is a `headers` middleware with `customRequestHeaders` on the app host's router.

The secret is checked only in the web UI of the app host, including `/static/`. `/mcp`, the public OAuth paths (`/.well-known/oauth-*`, `/oauth/register`, `/oauth/token`), `/healthz` and the content host do not need it and do not check it. Their own rules from rule 3 stay as they are. The secret is not available in `password` mode, where the app does not read the identity headers anyway: the app refuses to start with both.

The app keeps only a SHA-256 digest of the secret, compares in constant time, and never logs it. The 401 page names the header, never the secret, and does not say whether the header was missing or wrong.

### Header names that sign-in proxies send

Put the header your proxy sends into `AUTH_EMAIL_HEADER`, and the one with the display name, if there is one, into `AUTH_NAME_HEADER`. The app has no default for either. Without `AUTH_EMAIL_HEADER` it refuses to start in proxy mode. If a product has no display name header, leave `AUTH_NAME_HEADER` unset: the app shows the email instead. Header names are case-insensitive.

| Proxy or product | `AUTH_EMAIL_HEADER` | `AUTH_NAME_HEADER` | Checked on |
| --- | --- | --- | --- |
| Authentik | `X-authentik-email` | `X-authentik-name` | [Proxy provider](https://docs.goauthentik.io/add-secure-apps/providers/proxy/) |
| oauth2-proxy | `X-Forwarded-Email` | none (it sends the username in `X-Forwarded-User` and `X-Forwarded-Preferred-Username`) | [Configuration overview](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/) (`--pass-user-headers`) |
| Authelia | `Remote-Email` | `Remote-Name` | [Trusted Header SSO](https://www.authelia.com/integration/trusted-header-sso/introduction/) |
| Tailscale Serve | `Tailscale-User-Login` (the login name, usually an email) | `Tailscale-User-Name` | [Tailscale Serve](https://tailscale.com/kb/1312/serve) |
| Cloudflare Access | `Cf-Access-Authenticated-User-Email` | none | [Cloudflare tutorial](https://developers.cloudflare.com/cloudflare-one/tutorials/extend-sso-with-workers/) |
| Caddy `basic_auth` | any name you choose, for example `X-Auth-Email`: set it with `header_up X-Auth-Email {http.auth.user.id}` | none (add `header_up -X-Auth-Name` so a client cannot set it) | [`basic_auth` directive](https://caddyserver.com/docs/caddyfile/directives/basic_auth) |

Notes:

- With oauth2-proxy in `auth_request` mode (for example with nginx), the identity comes back in response headers such as `X-Auth-Request-Email` (`--set-xauthrequest`), which your proxy must copy to the request it sends to the app.
- Tailscale Serve removes these headers from incoming requests itself, and does not set them for Funnel (public) traffic. Tailscale advises that the backend listen on localhost only.
- Cloudflare says to validate the signed `Cf-Access-Jwt-Assertion` token and not to trust the email header alone. The app does not validate that token, so rules 1 and 4 matter even more: only Cloudflare may reach the app (for example through a tunnel), and nothing else may set the header.
- This page gives no full configuration for these products. The numbered rules above are what counts. The [Compose example](../examples/compose/) uses the built-in sign-in instead, so it is not a configuration for proxy mode.

### What goes wrong when

| What you see | Why |
| --- | --- |
| A plain-text 404 that starts with `Unknown host.` | The `Host` header is neither the host of `APP_ORIGIN` nor of `CONTENT_ORIGIN`. Check the two settings (the port counts), and check that the proxy passes `Host` through. This is also what you get if you change `PORT` for a local trial and not the two origins. `/healthz` is the only path that works on any host. |
| A page titled "Not signed in" that says: "This app has no sign-in of its own. A sign-in proxy in front of it must send the signed-in user's email in the `X-Forwarded-Email` request header, and that header is missing." | Proxy mode: the identity header did not arrive. The page names the header the app expects (`AUTH_EMAIL_HEADER`). Check that the proxy sets it, and that the name matches. If you wanted the built-in sign-in, set `AUTH_MODE=password`. |
| A page titled "Not signed in" that says "This app only accepts requests that come through its sign-in proxy. The proxy must send the shared secret in the `X-Proxy-Secret` request header." (every page) | `PROXY_SECRET` is set, and the request did not carry the right secret in that header (the page names `PROXY_SECRET_HEADER`). Either the request did not come through the proxy, or the proxy does not set the header, or the value differs from `PROXY_SECRET`. See [A shared secret between the proxy and the app](#a-shared-secret-between-the-proxy-and-the-app). |
| A page titled "Not signed in" that says "Sign in first." (status 401) | Built-in sign-in: a write or an `/api/` call came without a valid session. The session ended or expired. Sign in again. |
| You sign in, and the login page comes back | The browser did not keep the cookie. Check that `APP_ORIGIN` is exactly the address in the browser, and that the proxy serves HTTPS: the cookie is `Secure`. |
| "Wrong email or password." for the right password | Check the email (any case works) and the password (exactly as typed, with no extra space). The accounts are read at startup: restart after you change `AUTH_USERS`. |
| "Too many attempts. Wait a minute and try again." | A rate limit: more than 10 attempts a minute from one address, or 5 for one account. If every user gets it, the proxy does not set `X-Forwarded-For`, or there is more than one proxy and `TRUSTED_PROXIES` is too low, so everyone shares one address. |
| A "Forbidden" page that says "This request did not come from this site." | A write from the web UI came with an `Origin` that is not exactly `APP_ORIGIN`. Make `APP_ORIGIN` equal to the address in the browser, scheme and port included. |
| The proxy's own sign-in page when an agent calls `/mcp` or an OAuth path | The proxy requires sign-in on a path from rule 3. |
| A 401 JSON answer from `/mcp` | Expected without a valid token. It carries a `WWW-Authenticate` header that points the client to the OAuth metadata. If your client cannot sign in, see [Signing in to MCP](oauth.md). |

**Startup errors.** The app prints one line, `agent-artifacts: <message>`, then `See .env.example and the README for the settings.`, and exits.

| Message | Fix |
| --- | --- |
| `SIGNING_SECRET is not set`, `APP_ORIGIN is not set`, `CONTENT_ORIGIN is not set` | Set it. |
| `SIGNING_SECRET must be at least 32 characters` | Use a longer secret. |
| `PORT must be a port number` | Use an integer from 0 to 65535. |
| `TRUSTED_PROXIES must be a whole number from 1 to 32` | Use the number of reverse proxies in front of the app, for example `1` or `2`. |
| Public links or sign-in answer 429 for everyone at once | Count the proxies between the internet and the app and set `TRUSTED_PROXIES` to that number (rule 6 above). |
| `APP_ORIGIN must be an origin such as https://artifacts.example.com` (same for `CONTENT_ORIGIN`) | Give a full origin with scheme. |
| `AUTH_EMAIL_HEADER must be an HTTP header name (letters, digits and - only)` (same for `AUTH_NAME_HEADER`) | Use a plain header name. |
| `PROXY_SECRET must be at least 32 characters` | Use a longer secret. Make one with `openssl rand -base64 32`. |
| `PROXY_SECRET must be made of visible ASCII characters only, without spaces: …` | The secret travels in a request header. Use letters, digits and punctuation only, as `openssl rand -base64 32` gives. Check for a space or a quote that came along when you pasted it. |
| `PROXY_SECRET is set, but AUTH_MODE is password. …` | Remove `PROXY_SECRET`, or set `AUTH_MODE=proxy`. |
| `PROXY_SECRET_HEADER is set, but PROXY_SECRET is not. …` | Set `PROXY_SECRET`, or remove `PROXY_SECRET_HEADER`. |
| `PROXY_SECRET_HEADER must be a different header than AUTH_EMAIL_HEADER and AUTH_NAME_HEADER` | Pick another header name for the secret. |
| `PROXY_SECRET_HEADER must be an HTTP header name (letters, digits and - only)` | Use a plain header name. |
| `AUTH_MODE must be proxy or password` | Use one of the two, or leave it empty. |
| `AUTH_MODE is proxy (the default), but AUTH_EMAIL_HEADER is not set. …` | Set `AUTH_EMAIL_HEADER` to the header your sign-in proxy sends (see [Header names that sign-in proxies send](#header-names-that-sign-in-proxies-send)). If you wanted the built-in sign-in, set `AUTH_MODE=password`. |
| `AUTH_MODE is password, but AUTH_USERS holds no account. Make an entry with: node src/hash-password.ts you@example.com` | Set `AUTH_USERS`. |
| `AUTH_USERS is set, but AUTH_MODE is not password. …` | Set `AUTH_MODE=password`, or remove `AUTH_USERS`. |
| `AUTH_USERS entry 2 has no ":"`, `entry 2 ("a@example.com"): the password hash is not valid`, `… this email is listed twice` | Fix that entry. The number is its position in `AUTH_USERS`. Make the entry with `node src/hash-password.ts you@example.com`. |
| `DEV_USER is set, but AUTH_MODE is password. …` | Remove `DEV_USER`. |
| `AUTH_MODE is password, so APP_ORIGIN must be https …` | Serve the app over HTTPS and set `APP_ORIGIN` to the https address. Plain http is only accepted on `localhost`. |
| `DEV_USER is only for local development, and this is not local development (NODE_ENV is production, or APP_ORIGIN is not on localhost). Unset it and put a sign-in proxy in front of the app instead; see the README` | Remove `DEV_USER`. |
| `SIGNING_SECRET is still the placeholder from .env.example. Make one with: openssl rand -base64 32` | Make a real secret. |
| `APP_ORIGIN and CONTENT_ORIGIN must be different hosts` | Give the content host its own hostname. |

With `DEV_USER` set (local development only), the app also logs a warning at startup, because everyone who can reach the port is then signed in as that user. With `AUTH_MODE=password` it logs one line with the number of accounts.

## Who can see what

There is no separation between users. Everyone who can sign in, through the proxy or with the built-in sign-in, has the same access: they see every artifact, comment, ask, share link, personal access token and signed-in app, and they can delete artifacts, answer asks, create public links and create or revoke tokens. The email of the signed-in user (from the identity header, or the account's email) is recorded only as the author of the comments they write and as who answered an ask or signed in an app. Nothing in the app limits what one user may do to another's work. If you need separation, run one instance per group, or admit only people who may see everything.

Agents are not separated either: any token or signed-in app can read and change any artifact. A personal access token has no user at all; an OAuth sign-in records which user allowed it.

## One replica

Run exactly one copy. The database is SQLite, which allows one writer, and the rate limits (including those of the sign-in) are kept in memory. Two copies on the same volume would fight over the file, and two copies with separate volumes would have separate data. In Kubernetes use a single replica with a persistent volume, and the `Recreate` strategy so the old pod stops before the new one starts.

## Backups

Everything the app keeps is in `DATA_DIR`:

- `artifacts.db`: the SQLite database (artifacts, versions, comments, tokens, share links, live page data, sessions of the built-in sign-in and so on). It runs in WAL mode, so while the app is running there are also `artifacts.db-wal` and `artifacts.db-shm`.
- `blobs/`: the stored files, one file per distinct content, named by the SHA-256 of the bytes (`blobs/ab/ab12…`). A file is never changed once written.

Do not copy `artifacts.db` alone while the app runs: the recent changes are in the `-wal` file. Use one of these:

1. **Stop the app and copy the whole directory.** The simplest, and always consistent.
2. **Take a volume or file system snapshot** of the directory.
3. **Copy while it runs:** make a consistent copy of the database with SQLite's backup command, then copy the blob files:

   ```bash
   sqlite3 /data/artifacts.db ".backup '/backup/artifacts.db'"
   rsync -a /data/blobs/ /backup/blobs/
   ```

   A publish or the hourly clean-up of the trash between the two steps can leave the copy slightly out of step: a new artifact whose files are missing, or a purged artifact whose files are gone. For a guaranteed match, use option 1 or 2.

To restore, stop the app, put `artifacts.db` and `blobs/` in an empty `DATA_DIR` (without old `-wal` or `-shm` files), and start it. Also keep your `SIGNING_SECRET` safe; it is not in the data directory.

## Upgrading

Pull or build the new image and restart. Read the release notes first: a release can ask for a change in the settings. `0.3.0` does: proxy mode now needs `AUTH_EMAIL_HEADER`, where older versions fell back to `X-authentik-email` and `X-authentik-name`. `0.4.0` does when more than one reverse proxy is in front of the app: the rate limits now take the client address from the right of `X-Forwarded-For`, so set `TRUSTED_PROXIES` to the number of proxies (rule 6 above). The database schema is updated at startup: the app runs any migration steps it has not yet applied, each in its own transaction, in order. There is no separate command.

- Take a backup first. Migrations on real data are the riskiest part of an upgrade.
- Do not go back to an older version after a newer one has opened the database. The older code does not know the newer schema, and does not stop.

## Changing `SIGNING_SECRET`

The secret signs the links to artifact content (`/s/…` URLs, valid for one hour) that the web UI puts in its frames. Changing it makes every link that is already out invalid. The app makes new links when a page is loaded, so the only visible effect is that a page that was open during the change must be reloaded. Public share links, personal access tokens, OAuth sign-ins and the sessions of the built-in sign-in do not use the secret and keep working. Changing the secret is safe; just restart the app with the new value.

## How the image is built

`.github/workflows/image.yml` runs after the `CI` workflow succeeds on `master`. If the commit is still the tip of `master`, it builds the image and pushes it to `ghcr.io/<owner>/<repository>` of the repository that runs it, with the tags `latest` and the short commit sha, for `linux/amd64` and `linux/arm64`. CI builds and starts the image on a runner of each architecture before that. A fork therefore builds its own image. `.github/workflows/release.yml` gives the image of a released commit its version tag.

Nothing in this repository deploys the image: that belongs to the place that runs it. To stay up to date, put the version tag in your own deployment and let a tool such as [Renovate](https://docs.renovatebot.com/) propose the next release. Tell it to look at version tags only (`0.4.0`), because the image also has a tag for every commit.
