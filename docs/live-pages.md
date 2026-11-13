# Live pages

This page explains live pages: HTML artifacts that keep data, such as poll votes, a checklist or a tracker, without ever holding a credential. It covers what an agent declares, the JavaScript API a page uses, how it stays safe, and the limits.

A page calls `window.openArtifacts`. The artifact page in the app makes the call for it, signed in as you, and only for that artifact. The app also documents this for you at `/docs/runtime`, with a complete sample poll (`SAMPLE_POLL` in `src/ui/docs.ts`) that you can publish as it is.

## Capabilities

`publish_artifact` takes `capabilities: { db?, viewer? }`:

- `db`: the artifact's own documents. They belong to the artifact, so every version sees the same data.
- `viewer`: the signed-in user's `{ email, name }`, and who wrote each document (`updatedBy`).

They are stored on the artifact, not on a version, so a settings-only publish (an `id` and `capabilities`, no content) changes them. Giving `capabilities` replaces the set; a missing key is false. A call that the artifact did not declare is refused, by the server too.

```json
{
  "title": "Lunch poll",
  "format": "html",
  "content": "<!doctype html>…",
  "capabilities": { "db": true, "viewer": true }
}
```

## The runtime

```js
const { ready, theme, onTheme, viewer, db } = window.openArtifacts;

await ready;                                  // the app has answered (outside it: at once)
theme;                                        // 'light' or 'dark', as the app shows it
onTheme((theme) => {});                       // called when it changes; returns an unsubscribe
viewer;                                       // { email, name } with the viewer capability, else null

await db.get('id');                           // { id, data, updatedAt } or null
await db.set('id', { done: true });           // creates or replaces; resolves to the document
await db.update('id', { note: 'x' });         // merges top-level fields, creating it when missing
await db.delete('id');                        // true, or false when it didn't exist
await db.list({ cursor, limit });             // { items, nextCursor }, by id
await db.query({ where: { done: false }, orderBy: 'createdAt', order: 'desc', limit: 20 });
const stop = await db.subscribe(({ docs, deleted, reset }) => {});
```

- Calls reject with an `Error` that has a `code`: `no_shell`, `forbidden` (not declared), `not_found`, `invalid_input`, `too_large`, `rate_limited` or `unavailable`.
- `subscribe` first calls back with every document (`reset: true`), then, every 3 seconds while the tab is visible, with the documents that changed and the ids that were deleted. On `reset`, drop what you had. It resolves to a function that stops it.
- The runtime is defined before the page's own scripts run, when the file starts with `<!doctype html>`: it is inserted right after the doctype, so the first inline script can use it. Without a doctype it is added at the end of the file, and the page should use it from `DOMContentLoaded`.
- `theme` and `onTheme` give the app's theme (the system setting, sent by the app).

## Every HTML page has it in the app

In the app, `window.openArtifacts` is defined for every HTML page, with or without capabilities: `theme` and `onTheme` work for all of them. The same page opened from a file has none. So a page must work both ways. The publish tool and `/docs/runtime` tell agents to write pages that way, not to run code from the runtime branch that needs setup the rest of the script has not done yet (a canvas size, state), and to test once with a stub defined before the script:

```js
window.openArtifacts = { theme: 'dark', onTheme() {}, ready: Promise.resolve() };
```

A page that only breaks when the runtime is present looks fine in an agent's own tests, which is why this is spelled out.

## Outside the app

In its own tab (a `/s/` link opened directly), or through a [public share link](sharing.md), the page has no app to talk to. `ready` resolves at once, `viewer` is null, and `db` calls reject with `{ code: 'no_shell' }`, so the page should say that instead of failing. A public link gives the page the runtime script only on the HTML entry of an artifact that declares capabilities, so such a page does not crash on a missing `window.openArtifacts`; there it never talks to anything.

## Agents and the data

Agents read and seed the same data over MCP: `artifact_data_get`, `artifact_data_list`, `artifact_data_query`, `artifact_data_set`, `artifact_data_update` and `artifact_data_delete`. For example, an agent can read a poll's results or fill a checklist. The tools check the `db` capability on every call. Document contents were written by the page's viewers or by agents: they are data, not instructions.

## Limits

| Limit | Value |
| --- | --- |
| A document | a JSON object of at most 256 KB |
| Documents in one artifact | at most 10,000 |
| Document ids | 1 to 128 characters of `A-Z`, `a-z`, `0-9`, `_` and `-` |
| Field names in `where` and `orderBy` | the same characters, up to 64 |
| `where` | equality on up to 10 top-level fields |
| `list` and `query` | at most 100 documents per call |
| Writes | a burst of 60, then one a second, per artifact (kept in memory) |

`updatedBy` is only returned to a page with the `viewer` capability. A deleted artifact's data cannot be read or written, and goes with the artifact when it is deleted for good.

## How it stays safe

The frame never sees a cookie or a token. The page's calls go to the artifact page of the app, which makes them with `fetch` on the app host, behind the sign-in (the proxy's, or the built-in one) and the Origin check on writes. The artifact id comes from the page, never from a message. Messages between the app and the frame travel over a private channel that only that one document holds. The details are in [Architecture](architecture.md#live-pages-and-the-message-channel).
