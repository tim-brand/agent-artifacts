# Docker Compose example: built-in sign-in behind Caddy

This runs Agent Artifacts on one machine with Docker Compose. People sign in on a page of the app with an email and a password (the [built-in sign-in](../../docs/deployment.md#built-in-sign-in)). Caddy sits in front and serves HTTPS. The app is not published on any port of its own.

It is for one person, or a few people who each get a password. It needs no identity provider. If you want single sign-on, put the app behind an identity provider instead. See [../../docs/deployment.md](../../docs/deployment.md).

## What you get

- `app`: Agent Artifacts, built from this repository. Data lives in the `app-data` volume.
- `caddy`: the only service with a published port. It answers on both hostnames, gets HTTPS certificates for real domains, and passes every request to the app. It does no sign-in.

The app serves two hosts: the app host (the web UI and `/mcp`) and a separate content host that serves artifact files. They need two different names. The local trial uses `localhost` and `content.localhost`. Browsers resolve `*.localhost` to your own computer, so no DNS setup is needed.

## Local trial

You need Docker with Compose v2, and `openssl`. Run everything in this folder. With Docker Desktop, the folder must be one that Docker may share (Settings, Resources, File sharing), or mounting the `Caddyfile` fails with "mounts denied".

1. Copy the settings file:

   ```sh
   cd examples/compose
   cp .env.example .env
   ```

2. Make a signing secret, and paste it after `SIGNING_SECRET=` in `.env`:

   ```sh
   openssl rand -base64 32
   ```

3. Make your account. The command builds the image the first time, asks for a password twice (it shows nothing as you type), and prints one line: your email and the password hash.

   ```sh
   docker compose run --rm --no-deps app node src/hash-password.ts you@example.com
   ```

   ```text
   Password:
   Password again:
   you@example.com:scrypt.15.8.3.…
   ```

   Paste that last line after `AUTH_USERS=` in `.env`. It has no `$` and no spaces, so it needs no quotes. The command needs the secret from step 2, because Compose checks `.env` first.

4. Start it:

   ```sh
   docker compose up -d --build
   docker compose ps
   ```

   Both containers should be running, and `app` should say `healthy`.

5. Open <http://localhost:8080> and sign in with your email and password.

If the app does not start, `docker compose up -d` ends with `dependency failed to start: container agent-artifacts-app-1 is unhealthy`. The reason is in the log of the app:

```sh
docker compose logs app
```

The last lines name the setting that is wrong, for example `AUTH_MODE is password, but AUTH_USERS holds no account`. Fix `.env` and run `docker compose up -d` again.

To stop it, run `docker compose down`. Add `-v` to also delete the data volumes, and `--rmi local` to also delete the image that was built.

## Connect an agent

The app has a page that shows the commands: open <http://localhost:8080/connect>. It has them for Claude Code, OpenCode and Codex, and a JSON snippet for other MCP clients. The MCP URL is `http://localhost:8080/mcp` (your `APP_ORIGIN` plus `/mcp`).

For example, with Claude Code:

```sh
claude mcp add --transport http -s user agent-artifacts http://localhost:8080/mcp
```

Then run `/mcp` in Claude Code, pick `agent-artifacts` and choose Authenticate. The client opens your browser on the app's consent page. Sign in there if you are not signed in, then click Allow.

For a client without OAuth, create a personal access token under Settings, Connections, and send it as `Authorization: Bearer <token>`. The `/connect` page shows the config for that too.

## Real domains with HTTPS

1. Pick two DNS names and point both at your server, for example `artifacts.example.com` and `artifacts-content.example.com`. They must be two different names.
2. In `.env`, set both as origins with `https://`, no port and no trailing slash:

   ```
   APP_ORIGIN=https://artifacts.example.com
   CONTENT_ORIGIN=https://artifacts-content.example.com
   ```

   `APP_ORIGIN` must be `https`. With the built-in sign-in the app refuses to start otherwise. Plain `http` is only accepted for `localhost`, `*.localhost`, `127.0.0.1` and `[::1]`.
3. In `compose.yaml`, under `caddy`, replace the `"8080:8080"` line with ports 80 and 443 (the commented lines are there).
4. Open ports 80 and 443 to the internet. Caddy asks for certificates from Let's Encrypt on its own. It needs port 80 or 443 reachable for that, and it keeps the certificates in the `caddy-data` volume.
5. `docker compose up -d`.

Use a long password. The sign-in is open to the internet. The app limits attempts (10 a minute from one address, 5 a minute for one account), but there is no other lockout and no second factor.

## People and passwords

The app reads `AUTH_USERS` at startup. To add a person, remove one or change a password, edit `AUTH_USERS` in `.env` and run:

```sh
docker compose up -d
```

Compose sees the new value and restarts the app. A person who is removed, or has a new password, is signed out.

- Make an entry for each person with the command from step 3. Separate entries with commas, on one line: `AUTH_USERS=you@example.com:scrypt.…,friend@example.com:scrypt.…`.
- To change a password, make a new entry for the same email and replace the old one.
- For a script, pipe the password in and drop the terminal: `printf '%s\n' "$PASSWORD" | docker compose run --rm --no-deps -T app node src/hash-password.ts you@example.com`. Add `2>/dev/null` to keep only the entry. With a terminal you cannot split the prompts from the entry, so copy the last line.

Everyone who can sign in sees and can change everything.

## Things to know

- **Backups.** All data is in the `app-data` volume (`/data` in the container: the SQLite database and the artifact files). Stop the app before you copy it, or the copy may be inconsistent:

  ```sh
  docker compose stop app
  docker run --rm -v agent-artifacts_app-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/app-data.tgz -C /data .
  docker compose start app
  ```

  Keep your `.env` too, for `AUTH_USERS` and `SIGNING_SECRET`. A new `SIGNING_SECRET` is not a disaster: it only signs the one-hour links to artifact content that the web UI makes on each page load, so an open page needs a reload. Public share links and tokens keep working.
- **Upgrade.** Back up, then pull the new code and run `docker compose up -d --build`. The database is updated at startup.
- **One replica only.** SQLite allows one writer. Do not scale `app` above 1.
- **Prebuilt image.** `compose.yaml` has a commented `image: ghcr.io/tim-brand/agent-artifacts:0.3.1` line to use instead of `build:`. It is built for `linux/amd64` and `linux/arm64` (releases up to 0.3.0: `linux/amd64` only). The built-in sign-in needs release 0.2.0 or later. This example was only tested with `build:`.
- **The client address.** Caddy replaces a client-sent `X-Forwarded-For` with the real address, and the app uses it for the sign-in limit. Caddy is the only proxy, so the default `TRUSTED_PROXIES=1` fits. Do not add `trusted_proxies` to the `Caddyfile` unless another proxy sits in front of Caddy.

## What this example does not do

- No password reset by email, no sign-up, no second factor, no roles.
- No separate users: everyone who signs in has the same access.
- No backups on a schedule, and no more than one app replica.
- No sign-in through an identity provider. For that, see [../../docs/deployment.md](../../docs/deployment.md).
