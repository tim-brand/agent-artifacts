import { html, raw } from 'hono/html';
import {
  type Artifact,
  type DeletedArtifact,
  type Format,
  type SearchHit,
  type ShareLink,
  type TokenInfo,
  TRASH_DAYS,
  type Version,
} from '../contracts.ts';
import { type Html, layout } from './layout.ts';

export const FORMATS: readonly Format[] = ['html', 'markdown', 'code', 'pdf', 'image'];

const SANDBOX =
  'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads allow-modals';

const current = (on: boolean) => (on ? raw(' aria-current="page"') : '');

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (Number.isNaN(seconds)) return iso;
  if (seconds < 45) return 'just now';
  const steps: [number, string][] = [
    [60, 'minute'],
    [60 * 60, 'hour'],
    [60 * 60 * 24, 'day'],
  ];
  if (seconds < 60 * 60 * 24 * 30) {
    let n = 0;
    let unit = '';
    for (const [size, name] of steps) {
      if (seconds >= size * 0.75) {
        n = Math.max(1, Math.round(seconds / size));
        unit = name;
      }
    }
    return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }
  return iso.slice(0, 10);
}

const time = (iso: string) =>
  html`<time datetime="${iso}" title="${iso}">${relativeTime(iso)}</time>`;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const copyButton = (target: string) =>
  html`<button type="button" data-copy="${target}">Copy</button>`;

export function messagePage(user: string | null, title: string, message: string): Html {
  return layout({
    title,
    user,
    body: html`<h1>${title}</h1><p class="muted">${message}</p>${user ? html`<p><a href="/">Back to artifacts</a></p>` : ''}`,
  });
}

/** The snippet is escaped like any text; only its «…» match markers become <mark>. */
export function highlight(snippet: string): Html {
  const parts = snippet.split(/«([^«»]*)»/);
  return html`${parts.map((part, i) => (i % 2 === 1 ? html`<mark>${part}</mark>` : part))}`;
}

const searchBox = (query: string) =>
  html`<form class="search" method="get" action="/" role="search">
<input type="search" name="q" value="${query}" placeholder="Search artifacts" maxlength="200" aria-label="Search artifacts">
<button type="submit">Search</button>
</form>`;

const versionCount = (a: Artifact) =>
  html`<span class="meta">${a.latestVersion} version${a.latestVersion === 1 ? '' : 's'}</span>`;

export function listPage(opts: {
  user: string;
  items: Artifact[];
  nextCursor: string | null;
  format: Format | undefined;
}): Html {
  const chipHref = (f: Format | undefined) => (f ? `/?format=${f}` : '/');
  const chips = html`<nav class="chips" aria-label="Filter by format">
<a href="/"${current(!opts.format)}>All</a>
${FORMATS.map((f) => html`<a href="${chipHref(f)}"${current(opts.format === f)}>${f}</a>`)}
</nav>`;

  const moreHref = opts.nextCursor
    ? `/?${new URLSearchParams({ ...(opts.format ? { format: opts.format } : {}), cursor: opts.nextCursor })}`
    : null;

  const body =
    opts.items.length === 0
      ? html`<div class="empty"><p>No artifacts${opts.format ? html` in <strong>${opts.format}</strong>` : ''} yet.</p>
<p><a href="/connect">Connect an agent</a> and ask it to publish something.</p></div>`
      : html`<ul class="list">
${opts.items.map(
  (a) => html`<li>
<a class="title" href="/a/${encodeURIComponent(a.id)}">${a.title}</a>
<span class="badge">${a.format}</span>
${versionCount(a)}
<span class="meta">${time(a.updatedAt)}</span>
</li>`,
)}
</ul>
${moreHref ? html`<p class="more"><a href="${moreHref}">Load more</a></p>` : ''}`;

  return layout({
    title: 'Artifacts',
    user: opts.user,
    nav: 'artifacts',
    body: html`<h1>Artifacts</h1>${searchBox('')}${chips}${body}`,
  });
}

export function searchPage(opts: {
  user: string;
  query: string;
  hits: SearchHit[];
  nextCursor: string | null;
}): Html {
  const moreHref = opts.nextCursor
    ? `/?${new URLSearchParams({ q: opts.query, cursor: opts.nextCursor })}`
    : null;

  const body =
    opts.hits.length === 0
      ? html`<div class="empty"><p>Nothing matches <strong>${opts.query}</strong>.</p></div>`
      : html`<ul class="list">
${opts.hits.map(
  ({ artifact: a, snippet }) => html`<li>
<a class="title" href="/a/${encodeURIComponent(a.id)}">${a.title}</a>
<span class="badge">${a.format}</span>
${versionCount(a)}
<span class="meta">${time(a.updatedAt)}</span>
${snippet ? html`<p class="hit">${highlight(snippet)}</p>` : ''}
</li>`,
)}
</ul>
${moreHref ? html`<p class="more"><a href="${moreHref}">More results</a></p>` : ''}`;

  return layout({
    title: `Search: ${opts.query}`,
    user: opts.user,
    nav: 'artifacts',
    body: html`<h1>Artifacts</h1>${searchBox(opts.query)}
<p class="muted">Results for <strong>${opts.query}</strong> · <a href="/">Show all</a></p>
${body}`,
  });
}

export function artifactPage(opts: {
  user: string;
  artifact: Artifact;
  version: Version;
  versions: Version[];
  url: (path: string) => string;
  shareLinks: ShareLink[];
  createdLink?: { url: string; link: ShareLink };
}): Html {
  const { artifact: a, version: v } = opts;
  const entryUrl = opts.url(v.entry);
  const isLatest = v.version === a.latestVersion;

  const switcher = html`<details class="menu">
<summary>Version ${v.version}${isLatest ? ' (latest)' : ''} of ${a.latestVersion}</summary>
<ul>
${opts.versions.map(
  (x) =>
    html`<li><a href="/a/${encodeURIComponent(a.id)}/v/${x.version}"${current(x.version === v.version)}>v${x.version} · ${x.publishedBy} · <time datetime="${x.createdAt}" title="${x.createdAt}">${relativeTime(x.createdAt)}</time></a></li>`,
)}
</ul>
</details>`;

  const files =
    v.files.length > 1
      ? html`<details class="files"><summary>${v.files.length} files</summary><ul>
${v.files.map(
  (f) =>
    html`<li><a href="${opts.url(f.path)}" target="_blank" rel="noopener noreferrer">${f.path}</a> <span class="muted">${size(f.size)}</span></li>`,
)}
</ul></details>`
      : '';

  // Chrome refuses to render PDFs in sandboxed frames, so PDFs get none. Without allow-same-origin
  // the other formats run in an opaque origin; the content host is a separate origin either way.
  const sandbox = v.format === 'pdf' ? '' : html` sandbox="${SANDBOX}"`;

  return layout({
    title: a.title,
    user: opts.user,
    wide: true,
    body: html`<h1>${a.title}</h1>
${a.description ? html`<p class="desc">${a.description}</p>` : ''}
<div class="bar">
<span class="badge">${v.format}</span>
${switcher}
<span class="muted">${v.publishedBy} · ${time(v.createdAt)}</span>
<a href="${entryUrl}" target="_blank" rel="noopener noreferrer">Open in new tab</a>
${isLatest ? '' : html`<form class="inline" method="post" action="/a/${encodeURIComponent(a.id)}/v/${v.version}/restore"><button type="submit">Restore this version</button></form>`}
<form class="inline" method="post" action="/a/${encodeURIComponent(a.id)}/delete" data-confirm="Delete this artifact? It stays in the trash for ${TRASH_DAYS} days."><button class="danger" type="submit">Delete</button></form>
</div>
${files}
${shareSection(a, v, opts.shareLinks, opts.createdLink)}
<iframe class="artifact" src="${entryUrl}" title="${a.title}"${sandbox}></iframe>`,
  });
}

export function trashPage(opts: { user: string; items: DeletedArtifact[] }): Html {
  const body =
    opts.items.length === 0
      ? html`<div class="empty"><p>The trash is empty.</p></div>`
      : html`<ul class="list">
${opts.items.map(
  (a) => html`<li>
<span class="title">${a.title}</span>
<span class="badge">${a.format}</span>
<span class="meta">deleted ${time(a.deletedAt)}</span>
<form class="inline" method="post" action="/trash/${encodeURIComponent(a.id)}/restore"><button type="submit">Restore</button></form>
</li>`,
)}
</ul>`;

  return layout({
    title: 'Trash',
    user: opts.user,
    nav: 'trash',
    body: html`<h1>Trash</h1>
<p class="muted">Deleted artifacts are kept for ${TRASH_DAYS} days, then deleted for good.</p>
${body}`,
  });
}

const EXPIRY_CHOICES: [string, string][] = [
  ['', 'Never expires'],
  ['1', 'Expires in 1 day'],
  ['7', 'Expires in 7 days'],
  ['30', 'Expires in 30 days'],
  ['90', 'Expires in 90 days'],
];

function shareSection(
  a: Artifact,
  v: Version,
  links: ShareLink[],
  created?: { url: string; link: ShareLink },
): Html {
  const base = `/a/${encodeURIComponent(a.id)}`;
  const notice = created
    ? html`<div class="notice warn">
<p><strong>Public link created.</strong> Copy it now: it is shown only once and cannot be retrieved later.</p>
<div class="snippet"><pre><code id="share-url" class="token">${created.url}</code></pre>${copyButton('share-url')}</div>
</div>`
    : '';

  const expires = (l: ShareLink) => {
    if (!l.expiresAt) return html`<span class="muted">never</span>`;
    if (Date.parse(l.expiresAt) <= Date.now()) return html`<span class="badge">expired</span>`;
    return html`<time datetime="${l.expiresAt}" title="${l.expiresAt}">${l.expiresAt.slice(0, 16).replace('T', ' ')} UTC</time>`;
  };

  const rows =
    links.length === 0
      ? html`<p class="muted">No public links.</p>`
      : html`<table>
<thead><tr><th>Label</th><th>Shows</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr></thead>
<tbody>
${links.map(
  (l) => html`<tr>
<td>${l.label || html`<span class="muted">no label</span>`}</td>
<td>${l.version === null ? 'Latest version' : html`<a href="${base}/v/${l.version}">Version ${l.version}</a>`}</td>
<td>${time(l.createdAt)}</td>
<td>${expires(l)}</td>
<td>${l.lastUsedAt ? time(l.lastUsedAt) : html`<span class="muted">never</span>`}</td>
<td><form class="inline" method="post" action="${base}/share/${encodeURIComponent(l.id)}/revoke" data-confirm="Revoke this link? Anyone using it loses access."><button class="danger" type="submit">Revoke</button></form></td>
</tr>`,
)}
</tbody>
</table>`;

  return html`<details class="share"${created ? raw(' open') : ''}>
<summary>Share${links.length ? ` · ${links.length} public link${links.length === 1 ? '' : 's'}` : ''}</summary>
${notice}
<p class="muted">Anyone with a public link can open this artifact without signing in, until you revoke it.</p>
<form method="post" action="${base}/share" class="bar">
<select name="version" aria-label="Version to show">
<option value="latest">Always the latest version</option>
<option value="${v.version}">Only version ${v.version}</option>
</select>
<input type="text" name="label" placeholder="Label, e.g. family" maxlength="100" aria-label="Label">
<select name="expires" aria-label="Expiry">
${EXPIRY_CHOICES.map(([value, label]) => html`<option value="${value}">${label}</option>`)}
</select>
<button type="submit">Create public link</button>
</form>
${rows}
</details>`;
}

export function tokensPage(opts: {
  user: string;
  tokens: TokenInfo[];
  created?: { token: string; info: TokenInfo };
  error?: string;
}): Html {
  const created = opts.created
    ? html`<div class="notice warn">
<p><strong>Token "${opts.created.info.name}" created.</strong> Copy it now: it is shown only once and cannot be retrieved later.</p>
<div class="snippet"><pre><code id="new-token" class="token">${opts.created.token}</code></pre>${copyButton('new-token')}</div>
<p><a href="/connect">How to connect an agent</a></p>
</div>`
    : '';

  const rows =
    opts.tokens.length === 0
      ? html`<p class="muted">No tokens yet.</p>`
      : html`<table>
<thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
<tbody>
${opts.tokens.map(
  (t) => html`<tr>
<td>${t.name}</td>
<td>${time(t.createdAt)}</td>
<td>${t.lastUsedAt ? time(t.lastUsedAt) : html`<span class="muted">never</span>`}</td>
<td><form class="inline" method="post" action="/settings/tokens/${encodeURIComponent(t.id)}/revoke" data-confirm="Revoke this token? Agents using it lose access."><button class="danger" type="submit">Revoke</button></form></td>
</tr>`,
)}
</tbody>
</table>`;

  return layout({
    title: 'Tokens',
    user: opts.user,
    nav: 'tokens',
    body: html`<h1>Tokens</h1>
<p class="muted">Agents use a token to publish over MCP. Create one per agent or machine.</p>
${created}
${opts.error ? html`<div class="notice error">${opts.error}</div>` : ''}
<form method="post" action="/settings/tokens" class="bar">
<input type="text" name="name" placeholder="Name, e.g. laptop-claude-code" required maxlength="100" aria-label="Token name">
<button type="submit">Create token</button>
</form>
${rows}`,
  });
}

export function connectPage(opts: { user: string; appOrigin: string }): Html {
  const mcpUrl = `${opts.appOrigin}/mcp`;
  const claude = `claude mcp add --transport http -s user agent-artifacts ${mcpUrl} --header "Authorization: Bearer <TOKEN>"`;
  const opencode = JSON.stringify(
    {
      mcp: {
        'agent-artifacts': {
          type: 'remote',
          url: mcpUrl,
          headers: { Authorization: 'Bearer {file:~/.agent-artifacts-token}' },
        },
      },
    },
    null,
    2,
  );
  const generic = JSON.stringify(
    {
      mcpServers: {
        'agent-artifacts': {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: 'Bearer <TOKEN>' },
        },
      },
    },
    null,
    2,
  );
  const snippet = (id: string, text: string) =>
    html`<div class="snippet"><pre><code id="${id}">${text}</code></pre>${copyButton(id)}</div>`;

  return layout({
    title: 'Connect',
    user: opts.user,
    nav: 'connect',
    body: html`<h1>Connect an agent</h1>
<p>Agents publish over MCP (streamable HTTP) with a bearer token. <a href="/settings/tokens">Create a token</a> first and use it in place of <code>&lt;TOKEN&gt;</code>.</p>
<h2>MCP URL</h2>
${snippet('mcp-url', mcpUrl)}
<h2>Claude Code</h2>
${snippet('claude', claude)}
<h2>OpenCode</h2>
<p class="muted">In <code>opencode.json</code>. Save the token in <code>~/.agent-artifacts-token</code>.</p>
${snippet('opencode', opencode)}
<h2>Other MCP clients</h2>
${snippet('generic', generic)}`,
  });
}
