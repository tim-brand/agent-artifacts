# Docker Compose example: Caddy with basic auth

This runs Agent Artifacts on one machine with Docker Compose. Caddy sits in front of the app and asks for a user name and password (HTTP basic auth). The app is not published on any port of its own.

It is for one person, or a few people who each get a password. It needs no identity provider.

If you want single sign-on, put the app behind an identity provider with forward auth instead. See [../../docs/deployment.md](../../docs/deployment.md).

## What you get

- `app`: Agent Artifacts, built from this repository. Data lives in the `app-data` volume.
- `caddy`: the only service with a published port. It handles sign-in, passes requests to the app, and (with real domains) gets HTTPS certificates.

The app serves two hosts: the app host (the web UI and `/mcp`) and a separate content host that serves artifact files. They need two different names. The local trial uses `localhost` and `content.localhost`. Browsers resolve `*.localhost` to your own computer, so no DNS setup is needed.

## Local trial

You need Docker with Compose v2, and `openssl`. Run everything in this folder. With Docker Desktop, the folder must be one that Docker may share (Settings, Resources, File sharing), or mounting the `Caddyfile` fails with "mounts denied".

```sh
cd examples/compose
cp .env.example .env
```

Make a signing secret and a password hash:

```sh
openssl rand -base64 32
docker run --rm caddy:2 caddy hash-password --plaintext 'your password'
```

Edit `.env`:

1. Paste the secret after `SIGNING_SECRET=`.
2. Set `AUTH_USER`. An email address works best, because the app shows this name as the signed-in user.
3. Paste the hash after `AUTH_HASH=`, **inside single quotes**, exactly as printed:

   ```
   AUTH_HASH='$2a$14$...'
   ```

   A bcrypt hash contains `$` characters. Compose treats `$` as the start of a variable, but not inside single quotes in a `.env` file. Without the quotes the hash is broken and you cannot sign in. Nothing else needs escaping: the `compose.yaml` passes the value on as it is.

Start it:

```sh
docker compose up -d --build
docker compose ps
```

Both containers should be running, and `app` should say `healthy`. Open <http://localhost:8080>. Your browser asks for the user name and password.

To stop it, run `docker compose down`. Add `-v` to also delete the data volumes, and `--rmi local` to also delete the image that was built.

## Connect an agent

The app has a page that shows the commands: open <http://localhost:8080/connect>. It has them for Claude Code, OpenCode and Codex, and a JSON snippet for other MCP clients. The MCP URL is `http://localhost:8080/mcp` (your `APP_ORIGIN` plus `/mcp`).

For example, with Claude Code:

```sh
claude mcp add --transport http -s user agent-artifacts http://localhost:8080/mcp
```

Then run `/mcp` in Claude Code, pick `agent-artifacts` and choose Authenticate. The client opens your browser on the app's consent page. Your browser asks for the basic-auth password there, then you click Allow.

For a client without OAuth, create a personal access token under Settings, Connections, and send it as `Authorization: Bearer <token>`. The `/connect` page shows the config for that too.

`/mcp` does not use basic auth. MCP clients cannot answer a browser login, so `/mcp` checks the bearer token itself.

## Real domains with HTTPS

1. Pick two DNS names and point both at your server, for example `artifacts.example.com` and `artifacts-content.example.com`. They must be two different names.
2. In `.env`, set both as origins with `https://`, no port and no trailing slash:

   ```
   APP_ORIGIN=https://artifacts.example.com
   CONTENT_ORIGIN=https://artifacts-content.example.com
   ```

3. In `compose.yaml`, under `caddy`, replace the `"8080:8080"` line with ports 80 and 443 (the commented lines are there).
4. Open ports 80 and 443 to the internet. Caddy asks for certificates from Let's Encrypt on its own. It needs port 80 or 443 reachable for that, and it keeps the certificates in the `caddy-data` volume.
5. `docker compose up -d`.

Use a strong password. The sign-in is open to the internet, and basic auth has no lockout.

## What the proxy guarantees

The app has no sign-in of its own. It trusts the `X-Auth-Email` header as the user. The `Caddyfile` makes sure that header only ever comes from Caddy:

- Every path on the app site needs basic auth, except `/mcp`, `/healthz` and the six OAuth paths that MCP clients must reach (`PUBLIC_OAUTH_PATHS` in `src/oauth/rules.ts`). Those check bearer tokens themselves.
- After a successful login, Caddy sets `X-Auth-Email` to the user name. It replaces any value the client sent.
- On the open paths and on the content site, Caddy deletes `X-Auth-Email` and `X-Auth-Name`.
- The consent page `/oauth/authorize` needs a login.
- The content site has no sign-in. Its files are served from signed URLs.
- Caddy passes the `Host` header on unchanged, which the app needs to tell the two sites apart. It also replaces a client-sent `X-Forwarded-For` with the real client address, which the app uses for rate limits.
- The app has no published port, so nothing can reach it without going through Caddy.

The path rules match without regard to case and decode `%` escapes, so `/MCP` and `/%6dcp` also count as open. That is harmless: the identity headers are deleted on the open paths, so the app sees an anonymous request. The `Caddyfile` explains this in comments. If you change the paths, keep this rule: the only request that gets an identity header is one that passed basic auth.

## Things to know

- **Backups.** All data is in the `app-data` volume (`/data` in the container: the SQLite database and the artifact files). Stop the app before you copy it, or the copy may be inconsistent: `docker compose stop app`, copy, `docker compose start app`. Keep your `.env` too, for the password hash and `SIGNING_SECRET`. A new `SIGNING_SECRET` is not a disaster: it only signs the one-hour links to artifact content that the web UI makes on each page load, so an open page needs a reload. Public share links and tokens keep working.
- **One replica only.** SQLite allows one writer. Do not scale `app` above 1.
- **More users.** The `Caddyfile` has one user. Caddy's `basic_auth` block takes more lines of `name hash`. Add them to the `Caddyfile` yourself; every user can see and change everything.
- **Prebuilt image.** `compose.yaml` has a commented `image: ghcr.io/tim-brand/agent-artifacts:latest` line to use instead of `build:`. Use it only if that image is published. This example was only tested with `build:`.

## What was tested

Tested with real containers (Docker Desktop on macOS, Caddy 2, local trial on `http://localhost:8080`):

- `docker compose up -d --build` from a `.env` made from `.env.example`; both containers up and the app healthy; port 3000 not reachable from the host.
- Basic auth: 401 with a challenge without credentials or with a wrong password; the page shows the user name with the right one.
- Spoofing: a client-sent `X-Auth-Email` or `X-Auth-Name` gives no access without a login, and is replaced by the real user with one. Also checked on the open paths and on the content site, with odd paths (`/MCP`, `/mcp/`, `/mcp/../`, `/%6dcp`, `//settings/connections`, dot segments after open paths, encoded slashes).
- `/healthz`, the two `/.well-known/` documents (their URLs start with `http://localhost:8080`), and the 401 from `/oauth/authorize`.
- A personal access token made in the UI, used on `/mcp` without basic auth: `tools/list`, and `publish_artifact`. The 401 without a token points at the metadata URL.
- The artifact page and its content URL: the content fetch needs no login and has a `Content-Security-Policy` with `sandbox`.
- `X-Forwarded-For`: Caddy replaces a client-sent value.
- Data survives `docker compose restart`.

Not tested:

- Real domains, DNS and HTTPS certificates.
- Ports 80 and 443.
- The full OAuth sign-in of a real MCP client (only that its public endpoints are reachable and the consent page asks for a login).
- Running on Linux or on Windows.
- More than one user, and the prebuilt image.
