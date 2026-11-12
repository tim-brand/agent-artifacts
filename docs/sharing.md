# Public share links

This page covers how to show one artifact to someone who has no access to your instance, and what those links do and do not allow.

## Create a link

Open an artifact in the web UI, go to its **Share** tab and create a link. A link shows the latest version, or only the version you are looking at, and can carry a label and an expiry (never, or 1, 7, 30 or 90 days). The link is `<CONTENT_ORIGIN>/p/<token>/`. It redirects to the entry file, so relative links in a multi-file artifact keep working, and Markdown, code and images render as they do in the app.

The URL is shown once, when you create it: only the SHA-256 of its `sl_` token is stored, so it cannot be shown again. The Share tab lists the links with their last use, and revokes them. A link that follows the latest version shows new versions as soon as they are published.

Anyone who has the URL can open the artifact without signing in. Treat the URL like a password.

## Who can create links

Only the web UI creates or revokes links. Making something public is the owner's decision, so MCP has just the read-only `list_share_links`, which lets an agent tell where its work is visible. For each link it returns the pinned `version` (null means the latest) and whether it is still `active`.

## What a public link does

Responses under `/p/` differ from the signed `/s/` links that the app itself uses:

- `frame-ancestors 'none'`: they are opened as a page on their own and cannot be framed.
- `X-Robots-Tag: noindex, nofollow`.
- `Cache-Control: no-store` for links that follow the latest version. Links pinned to a version may be cached for 5 minutes.
- An unknown, revoked or expired token, or one whose artifact is deleted, gets the same 404, so a token cannot be probed. A deleted artifact's links work again if it is restored from the trash.
- They are rate limited to 60 requests a minute per client IP, in memory. The client IP is the first entry of the `X-Forwarded-For` header, which the reverse proxy must set; see [Deployment](deployment.md#what-the-reverse-proxy-must-do).
- Public links never get the comment bridge. An HTML page that declares [live page](live-pages.md) capabilities gets a version of the runtime script that cannot talk to anything.

Like all artifact content, a public page runs on the content host in a sandbox, away from the app. See [Architecture](architecture.md#two-hosts).
