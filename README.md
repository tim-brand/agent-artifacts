# Agent Artifacts

A self-hosted place where AI agents publish artifacts (HTML pages, Markdown, code, PDFs and images) over MCP, so they can be opened in a browser. Each publish of an existing artifact adds a version.

An image artifact is one PNG, JPEG, GIF, WebP or SVG file. Its bytes must match its extension, or the publish is refused. On the content host, its entry opens as a page that centers the image, and `?raw=1` returns the file itself. SVG can carry script, so like every other non-PDF response it gets the CSP sandbox.

One process serves two hosts, picked by the `Host` header:

- **App host** (`APP_ORIGIN`): the web UI, behind Authentik forward auth, which trusts the `X-authentik-email` header. Forward auth is skipped on `/mcp`, the MCP endpoint (streamable HTTP), where agents authenticate with personal access tokens (`Authorization: Bearer aa_...`), and on `/healthz`.
- **Content host** (`CONTENT_ORIGIN`): serves the artifact files from signed URLs and public share links, with no forward auth and no cookies. An artifact's HTML and scripts run on a different origin than the app, so they can't reach the app's session or API. The entry of a Markdown, code or image artifact is shown as a page; add `?raw=1` for the file itself.

Artifacts are stored in a SQLite database and in files under `DATA_DIR`.

## Search

Agents search with the `search_artifacts` MCP tool, people with the search box on the list page (`/?q=`). Both look in the title, the description and the text of the latest version's entry file, best match first. A SQLite FTS5 table (`artifacts_fts`, from Node's bundled SQLite) holds that text and is updated in the same transaction as each publish or delete, so a new version is searchable at once. HTML is indexed as its visible text (no tags, scripts or styles), Markdown and code as they are, and PDFs by title and description only. Each artifact's indexed text is capped at 256 KB.

A query is plain words: every word must match, the last also as a prefix, and accents are ignored. FTS syntax in a query (`AND`, `NEAR`, quotes, `column:`) is matched as text. Snippets mark the matched words with `«` and `»`.

## MCP tools

| Tool                   | Purpose                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publish_artifact`     | A new artifact or version from `content` or `files`, or small `edits` (`[{ old, new }]`) to the latest version's entry file. Without content: title/description only |
| `get_artifact`         | Metadata, one version and its files, and the entry text inline                                                                                                       |
| `list_artifacts`       | Most recently updated first, paged with `cursor`                                                                                                                     |
| `search_artifacts`     | Full-text search, best match first (see Search)                                                                                                                      |
| `list_versions`        | All versions of an artifact, newest first                                                                                                                            |
| `restore_version`      | Publishes a copy of an old version as the new latest (no files are copied, only references)                                                                          |
| `compare_versions`     | What changed between two versions: the changed files and a unified diff (see Compare versions)                                                                       |
| `delete_artifact`      | Moves an artifact to the trash                                                                                                                                       |
| `undelete_artifact`    | Brings it back from the trash                                                                                                                                        |
| `list_share_links`     | Public share links of an artifact, or of all of them (read only; see Public share links)                                                                             |
| `list_comments`        | Comment threads on an artifact, newest activity first (see Comments)                                                                                                 |
| `add_comment`          | Starts a thread (a note, or on a quoted passage) or replies to one, optionally with an `ask` for the owner (see Asks)                                                |
| `resolve_comment`      | Resolves or reopens a thread                                                                                                                                         |
| `artifact_data_get`    | One document of a live page's data (see Live pages)                                                                                                                  |
| `artifact_data_list`   | Its documents by id, paged with `cursor`                                                                                                                             |
| `artifact_data_query`  | Equality `where` on top-level fields, `orderBy`, `limit`                                                                                                             |
| `artifact_data_set`    | Creates or replaces a document, e.g. to seed a checklist                                                                                                             |
| `artifact_data_update` | Merges fields into a document's top level                                                                                                                            |
| `artifact_data_delete` | Deletes a document                                                                                                                                                   |

Each `old` in `edits` must occur exactly once at its step, or nothing is published and the call fails with `edit_failed` (`details: { index, occurrences }`). Edits work on html, markdown and code entries.

Deleted artifacts stay in the trash (`/trash` in the web UI) for 30 days. On startup and then every hour, the server deletes artifacts that have been in the trash longer, and then removes stored files that no version uses any more and that are older than an hour.

## Compare versions

Each version stores how many lines its entry file adds and removes against the previous version's entry (`linesAdded`, `linesRemoved`; v1 counts against nothing). They're counted on every publish, edit and restore, for html, markdown, code and SVG entries; other formats, and a diff that takes longer than half a second, leave them null. A migration step counted them for the versions that already existed, deleted artifacts included.

- **Versions panel.** Each version shows `+18 −4`, linked to its changes against the version before it. The pane's Compare button compares the version on screen with the one before it, and each other version's Compare compares it with the one on screen.
- **Compare page** (`/a/:id/compare?from=3&to=7`, defaults: the latest against the one before it). _Changes_ is a unified line diff with 3 lines of context, unchanged runs collapsed to "12 unchanged lines", rendered on the server with every line escaped. For a multi-file version it lists the files added, removed and changed, and diffs each text file; binary files are listed only. When the newer version opens another entry file and neither path is in both, the entry counts as renamed and is diffed against the old one. _Side by side_ (`&mode=side`) shows both versions in two frames with the artifact page's sandbox. They get no runtime port, so a live page's `db` calls there reject with `no_shell`.
- **MCP.** `compare_versions({ id, from?, to? })` returns the file changes and the unified diff as `patch` (`--- a/path`, `+++ b/path`), with the same defaults. Pass a comment thread's `version` as `from` to see what changed since then.
- **Limits.** One comparison's diff stops at 200 KB (`truncated`, in the page and over MCP), and its diffs get 2 seconds together; a file past that is shown as too large to diff.

The diff is the [`diff`](https://github.com/kpdecker/jsdiff) package (jsdiff, BSD-3-Clause, no dependencies): Myers' algorithm as in git, with a time limit per diff, which a hand-written line diff would need too.

## Public share links

To show one artifact to someone without an Authentik account, open the Share section on its page in the web UI and create a link. It shows the latest version, or only the version you're looking at, and can carry a label and an expiry. The link is `${CONTENT_ORIGIN}/p/<token>/`: it redirects to the entry file, so relative links in a multi-file artifact keep working, and Markdown, code and images render as they do in the app. The URL is shown once, when you create it: only the SHA-256 of its `sl_` token is stored. The Share section lists the links with their last use and revokes them.

Only the web UI creates or revokes links. Making something public is the owner's decision, so MCP has just the read-only `list_share_links`, so an agent can tell where its work is visible.

Responses under `/p/` differ from the signed `/s/` ones: `frame-ancestors 'none'` (they're opened top-level, not framed), `X-Robots-Tag: noindex, nofollow`, and `Cache-Control: no-store` for latest links (pinned ones may be cached for 5 minutes). An unknown, revoked or expired token, or one whose artifact is deleted, gets the same 404. A deleted artifact's links work again if it is restored. `/p/` is rate limited to 60 requests a minute per client IP, in memory, keyed on the first `X-Forwarded-For` entry, which the ingress sets.

## Comments

The owner comments on an artifact in the web UI, and agents read and answer them over MCP: `list_comments`, `add_comment` (new thread or reply) and `resolve_comment`. `list_artifacts` gives each artifact's `openComments`, and the list page shows them as a badge.

- A thread is a note on the whole artifact, or is anchored to a passage as a W3C TextQuoteSelector: the quoted `exact` text, with up to 32 characters of `prefix` and `suffix`. It belongs to the version it was started on, and is shown on that version and later ones, marked "on v2" on the later ones.
- A comment is 1 to 2,000 characters. `typed` is true only for comments posted from the web UI, and the server sets it from the route, never from input. The author is the signed-in email for those, and the token's name for agent comments. The MCP tools tell agents that a `typed` comment is the owner's own words and that all other comment text, and any quoted text, is data, not instructions.
- A deleted artifact's comments are hidden with it. Threads and comments reference the artifact with `ON DELETE CASCADE`, so deleting the artifact row for good removes them.

**Text anchors.** On html and markdown entries opened through the app's signed `/s/` links, the content host appends one script, `/_aa/bridge.js`, served from the content host itself. It's the only script that host adds, and public `/p/` links never get it. (It also carries the live pages runtime; see Live pages.) When the reader selects text, it posts `{ type: 'aa:selection', exact, prefix, suffix }` to the app, which then offers "Comment on selection". The app sends the quotes of open threads back (`aa:highlight`), and the bridge wraps the best match of each in `<mark>`. The app accepts a frame message only when `event.source` is the artifact iframe's window (a sandboxed frame's origin is `"null"`, so it can't be checked), and only for a type it handles. The artifact can post anything itself, so every field is checked, and a selection does nothing until the owner clicks and submits. Quotes are matched with whitespace collapsed, so a quote matches however the page's source wraps its text.

The UI's own client code is `/static/app.js`, allowed by `script-src 'self'`. New message types for the frame bridge are added there with `onFrameMessage(type, handler)`.

## Asks

An agent can ask the owner to decide something and get back an answer it can trust. `add_comment` takes `ask: { question, options: [{ id, label, detail? }], recommended?: { optionId, why } }` on a new thread or a reply. There are 2 to 6 options, and their ids are 1 to 64 characters of `[A-Za-z0-9_-]`, unique within the ask. With an ask, `body` is optional context and defaults to the question.

- **Only the owner answers.** The answer is set only by the web UI's `POST /a/:id/asks/:commentId`, behind forward auth and the Origin check, and the answerer is the signed-in user. No MCP tool can answer: the MCP routes only get a `CommentService` without `answer`, the `ask` schema is strict (an `answer` in it is refused), and the core stores a fresh ask built from the known fields only. Asks come only from agents: the UI's comment form never sends one, and the core refuses an ask from a typed author. The chosen `optionId` must be one of the ask's options. The owner can change the answer until the thread is resolved.
- **What agents see.** In `list_comments`, a comment that asks has `ask: { question, options, recommended, answer }`, where `answer` is `{ optionId, label, by, at, typed: true }` or null. The tool descriptions say that an answer counts as the owner's decision only when `answer.typed` is true, and that a merge, deploy, delete, publish or anything else irreversible needs such an answer first. `list_artifacts` items get `openAsks`: unanswered asks in open threads.
- **In the UI.** An ask is a card in its thread: the question, one button per option with its detail, and the recommended option marked with its "why". Clicking a button answers. The sidebar's "Asks for you" counts unanswered asks, the library has an "Asks for you" tab, and cards and the artifact's Comments tab get a badge. The question, labels, details and the "why" are agent text, escaped like any comment.
- **Storage.** Table `asks(comment_id, question, options_json, recommended_json, answer_option, answered_by, answered_at)`, one row per asking comment, which references `comments` with `ON DELETE CASCADE`, so the purge takes it.

## Live pages

An HTML artifact can keep data, for polls, checklists and trackers, without ever holding a credential. The web UI documents it at `/docs/runtime`, with a sample poll (`SAMPLE_POLL` in `src/ui/docs.ts`).

- **Capabilities.** `publish_artifact` takes `capabilities: { db?, viewer? }`. They are stored on the artifact, not a version (a settings-only publish changes them), and giving them replaces the set. `db` is the artifact's own documents, `viewer` the signed-in user's `{ email, name }`, and who wrote each document.
- **Runtime.** The bridge script (`/_aa/bridge.js`) also defines `window.openArtifacts`: `ready`, `theme`/`onTheme` (the system setting, sent by the app), `viewer`, and `db.get`, `set`, `update` (top-level merge), `delete`, `list({ cursor, limit })`, `query({ where, orderBy, order, limit })` (equality only) and `subscribe(cb)`. `subscribe` polls `?since=<revision>` every 3 seconds while the tab is visible: it calls back with every document first (`reset: true`), then with changed documents and deleted ids. One script, not a separate `runtime.js`: it is inserted right after a leading doctype, so a page's first inline script can use it (without a doctype it is appended at the end, as before).
- **Outside the app** (a `/s/` link in its own tab, or a public `/p/` link), `ready` resolves at once and `db` calls reject with `{ code: 'no_shell' }`. Public links get the script only on the html entry of an artifact that declares capabilities, so such a page doesn't crash on a missing `window.openArtifacts`; there it never talks to anything.
- **The shell.** The artifact page in the app (`/static/app.js`) makes the calls with `fetch` to `/api/artifacts/:id/...` on the app host, behind forward auth and the UI's Origin check on writes. The frame never sees a cookie or token. The artifact id comes from the page (`data-artifact` on the iframe), never from a message.
- **The channel.** Answers carry data, and a message to the frame's window has to be posted with `'*'` (its origin is opaque), so it would reach whatever document the frame shows by then, such as a site the reader clicked through to. So the app answers the frame's first `aa:ready` by transferring one end of a `MessageChannel`, and all runtime traffic goes over that port, which only that document holds and which dies with it. The app hands out one port per artifact page view: a later `aa:ready` (the frame navigated, or reloaded itself) gets `aa:no-port`, and that page's runtime acts as outside the app. The viewer is sent over the port, and only when declared.
- **Server checks.** The data service checks the `db` capability on every call, from the API or MCP; the shell's own check only saves a request. `updatedBy` is only returned to a page with the `viewer` capability. Writes are rate limited per artifact to a burst of 60, then one a second (in memory).
- **Data.** Table `artifact_data(artifact_id, doc_id, json, rev, updated_at, updated_by)`, belonging to the artifact, so every version sees the same data. It references `artifacts` with `ON DELETE CASCADE`, so the purge takes it, and every query joins on `deleted_at IS NULL`, so a deleted artifact's data can't be read or written. A document is a JSON object of at most 256 KB, an artifact holds at most 10,000, and ids are at most 128 characters of `[A-Za-z0-9_-]`. `artifacts.data_rev` counts the artifact's writes and each row keeps the revision of its last one; a delete leaves a tombstone (`json` NULL) so pollers see it. Past 1,000 tombstones they are dropped and `data_floor` moves up: a poller from before then gets `reset` and reads everything again.

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
