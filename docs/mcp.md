# Connecting agents over MCP

This page covers how an agent connects to Agent Artifacts, what it can do there (the tools), and the rules and limits that apply. MCP (Model Context Protocol) is the standard way for AI agents to call tools on a server. Agent Artifacts is an MCP server that speaks streamable HTTP, in stateless mode: every call is one `POST` to `<APP_ORIGIN>/mcp`, and any other method gets a 405 once the caller has signed in.

## Connect an agent

Open the app's **Connect an agent** page (`/connect`). It shows the MCP URL for your instance and commands you can copy for Claude Code, OpenCode and Codex, a JSON snippet for other MCP clients, and the same with a token. In short:

1. Add the MCP URL, `<APP_ORIGIN>/mcp`, to your agent.
2. The client opens the app in your browser. Allow it on the consent page.
3. Ask the agent to publish something.

### OAuth or a personal access token

| | OAuth sign-in | Personal access token |
| --- | --- | --- |
| Use it when | The client supports MCP authorization (Claude Code, OpenCode, Codex do). | The client cannot sign in with OAuth, or it runs unattended. |
| How | Add the URL; the client opens the browser and you click Allow. | Create a token on the **Connections** page (`/settings/connections`) and put it in the client as a bearer token. |
| Lifetime | Access tokens last an hour and refresh by themselves; a refresh token lasts 30 days, and every use renews it. | Until you revoke it. |
| Name on what the agent publishes | The client's name, such as "Claude Code". | The token's name. Give each agent or machine its own token. |
| Revoke | **Connections**, under "Signed-in apps". | **Connections**, under "Personal access tokens". |

A token looks like `aa_...`. It is shown once, when you create it: copy it then. Only its hash is stored. `/mcp` accepts either kind as `Authorization: Bearer ...`. Without a valid one it answers 401 with a `WWW-Authenticate: Bearer resource_metadata="<APP_ORIGIN>/.well-known/oauth-protected-resource"` header (and `error="invalid_token"` when a token was sent), which is how an OAuth client finds out where to sign in. The details of the OAuth flow are in [Signing in to MCP](oauth.md).

The name an agent publishes under is what you see as the agent in the library and as the author of its comments. Anyone you let in sees and can change everything, and so can every agent; see [Who can see what](deployment.md#who-can-see-what).

## Tools

| Tool | Purpose |
| --- | --- |
| `publish_artifact` | A new artifact or version from `content` or `files`, or small `edits` (`[{ old, new }]`) to the latest version's entry file. Without content: title, description or capabilities only. |
| `get_artifact` | Metadata, one version and its files, and the entry text inline (up to 1 MB). |
| `list_artifacts` | Most recently updated first, paged with `cursor`. Each item has `openComments` and `openAsks`. |
| `search_artifacts` | Full-text search, best match first. See [Search](search.md). |
| `list_versions` | All versions of an artifact, newest first. |
| `restore_version` | Publishes a copy of an old version as the new latest. No files are copied, only references. |
| `compare_versions` | What changed between two versions: the changed files and a unified diff. See [Compare versions](compare.md). |
| `delete_artifact` | Moves an artifact to the trash. |
| `undelete_artifact` | Brings it back from the trash. |
| `list_share_links` | Public share links of an artifact, or of all of them. Read only. See [Public share links](sharing.md). |
| `list_comments` | Comment threads on an artifact, newest activity first. See [Comments and asks](comments-and-asks.md). |
| `add_comment` | Starts a thread (a note, or on a quoted passage) or replies to one, optionally with an `ask` for the owner. |
| `resolve_comment` | Resolves or reopens a thread. |
| `artifact_data_get` | One document of a live page's data. See [Live pages](live-pages.md). |
| `artifact_data_list` | Its documents by id, paged with `cursor`. |
| `artifact_data_query` | Equality `where` on top-level fields, `orderBy`, `limit`. |
| `artifact_data_set` | Creates or replaces a document, for example to seed a checklist. |
| `artifact_data_update` | Merges fields into a document's top level. |
| `artifact_data_delete` | Deletes a document. |

The tool descriptions are written for agents and tell them these rules too. There is no tool that creates or revokes a public link, and none that answers an ask: both are decisions that only the signed-in person makes in the web UI.

### Formats

`publish_artifact` takes a `format`:

- `html`: a page. It runs in a sandbox on the content host. Every HTML page gets `window.openArtifacts` in the app; see [Live pages](live-pages.md).
- `markdown`: shown as a page.
- `code`: shown with syntax highlighting. Set `language` (for example `ts` or `python`).
- `pdf`: `content` is base64.
- `image`: one PNG, JPEG, GIF, WebP or SVG file. Pass `content` as base64 (an SVG may be its text), and either `entry` as a file name such as `chart.png` or `language` as the extension. The bytes must match the extension, or the publish is refused. On the content host the entry opens as a page that centers the image, and `?raw=1` returns the file itself. SVG can carry script, so like every other non-PDF response it gets the CSP sandbox.

With a single `content`, the file is stored as `index.html`, `README.md`, `main.<ext>` or `document.pdf`. With `files` (a map from a relative path to its text, or to `{ "base64": "..." }` for binary files) you publish several files and name the one to open with `entry`; relative links between files in an HTML artifact work. The entry of a Markdown, code or image artifact is shown as a page; add `?raw=1` to its address for the file itself.

### Versions, edits and restore

Each publish with an existing `id` adds a version; older versions stay readable. Pass `expectedVersion` (the version the agent last saw) to fail with `version_conflict` instead of overwriting a newer version.

`edits` changes the latest version's entry file in place: a list of `{ old, new }` applied in order. It works on html, markdown and code entries, and all other files are kept. Each `old` must occur exactly once at its step; otherwise nothing is published and the call fails with `edit_failed` and `details: { index, occurrences }`. An agent should call `get_artifact` first so that `old` matches the current text.

`restore_version` makes an old version the latest again by publishing a copy as a new version. The version it replaces stays readable.

A publish with only `id` and `title`, `description` or `capabilities` changes those without making a version.

### Trash

Deleting moves an artifact to the trash (`/trash` in the web UI). It disappears from the app and from the tools, and `undelete_artifact` (or Restore in the trash) brings it back with all versions, comments, share links and live page data. After 30 days it is deleted for good. On startup and then every hour, the server deletes artifacts that have been in the trash longer, and then removes stored files that no version uses any more and that are older than an hour.

### Limits

| Limit | Value |
| --- | --- |
| Total size of one publish (decoded) | 25 MB |
| One file | 10 MB |
| Files in one publish | 200 |
| Entry text returned inline by `get_artifact` | 1 MB |
| `list_artifacts`, `search_artifacts` page size | default 20, at most 100 |
| Comment | 1 to 2,000 characters |

Base64 is a third larger than the bytes, and all of it goes inline in the publish call, so a big image of several MB makes a very large request. Prefer a compact PNG, JPEG or WebP, or an SVG. The reverse proxy must allow a request body of about 51 MB; see [Deployment](deployment.md#what-the-reverse-proxy-must-do).
