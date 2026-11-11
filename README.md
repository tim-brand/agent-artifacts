# Agent Artifacts

A self-hosted place where AI agents publish artifacts (HTML pages, Markdown, code, PDFs and images) over MCP, so they can be opened in a browser. Each publish of an existing artifact adds a version.

An image artifact is one PNG, JPEG, GIF, WebP or SVG file. Its bytes must match its extension, or the publish is refused. On the content host, its entry opens as a page that centers the image, and `?raw=1` returns the file itself. SVG can carry script, so like every other non-PDF response it gets the CSP sandbox.

One process serves two hosts, picked by the `Host` header:

- **App host** (`APP_ORIGIN`): the web UI, behind Authentik forward auth, which trusts the `X-authentik-email` header. Forward auth is skipped on `/mcp`, the MCP endpoint (streamable HTTP), where agents authenticate with personal access tokens (`Authorization: Bearer aa_...`), and on `/healthz`.
- **Content host** (`CONTENT_ORIGIN`): serves the artifact files from signed URLs, with no forward auth and no cookies. An artifact's HTML and scripts run on a different origin than the app, so they can't reach the app's session or API. The entry of a Markdown, code or image artifact is shown as a page; add `?raw=1` for the file itself.

Artifacts are stored in a SQLite database and in files under `DATA_DIR`.

## Local setup

Needs Node 24 and pnpm 10. There's no build step: Node runs the TypeScript in `src/` directly.

```sh
cp .env.example .env
pnpm install
pnpm dev                     # http://localhost:3000
```

The content host needs a second hostname. `.env.example` uses `content.localhost:3000`, which browsers resolve to 127.0.0.1 without any setup (for curl, use `--resolve content.localhost:3000:127.0.0.1`). `DEV_USER` stands in for the Authentik user.

## Scripts

| Script                       | Purpose                                       |
| ---------------------------- | --------------------------------------------- |
| `pnpm dev`                   | Run with `--watch`, loading `.env` if present |
| `pnpm start`                 | Run `src/server.ts`                           |
| `pnpm lint`, `pnpm lint:fix` | Biome                                         |
| `pnpm typecheck`             | `tsc --noEmit`                                |
| `pnpm test`                  | `node --test` on `src/**/*.test.ts`           |

## Environment

| Variable         | Required | Purpose                                                                                                                         |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`     | yes      | Public origin of the app host, e.g. `https://artifacts.example.com`                                                             |
| `CONTENT_ORIGIN` | yes      | Public origin of the content host. Must be a different host than `APP_ORIGIN`                                                   |
| `SIGNING_SECRET` | yes      | At least 32 characters, signs content URLs. Changing it breaks every outstanding content link: `openssl rand -base64 32`        |
| `PORT`           | no       | Defaults to `3000`                                                                                                              |
| `DATA_DIR`       | no       | SQLite database and artifact files. Defaults to `./data`, and to `/data` in the image                                           |
| `DEV_USER`       | no       | Local only: the signed-in user when there's no forward-auth header. The app refuses to start with it when `NODE_ENV=production` |

## Deployment

CI pushes `ghcr.io/tim-brand/agent-artifacts` (`:latest` and `:<short sha>`) after a green build on `master`, then restarts the deployment and waits for it. Without the `KUBE_DEPLOY_TOKEN` and `KUBE_DEPLOY_CA_CERT` repository secrets it skips the restart.

The image runs as `node`, listens on port 3000 with health at `/healthz` (send the app host as `Host`), and writes only to `/data`, which needs a persistent volume. SQLite allows one writer, so run a single replica. The manifests, ingress and Authentik setup are in the home-infra repo, in `env/talos-cluster/agent-artifacts`.
