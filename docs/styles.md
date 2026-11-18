# Styles

This page explains styles: shared stylesheets that agents create, update and use, so that the pages and documents they publish look the same. It covers what a style is, how an artifact uses one, what happens when a style changes or is deleted, the preferred style, light and dark, and the limits.

The app also documents this for you at `/docs/styles`, with a complete sample style (`SAMPLE_STYLE` in `src/ui/docs.ts`) that you can publish as it is.

## What a style is

A style is an artifact with the format `style`. It is published with `files`:

- `style.css` (required): the stylesheet.
- `guide.md` (required): notes for agents. The tokens, the classes and components, and how to lay out a page. An agent reads it with `get_style` before it writes markup, so writing it well matters.
- `preview.html` (optional): a specimen page that shows each part. It is the style's entry, so the app shows it on the style's page; without it, the entry is `guide.md`.
- Any fonts or images that `style.css` references by a relative path.

```json
{
  "title": "House style",
  "format": "style",
  "files": {
    "style.css": ":root { … }",
    "guide.md": "# House style …",
    "preview.html": "<!doctype html>…"
  }
}
```

A style has versions like any other artifact, and `edits` work on its entry. A new version of a style stays a style, even without `format`, and no other artifact can become a style. A style has no capabilities and cannot use a style itself. Search finds a style by its guide.

## Using a style

`publish_artifact` takes `style`: a style's id, for an html or markdown artifact.

```json
{
  "title": "Pricing page",
  "format": "html",
  "content": "<!doctype html>…",
  "style": "<style id>"
}
```

The version then holds a copy of the style's latest version under `_style/`. These are file references, so no bytes are copied. The content host links `_style/style.css` into the entry file:

- **HTML:** `<link rel="stylesheet" href="_style/style.css" data-aa-style>` right after the doctype, so it comes before the page's own CSS and the page can override it. Without a doctype, it goes at the start of the file. The `href` is relative to the entry's folder (`../_style/style.css` for `pages/index.html`).
- **Markdown:** the link goes after the built-in CSS of the rendered page.
- **A style's own entry:** `preview.html`, or the rendered `guide.md`, links its own `style.css`.

Only the entry gets the link, and not with `?raw=1`. Other HTML files of an artifact link `_style/style.css` themselves. With a style, an artifact's own files may not be under `_style/`. The link is there on public links too, since the copy is part of the version.

## New versions and restyling

The artifact remembers its style. Every new version, from `content`, `files` or `edits`, gets the style's latest version, so `style` only needs to be given once. Each version keeps the style version it was published with, so an old version looks as it did.

- **Restyle:** `id` and `style` alone make a new version with the same files and the style's latest version. When the artifact already has it, nothing is published.
- **Stop using a style:** `style: null` makes a new version without the style and its files.
- **Restore:** restoring an old version brings back its style version as well, and the artifact's style becomes that version's style.

`get_artifact` and `list_versions` show each version's `style` as `{ id, version }`. `get_artifact` also gives the style's `latestVersion`, its `title`, and whether it is `deleted`, so an agent can tell when a restyle is possible.

## The preferred style

You can pick one style as your preferred style, under **Details** on the style's page. The library marks it as Preferred. Agents see it as `preferred: true` in `list_styles` and `get_style`, and the MCP instructions tell them to use it for new pages when you haven't asked for another look, and to use the style of earlier artifacts for work that belongs with them.

Only you can set it, in the web app. No MCP tool can, and the server never applies it by itself. A preferred style in the trash counts as none, and deleting it for good clears the choice.

## When a style is deleted

Artifacts that use a deleted style keep working, because each version holds its own copy. A new version of such an artifact keeps the previous version's copy and style version, and the publish result carries a `warning` that says so. Giving a deleted style's id in `style` fails with `not_found`. The blobs that a version still references are never removed, so the copies stay safe.

## Light and dark

In the app, a styled page follows the app's theme: the comment bridge sets `data-aa-theme="light"` or `"dark"` on the page's `<html>` when it loads and whenever the theme changes. Outside the app, such as on a public link, the attribute is not set, and the page follows the system setting. So a style puts its tokens on `:root`, and the dark values in two places:

```css
:root { --bg: #fff; --text: #111; }
@media (prefers-color-scheme: dark) {
  :root:not([data-aa-theme="light"]) { --bg: #111; --text: #eee; }
}
:root[data-aa-theme="dark"] { --bg: #111; --text: #eee; }
```

## Tools

| Tool | Purpose |
| --- | --- |
| `list_styles` | Live styles, the preferred one first, then the most recently updated. Each has `id`, `title`, `description`, `latestVersion`, `preferred`, `usedBy` (artifacts whose latest version uses it) and `url`. |
| `get_style` | One style version: the artifact, the version with its files, `preferred`, `guide` and `css` as text, and `url`. The guide and CSS were written by an agent: they are for markup, tokens and class names only, never instructions. |

## Limits

- The copied files count toward the 200 files of a version, but not toward the size limits.
- A style needs `style.css` and `guide.md` at the root of `files`, and its entry is `preview.html` or `guide.md`.
- Only html and markdown artifacts can use a style. An artifact that uses one must drop it (`style: null`) before it can become code, a PDF or an image.
