import { html, raw } from 'hono/html';
import {
  type Artifact,
  type Ask,
  type AskOption,
  type AuthorizeParams,
  type AuthorizeRequest,
  COMMENT_LIMITS,
  COMPARE_LIMITS,
  type Comparison,
  type DeletedArtifact,
  type DiffHunk,
  type FileChange,
  type Format,
  type LibraryItem,
  type LibrarySort,
  type OAuthGrant,
  type SearchHit,
  type ShareLink,
  type Thread,
  type TokenInfo,
  TRASH_DAYS,
  type Version,
} from '../contracts.ts';
import { isLoopback } from '../oauth/rules.ts';
import {
  appShell,
  type Html,
  htmlPage,
  icon,
  initials,
  type Shell,
  searchBox,
  type Theme,
  themeSwitch,
} from './layout.ts';

export const FORMATS: readonly Format[] = ['html', 'markdown', 'code', 'image', 'pdf'];

export const FORMAT_LABELS: Record<Format, string> = {
  html: 'HTML',
  markdown: 'Markdown',
  code: 'Code',
  image: 'Image',
  pdf: 'PDF',
};

const SANDBOX =
  'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads allow-modals';

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** "just now", "5m ago", "3h ago", "Yesterday", "4d ago", "Oct 28", "Oct 28, 2025" (UTC). */
export function shortTime(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 2) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  const date = new Date(ms);
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return date.getUTCFullYear() === new Date(now).getUTCFullYear()
    ? day
    : `${day}, ${date.getUTCFullYear()}`;
}

/** A date for "expires …": "Nov 19" or "Nov 19, 2027" (UTC). */
const shortDate = (iso: string) => {
  const date = new Date(iso);
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return date.getUTCFullYear() === new Date().getUTCFullYear()
    ? day
    : `${day}, ${date.getUTCFullYear()}`;
};

const time = (iso: string) => html`<time datetime="${iso}" title="${iso}">${shortTime(iso)}</time>`;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const current = (on: boolean) => (on ? raw(' aria-current="page"') : '');

const copyButton = (target: string) =>
  html`<button type="button" class="btn sm copy" data-copy="${target}">Copy</button>`;

const snippet = (id: string, text: string) =>
  html`<div class="snippet"><pre><code id="${id}">${text}</code></pre>${copyButton(id)}</div>`;

/** The snippet is escaped like any text; only its «…» match markers become <mark>. */
export function highlight(text: string): Html {
  const parts = text.split(/«([^«»]*)»/);
  return html`${parts.map((part, i) => (i % 2 === 1 ? html`<mark>${part}</mark>` : part))}`;
}

const formatIcon = (format: Format) => icon(format);

// ---- Pills ----

const commentsPill = (n: number) =>
  n
    ? html`<span class="pill cmt" title="${plural(n, 'open comment thread')}">${icon('cmt')}${n}</span>`
    : '';
const asksPill = (n: number) =>
  n
    ? html`<span class="pill ask" title="${plural(n, 'ask')} waiting for your answer">${icon('ask')}${n}</span>`
    : '';
const livePill = (a: Artifact) =>
  a.capabilities.db ? html`<span class="pill live">${icon('live')}Live</span>` : '';
const publicPill = (n: number) =>
  n
    ? html`<span class="pill pub" title="${plural(n, 'public link')}">${icon('globe')}Public</span>`
    : '';

// ---- Library ----

export type LibraryTab = 'all' | 'live' | 'shared' | 'comments' | 'asks';
export const LIBRARY_TABS: readonly LibraryTab[] = ['all', 'live', 'shared', 'comments', 'asks'];
const TAB_LABELS: Record<LibraryTab, string> = {
  all: 'All',
  live: 'Live',
  shared: 'Shared publicly',
  comments: 'Open comments',
  asks: 'Asks for you',
};

export type LibraryView = 'grid' | 'list';

/** What the library shows; it all lives in the URL except the view, which a cookie keeps. */
export type LibraryState = {
  tab: LibraryTab;
  format?: Format;
  agent?: string;
  sort: LibrarySort;
  view: LibraryView;
};

/** The library URL for a state, leaving out defaults; `view` only when asked for. */
export function libraryHref(
  state: LibraryState,
  change: Partial<LibraryState> & { cursor?: string } = {},
  withView = false,
): string {
  const s = { ...state, ...change };
  const params = new URLSearchParams();
  if (s.tab !== 'all') params.set('tab', s.tab);
  if (s.format) params.set('format', s.format);
  if (s.agent) params.set('agent', s.agent);
  if (s.sort !== 'updated') params.set('sort', s.sort);
  if (withView) params.set('view', s.view);
  if (change.cursor) params.set('cursor', change.cursor);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

const menu = (summary: Html, items: Html, opts: { right?: boolean; label?: string } = {}) =>
  html`<details class="menu"${opts.label ? html` data-label="${opts.label}"` : ''}><summary>${summary}</summary><div class="menu-pop${opts.right ? ' right' : ''}">${items}</div></details>`;

const menuItem = (href: string, label: string | Html, on: boolean) =>
  html`<a class="menu-item${on ? ' on' : ''}" href="${href}"${current(on)}>${label}</a>`;

function card(item: LibraryItem, preview: string | null): Html {
  const a = item.artifact;
  const thumb = preview
    ? html`<div class="thumb"><div class="mini"><iframe src="${preview}" sandbox="" loading="lazy" tabindex="-1" aria-hidden="true" title=""></iframe></div></div>`
    : html`<div class="thumb tile">${formatIcon(a.format)}<b>${a.title}</b></div>`;
  return html`<article class="card">
${thumb}
<h2 class="ctitle">${formatIcon(a.format)}<a class="stretch" href="/a/${encodeURIComponent(a.id)}">${a.title}</a></h2>
<div class="meta"><span class="agent">${item.agent}</span>${asksPill(item.openAsks)}${commentsPill(item.openComments)}${livePill(a)}${publicPill(item.publicLinks)}<span class="t">${time(a.updatedAt)}</span></div>
</article>`;
}

const subline = (a: Artifact) =>
  `${a.description.split('\n')[0]?.trim() || FORMAT_LABELS[a.format]} · v${a.latestVersion}`;

function row(item: LibraryItem): Html {
  const a = item.artifact;
  return html`<article class="row">
${formatIcon(a.format)}
<div class="row-main"><a class="ttl stretch" href="/a/${encodeURIComponent(a.id)}">${a.title}</a><div class="sub">${subline(a)}</div></div>
<div class="row-pills">${asksPill(item.openAsks)}${commentsPill(item.openComments)}${livePill(a)}${publicPill(item.publicLinks)}</div>
<div class="sub row-agent">${item.agent}</div>
<div class="sub t">${time(a.updatedAt)}</div>
</article>`;
}

export function libraryPage(opts: {
  shell: Shell;
  state: LibraryState;
  items: LibraryItem[];
  nextCursor: string | null;
  counts: Record<LibraryTab, number>;
  /** Signed URL of an item's entry for its preview, or null for the format tile. */
  preview: (item: LibraryItem) => string | null;
}): Html {
  const { state, counts } = opts;
  const filtered = Boolean(state.format || state.agent);
  const shown = counts[state.tab];

  const tabs = html`<nav class="tabs" aria-label="Show">${LIBRARY_TABS.map(
    (tab) =>
      html`<a class="tab${tab === state.tab ? ' on' : ''}" href="${libraryHref(state, { tab })}"${current(tab === state.tab)}>${TAB_LABELS[tab]}<span class="n">${counts[tab]}</span></a>`,
  )}</nav>`;

  const formatMenu = menu(
    html`<span class="chip${state.format ? ' set' : ''}">${icon('filter')}Format${state.format ? html`<b>${FORMAT_LABELS[state.format]}</b>${icon('chev')}` : ''}</span>`,
    html`${menuItem(libraryHref(state, { format: undefined }), 'All formats', !state.format)}${FORMATS.map(
      (f) =>
        menuItem(
          libraryHref(state, { format: f }),
          html`${formatIcon(f)}${FORMAT_LABELS[f]}`,
          state.format === f,
        ),
    )}`,
    { label: 'Format' },
  );
  const agents = opts.shell.summary.agents;
  const agentMenu = menu(
    html`<span class="chip${state.agent ? ' set' : ''}">Agent${state.agent ? html`<b>${state.agent}</b>` : ''}${icon('chev')}</span>`,
    html`${menuItem(libraryHref(state, { agent: undefined }), 'All agents', !state.agent)}${agents.map(
      (a) =>
        menuItem(
          libraryHref(state, { agent: a.name }),
          html`<span class="label">${a.name}</span><span class="n">${a.count}</span>`,
          state.agent === a.name,
        ),
    )}`,
    { label: 'Agent' },
  );
  const sortMenu = menu(
    html`<span class="btn ghost">${state.sort === 'title' ? 'Title' : 'Last updated'}${icon('chev')}</span>`,
    html`${menuItem(libraryHref(state, { sort: 'updated' }), 'Last updated', state.sort === 'updated')}${menuItem(libraryHref(state, { sort: 'title' }), 'Title', state.sort === 'title')}`,
    { right: true, label: 'Sort' },
  );
  const viewToggle = html`<span class="seg" role="group" aria-label="View">
<a href="${libraryHref(state, { view: 'grid' }, true)}" aria-label="Grid" title="Grid"${state.view === 'grid' ? raw(' aria-current="true" class="on"') : ''}>${icon('grid')}</a><a href="${libraryHref(state, { view: 'list' }, true)}" aria-label="List" title="List"${state.view === 'list' ? raw(' aria-current="true" class="on"') : ''}>${icon('rows')}</a>
</span>`;

  const filters = html`<div class="filters">
${formatMenu}${agentMenu}
${filtered ? html`<a class="clear" href="${libraryHref(state, { format: undefined, agent: undefined })}">Clear filters</a>` : ''}
<span class="sp"></span>
${sortMenu}${viewToggle}
</div>`;

  const empty =
    counts.all === 0 && !filtered
      ? html`<div class="empty">${icon('plug', 'big')}<h2>No artifacts yet</h2>
<p class="muted"><a href="/connect">Connect an agent</a> and ask it to publish something.</p></div>`
      : html`<div class="empty">${icon('filter', 'big')}<h2>Nothing here</h2>
<p class="muted">No artifacts match${state.tab === 'all' ? '' : html` <strong>${TAB_LABELS[state.tab]}</strong>`}${state.format ? html` in <strong>${FORMAT_LABELS[state.format]}</strong>` : ''}${state.agent ? html` from <strong>${state.agent}</strong>` : ''}. <a href="/">Show everything</a></p></div>`;

  const items =
    opts.items.length === 0
      ? empty
      : state.view === 'grid'
        ? html`<div class="grid">${opts.items.map((item) => card(item, opts.preview(item)))}</div>`
        : html`<div class="list">${opts.items.map(row)}</div>`;

  const more = opts.nextCursor
    ? html`<p class="more"><a class="btn" href="${libraryHref(state, { cursor: opts.nextCursor })}">Load more</a></p>`
    : '';

  return appShell(opts.shell, {
    title: 'Library',
    body: html`<div class="h1row"><h1>Library</h1><span class="count">${plural(shown, 'artifact')}</span></div>
${tabs}
${filters}
${items}
${more}`,
  });
}

export function searchPage(opts: {
  shell: Shell;
  query: string;
  hits: SearchHit[];
  nextCursor: string | null;
  openComments: Record<string, number>;
}): Html {
  const moreHref = opts.nextCursor
    ? `/?${new URLSearchParams({ q: opts.query, cursor: opts.nextCursor })}`
    : null;

  const body =
    opts.hits.length === 0
      ? html`<div class="empty">${icon('search', 'big')}<h2>No results</h2><p class="muted">Nothing matches <strong>${opts.query}</strong>.</p></div>`
      : html`<div class="list">
${opts.hits.map(
  ({ artifact: a, snippet: text }) => html`<article class="row">
${formatIcon(a.format)}
<div class="row-main"><a class="ttl stretch" href="/a/${encodeURIComponent(a.id)}">${a.title}</a><div class="sub">${subline(a)}</div>
${text ? html`<p class="hit">${highlight(text)}</p>` : ''}</div>
<div class="row-pills">${commentsPill(opts.openComments[a.id] ?? 0)}${livePill(a)}</div>
<div class="sub row-agent">${FORMAT_LABELS[a.format]}</div>
<div class="sub t">${time(a.updatedAt)}</div>
</article>`,
)}
</div>
${moreHref ? html`<p class="more"><a class="btn" href="${moreHref}">More results</a></p>` : ''}`;

  return appShell(opts.shell, {
    title: `Search: ${opts.query}`,
    body: html`<div class="h1row"><h1>Search</h1><span class="count">Results for <strong>${opts.query}</strong> · <a href="/">Back to the library</a></span></div>
${body}`,
  });
}

// ---- Artifact page ----

export type PanelTab = 'versions' | 'comments' | 'share' | 'details';
export const PANEL_TABS: readonly PanelTab[] = ['versions', 'comments', 'share', 'details'];

export function artifactPage(opts: {
  user: string;
  name: string;
  theme: Theme;
  artifact: Artifact;
  version: Version;
  versions: Version[];
  threads: Thread[];
  url: (path: string) => string;
  shareLinks: ShareLink[];
  createdLink?: { url: string; link: ShareLink };
  /** The signed-in user, for the frame's runtime; only when the artifact declares `viewer`. */
  viewer?: { email: string; name: string } | null;
  panel: { tab: PanelTab; open: boolean };
  /** Shown once in the Details tab after a rename, or a refused one. */
  notice?: string;
}): Html {
  const { artifact: a, version: v } = opts;
  const id = encodeURIComponent(a.id);
  const isLatest = v.version === a.latestVersion;
  // The page's own URL, so tab links work on the URL a form posted to as well.
  const self = `/a/${id}${isLatest ? '' : `/v/${v.version}`}`;
  const tabHref = (tab: PanelTab | 'closed') => `${self}?panel=${tab}`;
  const entryUrl = opts.url(v.entry);
  const now = Date.now();
  const activeLinks = opts.shareLinks.filter(
    (l) => !l.expiresAt || Date.parse(l.expiresAt) > now,
  ).length;
  const shown = opts.threads.filter((t) => t.version <= v.version);
  const open = shown.filter((t) => !t.resolvedAt);
  const waiting = unanswered(open);

  const caps = a.capabilities;
  const declared = (['db', 'viewer'] as const).filter((k) => caps[k]);

  const versionMenu = html`<details class="menu vmenu"><summary class="vsel" aria-label="Version"><b>v${v.version}</b><span class="muted">· ${shortTime(v.createdAt)}</span>${icon('chev')}</summary>
<div class="menu-pop right">${opts.versions.map((x) =>
    menuItem(
      `/a/${id}${x.version === a.latestVersion ? '' : `/v/${x.version}`}`,
      html`<b>v${x.version}</b><span class="label">${x.publishedBy}</span><span class="n">${shortTime(x.createdAt)}</span>`,
      x.version === v.version,
    ),
  )}</div></details>`;

  const moreMenu = html`<details class="menu"><summary class="btn icon" aria-label="More">${icon('more')}</summary>
<div class="menu-pop right">
<a class="menu-item" href="${tabHref('details')}" data-tab-link="details">${icon('pencil')}Rename</a>
<form method="post" action="/a/${id}/delete" data-confirm="Move this artifact to the trash? It stays there for ${TRASH_DAYS} days."><button class="menu-item danger" type="submit">${icon('trash')}Move to trash</button></form>
</div></details>`;

  const tbar = html`<div class="tbar">
${formatIcon(v.format)}<h1 class="title">${a.title}</h1><span class="muted fmt">${FORMAT_LABELS[v.format]}</span>
${declared.length ? html`<a class="pill live" href="/docs/runtime" title="Live page: ${declared.join(', ')}">${icon('live')}Live</a>` : ''}
${activeLinks ? html`<a class="pill pub" href="${tabHref('share')}" data-tab-link="share">${icon('globe')}${plural(activeLinks, 'public link')}</a>` : ''}
<span class="sp"></span>
${versionMenu}
<a class="btn ghost raw" href="${entryUrl}" target="_blank" rel="noopener noreferrer">${icon('ext')}<span>Open raw</span></a>
<a class="btn primary" href="${tabHref('share')}" data-tab-link="share">${icon('share')}<span>Share</span></a>
${moreMenu}
<a class="btn icon" href="${tabHref(opts.panel.open ? 'closed' : opts.panel.tab)}" data-panel-toggle aria-controls="panel" aria-expanded="${String(opts.panel.open)}" aria-label="Side panel" title="Side panel">${icon('panel')}</a>
</div>`;

  const oldBar = isLatest
    ? ''
    : html`<div class="oldbar">${icon('restore')}<span>You are viewing <b>v${v.version}</b>; the latest is v${a.latestVersion}.</span>
<a class="btn sm" href="/a/${id}">View latest</a>
<form method="post" action="/a/${id}/v/${v.version}/restore"><button class="btn sm" type="submit">Restore this version</button></form></div>`;

  // Chrome refuses to render PDFs in sandboxed frames, so PDFs get none. Without allow-same-origin
  // the other formats run in an opaque origin; the content host is a separate origin either way.
  const sandbox = v.format === 'pdf' ? '' : html` sandbox="${SANDBOX}"`;
  // For app.js, which answers the frame's runtime calls for this artifact only.
  const runtime = html` data-artifact="${a.id}" data-capabilities="${JSON.stringify(caps)}"${
    opts.viewer ? html` data-viewer="${JSON.stringify(opts.viewer)}"` : ''
  }`;

  const tab = (name: PanelTab, label: string, badge?: number, asks?: number) => {
    const on = name === opts.panel.tab;
    return html`<a class="ptab${on ? ' on' : ''}" href="${tabHref(name)}" role="tab" id="tab-${name}" aria-controls="pane-${name}" aria-selected="${String(on)}" data-tab="${name}">${label}${badge ? html`<span class="n">${badge}</span>` : ''}${asks ? html`<span class="n ask" title="${plural(asks, 'ask')} waiting for your answer">${icon('ask')}${asks}</span>` : ''}</a>`;
  };
  const pane = (name: PanelTab, body: Html) =>
    html`<section class="pbody" id="pane-${name}" role="tabpanel" aria-labelledby="tab-${name}" data-pane="${name}"${name === opts.panel.tab ? '' : raw(' hidden')}>${body}</section>`;

  const panel = html`<aside class="panel" id="panel" aria-label="Artifact panel"${opts.panel.open ? '' : raw(' hidden')}>
<div class="ptabs" role="tablist">
${tab('versions', 'Versions')}${tab('comments', 'Comments', open.length, waiting)}${tab('share', 'Share')}${tab('details', 'Details')}
<span class="sp"></span>
<a class="btn ghost icon sm" href="${tabHref('closed')}" data-panel-close aria-label="Close panel">${icon('x')}</a>
</div>
${pane('versions', versionsPane(a, v, opts.versions))}
${pane('comments', commentsPane(a, v, opts.threads, opts.user, opts.name))}
${pane('share', sharePane(a, v, opts.shareLinks, opts.createdLink))}
${pane('details', detailsPane(a, v, opts.versions, opts.url, opts.notice))}
</aside>`;

  return htmlPage({
    title: a.title,
    theme: opts.theme,
    bodyClass: 'viewer-page',
    body: html`<div class="viewer">
${viewerTop(opts, self, '/', html`<b>${a.title}</b>`)}
${tbar}
${oldBar}
<div class="vbody${opts.panel.open ? '' : ' closed'}">
<div class="frame">
<iframe class="artifact" src="${entryUrl}" title="${a.title}"${sandbox}${runtime}></iframe>
<button type="button" class="sel" id="comment-on-selection" hidden>${icon('cmt')}Comment</button>
</div>
${panel}
</div>
</div>`,
  });
}

/** The artifact and compare pages' top bar: back, breadcrumbs, search and the account menu. */
function viewerTop(
  who: { user: string; name: string; theme: Theme },
  self: string,
  back: string,
  crumbs: Html,
): Html {
  return html`<header class="vtop">
<a class="btn ghost icon" href="${back}" aria-label="Back">${icon('back')}</a>
<nav class="crumbs" aria-label="Breadcrumbs"><a href="/"><span class="logo sm">${icon('lib')}</span>Library</a><span aria-hidden="true">/</span>${crumbs}</nav>
<span class="sp"></span>
${searchBox('', true)}
<details class="menu"><summary class="av-btn" aria-label="Account and theme"><span class="av sm">${initials(who.name)}</span></summary>
<div class="menu-pop right account"><div class="who-text"><span class="who-name">${who.name}</span><small>${who.user}</small></div>${themeSwitch(who.theme, self)}</div></details>
</header>`;
}

/** "+18 −4": lines added and removed. Nothing when they aren't known. */
function delta(added: number | null, removed: number | null, href?: string): Html | '' {
  if (added === null || removed === null) return '';
  const title = `${plural(added, 'line')} added, ${removed} removed`;
  const body = html`<span class="add">+${added}</span><span class="del">−${removed}</span>`;
  return href
    ? html`<a class="delta" href="${href}" title="${title}">${body}</a>`
    : html`<span class="delta" title="${title}">${body}</span>`;
}

/** The compare page's URL; the default mode is left out. */
export function compareHref(id: string, from: number, to: number, mode: CompareMode = 'changes') {
  return `/a/${encodeURIComponent(id)}/compare?from=${from}&to=${to}${mode === 'side' ? '&mode=side' : ''}`;
}

function versionsPane(a: Artifact, v: Version, versions: Version[]): Html {
  const id = encodeURIComponent(a.id);
  // Compare the version on screen with the one before it (v1: with v2).
  const to = v.version > 1 ? v.version : Math.min(2, a.latestVersion);
  const compare =
    versions.length > 1
      ? html`<a class="btn sm" href="${compareHref(a.id, to - 1, to)}">${icon('diff')}Compare</a>`
      : '';
  return html`<div class="phead"><span>${plural(versions.length, 'version')}</span>${compare}</div>
<ol class="timeline">
${versions.map((x) => {
  const latest = x.version === a.latestVersion;
  const viewing = x.version === v.version;
  const href = `/a/${id}${latest ? '' : `/v/${x.version}`}`;
  const changes = x.version > 1 ? compareHref(a.id, x.version - 1, x.version) : undefined;
  const [low, high] = x.version < v.version ? [x.version, v.version] : [v.version, x.version];
  return html`<li class="ver${latest ? ' cur' : ''}${viewing ? ' viewing' : ''}">
<div class="l1"><b>v${x.version}</b>${latest ? html`<span class="tag">Current</span>` : ''}${viewing && !latest ? html`<span class="tag soft">Viewing</span>` : ''}<span class="t">${time(x.createdAt)}</span></div>
<div class="by"><span class="dot"></span><span class="label">${x.publishedBy}</span>${x.files.length > 1 ? html`<span>· ${x.files.length} files</span>` : ''}${delta(x.linesAdded, x.linesRemoved, changes)}</div>
${
  viewing && latest
    ? ''
    : html`<div class="acts">${viewing ? '' : html`<a class="btn sm" href="${href}">${icon('eye')}View</a><a class="btn sm" href="${compareHref(a.id, low, high)}" title="Compare v${low} with v${high}">${icon('diff')}Compare</a>`}${latest ? '' : html`<form method="post" action="/a/${id}/v/${x.version}/restore"><button class="btn sm" type="submit">${icon('restore')}Restore</button></form>`}</div>`
}
</li>`;
})}
</ol>`;
}

/**
 * Threads started on this version or an earlier one, open ones first. Every form is a plain POST to
 * the app origin. Only open text threads carry data-exact: app.js asks the frame to highlight those.
 */
function commentsPane(a: Artifact, v: Version, threads: Thread[], user: string, name: string) {
  const shown = threads.filter((t) => t.version <= v.version);
  const open = shown.filter((t) => !t.resolvedAt);
  const resolved = shown.filter((t) => t.resolvedAt);
  const action = `/a/${encodeURIComponent(a.id)}/comments`;
  const version = html`<input type="hidden" name="version" value="${v.version}">`;

  const thread = (t: Thread) => {
    const quote = t.anchor.kind === 'text' ? t.anchor : null;
    const highlight =
      quote && !t.resolvedAt
        ? html` data-exact="${quote.exact}" data-prefix="${quote.prefix}" data-suffix="${quote.suffix}"`
        : '';
    const where = `${quote ? '' : 'on the whole page · '}v${t.version}`;
    return html`<article class="thread${t.resolvedAt ? ' done' : ''}" id="thread-${t.id}"${highlight}>
${quote ? html`<blockquote class="quote">${quote.exact}</blockquote>` : html`<p class="where">${where}</p>`}
<ol class="cmts">
${t.comments.map((c, i) => {
  const you = c.typed && c.author === user;
  return html`<li class="cmt"><span class="av${c.typed ? '' : ' bot'}" aria-hidden="true">${initials(you ? name : c.author)}</span><div class="cmt-body">
<div class="who2">${you ? name : c.author}${c.typed ? html`<span class="you">${you ? 'you' : 'typed'}</span>` : html`<span class="agent-tag">agent</span>`}<small>· ${i === 0 && quote ? `v${t.version} · ` : ''}${time(c.createdAt)}</small></div>
${c.ask && c.body === c.ask.question ? '' : html`<p class="text">${c.body}</p>`}
${c.ask ? askCard(a.id, v.version, t, c.id, c.ask, user) : ''}</div></li>`;
})}
</ol>
<form class="reply" method="post" action="${action}">
<input type="hidden" name="threadId" value="${t.id}">${version}
<textarea name="body" rows="2" required maxlength="${COMMENT_LIMITS.body}" placeholder="Reply…" aria-label="Reply"></textarea>
<div class="acts"><button class="btn sm" type="submit" data-reply>Reply</button>
<button class="btn sm" type="submit" formaction="${action}/${encodeURIComponent(t.id)}/resolve" formnovalidate name="resolved" value="${t.resolvedAt ? '0' : '1'}">${t.resolvedAt ? 'Reopen' : 'Resolve'}</button></div>
</form>
</article>`;
  };

  return html`<div class="phead"><span>${open.length} open · ${resolved.length} resolved</span></div>
${open.length === 0 ? html`<p class="note">No open comments. Select text in the page to comment on it.</p>` : open.map(thread)}
${resolved.length ? html`<details class="resolved"><summary>${plural(resolved.length, 'resolved thread')}</summary>${resolved.map(thread)}</details>` : ''}
<form method="post" action="${action}" id="new-comment" class="new-comment">
${version}
<input type="hidden" name="exact"><input type="hidden" name="prefix"><input type="hidden" name="suffix">
<div class="new-quote" id="new-quote" hidden><blockquote class="quote" id="new-quote-text"></blockquote>
<button type="button" class="btn ghost icon sm" id="new-quote-clear" aria-label="Remove quote" title="Remove quote">${icon('x')}</button></div>
<textarea class="box" name="body" rows="3" required maxlength="${COMMENT_LIMITS.body}" placeholder="Comment on v${v.version}, or select text in the page…" aria-label="Comment on version ${v.version}"></textarea>
<div class="form-end"><button class="btn primary sm" type="submit">Comment</button></div>
</form>`;
}

/** Asks without an answer in these threads (pass the open ones). */
const unanswered = (threads: Thread[]) =>
  threads.reduce((n, t) => n + t.comments.filter((c) => c.ask && !c.ask.answer).length, 0);

/**
 * An agent's question as a card: each option is a submit button of one form, which the server
 * checks against the ask. The question, labels, details and the why are agent text: escaped like
 * any comment. Answers can change until the thread is resolved.
 */
function askCard(
  artifactId: string,
  version: number,
  t: Thread,
  commentId: string,
  ask: Ask,
  user: string,
): Html {
  const closed = Boolean(t.resolvedAt);
  const answer = ask.answer;
  const action = `/a/${encodeURIComponent(artifactId)}/asks/${encodeURIComponent(commentId)}`;
  const status = answer
    ? html`<p class="ask-status done">${icon('check')}<span>Answered by ${answer.by === user ? 'you' : answer.by} · ${time(answer.at)}</span></p>`
    : html`<p class="ask-status">${closed ? 'Not answered before the thread was resolved' : 'Waiting for your answer'}</p>`;
  const option = (o: AskOption) => {
    const rec = ask.recommended?.optionId === o.id ? ask.recommended : null;
    const on = answer?.optionId === o.id;
    return html`<button class="ask-opt${on ? ' on' : ''}${rec ? ' rec' : ''}" type="submit" name="optionId" value="${o.id}" aria-pressed="${String(on)}"${closed ? raw(' disabled') : ''}>
<span class="ask-l1"><span class="ask-label">${o.label}</span>${rec ? html`<span class="tag">Recommended</span>` : ''}${on ? icon('check') : ''}</span>
${o.detail ? html`<span class="ask-detail">${o.detail}</span>` : ''}
${rec ? html`<span class="ask-why">${rec.why}</span>` : ''}
</button>`;
  };
  return html`<div class="ask${answer ? ' answered' : ''}" id="ask-${commentId}">
<p class="ask-q">${icon('ask')}<span>${ask.question}</span></p>
<form method="post" action="${action}" class="ask-opts">
<input type="hidden" name="version" value="${version}">
${ask.options.map(option)}
</form>
${status}
</div>`;
}

const EXPIRY_CHOICES: [string, string][] = [
  ['', 'Never'],
  ['1', 'In 1 day'],
  ['7', 'In 7 days'],
  ['30', 'In 30 days'],
  ['90', 'In 90 days'],
];

function sharePane(
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

  const describe = (l: ShareLink) => {
    const expired = l.expiresAt !== null && Date.parse(l.expiresAt) <= Date.now();
    const shows =
      l.version === null
        ? 'Latest version'
        : html`Pinned to <a href="${base}/v/${l.version}">v${l.version}</a>`;
    const expires = !l.expiresAt
      ? 'never expires'
      : expired
        ? html`expired <time datetime="${l.expiresAt}" title="${l.expiresAt}">${shortDate(l.expiresAt)}</time>`
        : html`expires <time datetime="${l.expiresAt}" title="${l.expiresAt}">${shortDate(l.expiresAt)}</time>`;
    const used = l.lastUsedAt ? html`opened ${time(l.lastUsedAt)}` : 'never opened';
    return html`<li class="link${expired ? ' expired' : ''}">
<div class="l1">${icon('globe')}<span class="label">${l.label || 'Public link'}</span>${expired ? html`<span class="badge">expired</span>` : ''}
<form method="post" action="${base}/share/${encodeURIComponent(l.id)}/revoke" data-confirm="Revoke this link? Anyone using it loses access."><button class="btn sm" type="submit">Revoke</button></form></div>
<small>${shows} · ${expires} · ${used} · created ${time(l.createdAt)}</small>
</li>`;
  };

  return html`${notice}<div class="phead"><span>Public links</span></div>
<p class="note">Anyone with a public link can open this artifact without signing in, until you revoke it. Comments and live data stay private.</p>
<form method="post" action="${base}/share" class="share-form">
<label class="field"><span>Shows</span><select class="input" name="version">
<option value="latest">Always the latest version</option>
<option value="${v.version}">Only version ${v.version}</option>
</select></label>
<label class="field"><span>Expires</span><select class="input" name="expires">
${EXPIRY_CHOICES.map(([value, label]) => html`<option value="${value}">${label}</option>`)}
</select></label>
<label class="field"><span>Label (optional)</span><input class="input" type="text" name="label" placeholder="e.g. for Sam" maxlength="100"></label>
<button class="btn primary wide" type="submit">${icon('globe')}Create public link</button>
</form>
${links.length === 0 ? html`<p class="note">No public links.</p>` : html`<ul class="links">${links.map(describe)}</ul>`}`;
}

function detailsPane(
  a: Artifact,
  v: Version,
  versions: Version[],
  url: (path: string) => string,
  notice?: string,
): Html {
  const id = encodeURIComponent(a.id);
  const first = versions.at(-1);
  const caps = (['db', 'viewer'] as const).filter((k) => a.capabilities[k]);
  return html`${notice ? html`<div class="notice">${notice}</div>` : ''}<dl class="details">
<dt>Format</dt><dd>${FORMAT_LABELS[v.format]}</dd>
<dt>Entry</dt><dd class="mono">${v.entry}</dd>
${
  v.files.length > 1
    ? html`<dt>Files</dt><dd><ul class="files">${v.files.map(
        (f) =>
          html`<li><a href="${url(f.path)}" target="_blank" rel="noopener noreferrer">${f.path}</a><span class="muted">${size(f.size)}</span></li>`,
      )}</ul></dd>`
    : html`<dt>Size</dt><dd>${size(v.files[0]?.size ?? 0)}</dd>`
}
<dt>Created</dt><dd>${time(a.createdAt)}${first ? html` by ${first.publishedBy}` : ''}</dd>
<dt>Updated</dt><dd>${time(a.updatedAt)}</dd>
<dt>Live data</dt><dd>${caps.length ? html`On: ${caps.join(', ')} · <a href="/docs/runtime">docs</a>` : 'Off'}</dd>
<dt>ID</dt><dd class="mono">${a.id}</dd>
</dl>
<form method="post" action="/a/${id}/settings" class="rename" id="rename">
<div class="phead"><span>Rename</span></div>
<label class="field"><span>Title</span><input class="input" type="text" name="title" value="${a.title}" required maxlength="200"></label>
<label class="field"><span>Description</span><textarea class="input" name="description" rows="3" maxlength="2000">${a.description}</textarea></label>
<input type="hidden" name="version" value="${v.version}">
<div class="form-end"><button class="btn sm" type="submit">Save</button></div>
</form>
<div class="danger-zone">
<form method="post" action="/a/${id}/delete" data-confirm="Move this artifact to the trash? It stays there for ${TRASH_DAYS} days."><button class="btn sm danger" type="submit">${icon('trash')}Move to trash</button></form>
<span class="muted">Kept in the trash for ${TRASH_DAYS} days.</span>
</div>`;
}

// ---- Compare page ----

export type CompareMode = 'changes' | 'side';

const STATUS_LABELS: Record<FileChange['status'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  renamed: 'Renamed',
};

const fileName = (f: FileChange) => (f.oldPath ? `${f.oldPath} → ${f.path}` : f.path);

/** "⋯ 12 unchanged lines" between hunks. */
const gapRow = (lines: number) =>
  lines > 0
    ? html`<tr class="gap"><td class="ln" colspan="2">⋯</td><td class="code">${plural(lines, 'unchanged line')}</td></tr>`
    : '';

/** A hunk as table rows with old and new line numbers. The text is untrusted: html`` escapes it. */
function hunkRows(hunk: DiffHunk, gap: number): Html {
  let old = hunk.oldStart;
  let now = hunk.newStart;
  const rows = hunk.lines.map((line) => {
    const text = line.slice(1);
    switch (line[0]) {
      case '+':
        return html`<tr class="add"><td class="ln"></td><td class="ln">${now++}</td><td class="code">${text}</td></tr>`;
      case '-':
        return html`<tr class="del"><td class="ln">${old++}</td><td class="ln"></td><td class="code">${text}</td></tr>`;
      case '\\':
        return html`<tr class="eof"><td class="ln" colspan="2"></td><td class="code">No newline at end of file</td></tr>`;
      default:
        return html`<tr><td class="ln">${old++}</td><td class="ln">${now++}</td><td class="code">${text}</td></tr>`;
    }
  });
  return html`${gapRow(gap)}${rows}`;
}

function fileDiff(f: FileChange, index: number): Html {
  let end = 1;
  const rows = f.hunks.map((hunk) => {
    const gap = Math.max(0, hunk.oldStart - end);
    end = hunk.oldStart + hunk.oldLines;
    return hunkRows(hunk, gap);
  });
  const note =
    f.diff === 'binary'
      ? 'Binary file: not compared.'
      : f.diff === 'too_large'
        ? 'Too many changes to show.'
        : f.truncated
          ? `${f.hunks.length ? 'The rest of this diff is' : 'This diff is'} not shown: a comparison stops at ${COMPARE_LIMITS.diffBytes / 1024} KB.`
          : f.hunks.length === 0
            ? 'Same content.'
            : '';
  return html`<section class="dfile" id="file-${index + 1}">
<header class="dhead"><span class="path mono">${fileName(f)}</span><span class="tag ${f.status}">${STATUS_LABELS[f.status]}</span><span class="sp"></span>${delta(f.linesAdded, f.linesRemoved)}</header>
${rows.length ? html`<div class="dbody"><table class="diff"><tbody>${rows}</tbody></table></div>` : ''}
${note ? html`<p class="note">${note}</p>` : ''}
</section>`;
}

function changesView(c: Comparison): Html {
  if (c.files.length === 0) {
    return html`<div class="empty">${icon('diff', 'big')}<h2>No changes</h2><p class="muted">v${c.from.version} and v${c.to.version} have the same files.</p></div>`;
  }
  const multi = c.from.files.length > 1 || c.to.files.length > 1;
  const summary = html`<div class="cmp-sum"><b>v${c.from.version}</b><span class="muted">→</span><b>v${c.to.version}</b>${delta(c.linesAdded, c.linesRemoved)}<span class="muted">· ${plural(c.files.length, 'file')} changed${multi ? ` · ${c.unchanged} unchanged` : ''}</span></div>`;
  const list = multi
    ? html`<ul class="cfiles">${c.files.map(
        (f, i) =>
          html`<li><a href="#file-${i + 1}"><span class="tag ${f.status}">${STATUS_LABELS[f.status]}</span><span class="path mono">${fileName(f)}</span></a>${delta(f.linesAdded, f.linesRemoved)}</li>`,
      )}</ul>`
    : '';
  const cut = c.truncated
    ? html`<div class="notice warn">This comparison is longer than ${COMPARE_LIMITS.diffBytes / 1024} KB, so only its start is shown.</div>`
    : '';
  return html`${summary}${cut}${list}${c.files.map(fileDiff)}`;
}

export function comparePage(opts: {
  user: string;
  name: string;
  theme: Theme;
  comparison: Comparison;
  versions: Version[];
  mode: CompareMode;
  /** Signed content URL of a file of a version. */
  url: (version: number, path: string) => string;
}): Html {
  const c = opts.comparison;
  const a = c.artifact;
  const id = encodeURIComponent(a.id);
  const self = compareHref(a.id, c.from.version, c.to.version, opts.mode);
  const versionHref = (n: number) => `/a/${id}${n === a.latestVersion ? '' : `/v/${n}`}`;

  const select = (name: 'from' | 'to', chosen: number) =>
    html`<select class="input vpick" name="${name}" aria-label="${name === 'from' ? 'Compare from version' : 'To version'}">${opts.versions.map(
      (x) =>
        html`<option value="${x.version}"${x.version === chosen ? raw(' selected') : ''}>v${x.version} · ${shortTime(x.createdAt)}</option>`,
    )}</select>`;
  const picker = html`<form class="cmp-pick" method="get" action="/a/${id}/compare" data-autosubmit>
${select('from', c.from.version)}<span class="muted" aria-hidden="true">→</span>${select('to', c.to.version)}
${opts.mode === 'side' ? html`<input type="hidden" name="mode" value="side">` : ''}
<button class="btn sm go" type="submit">Compare</button>
</form>`;
  const modeLink = (mode: CompareMode, label: string) => {
    const on = mode === opts.mode;
    return html`<a href="${compareHref(a.id, c.from.version, c.to.version, mode)}"${on ? raw(' aria-current="true" class="on"') : ''}>${label}</a>`;
  };

  const tbar = html`<div class="tbar">
${formatIcon(c.to.format)}<h1 class="title">${a.title}</h1><span class="muted fmt">Compare versions</span>
<span class="sp"></span>
${picker}
<span class="seg text" role="group" aria-label="Show">${modeLink('changes', 'Changes')}${modeLink('side', 'Side by side')}</span>
</div>`;

  // The same sandbox as the artifact page; these frames get no runtime port.
  const half = (v: Version) =>
    html`<div class="half">
<div class="half-head"><b>v${v.version}</b><span class="muted">· ${time(v.createdAt)} · ${v.publishedBy}</span><span class="sp"></span><a class="btn ghost sm" href="${versionHref(v.version)}">${icon('eye')}View</a></div>
<div class="frame"><iframe class="cmp-frame" src="${opts.url(v.version, v.entry)}" title="${a.title}, v${v.version}"${v.format === 'pdf' ? '' : html` sandbox="${SANDBOX}"`}></iframe></div>
</div>`;

  const body =
    opts.mode === 'side'
      ? html`<div class="split">${half(c.from)}${half(c.to)}</div>`
      : html`<div class="cmp"><div class="cmp-in">${changesView(c)}</div></div>`;

  return htmlPage({
    title: `Compare v${c.from.version} and v${c.to.version} · ${a.title}`,
    theme: opts.theme,
    bodyClass: 'viewer-page',
    body: html`<div class="viewer">
${viewerTop(opts, self, `/a/${id}`, html`<a href="/a/${id}">${a.title}</a><span aria-hidden="true">/</span><b>Compare</b>`)}
${tbar}
${body}
</div>`,
  });
}

// ---- Other pages ----

export function trashPage(opts: { shell: Shell; items: DeletedArtifact[] }): Html {
  const body =
    opts.items.length === 0
      ? html`<div class="empty">${icon('trash', 'big')}<h2>The trash is empty</h2></div>`
      : html`<div class="list">
${opts.items.map(
  (a) => html`<article class="row trash-row">
${formatIcon(a.format)}
<div class="row-main"><span class="ttl">${a.title}</span><div class="sub">${FORMAT_LABELS[a.format]} · v${a.latestVersion}</div></div>
<div class="sub">deleted ${time(a.deletedAt)}</div>
<form method="post" action="/trash/${encodeURIComponent(a.id)}/restore"><button class="btn sm" type="submit">${icon('restore')}Restore</button></form>
</article>`,
)}
</div>`;

  return appShell(opts.shell, {
    title: 'Trash',
    body: html`<div class="h1row"><h1>Trash</h1><span class="count">${plural(opts.items.length, 'artifact')}</span></div>
<p class="lead">Deleted artifacts are kept for ${TRASH_DAYS} days, then deleted for good.</p>
${body}`,
  });
}

export function connectionsPage(opts: {
  shell: Shell;
  grants: OAuthGrant[];
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

  const grants =
    opts.grants.length === 0
      ? html`<div class="empty">${icon('plug', 'big')}<h2>No apps signed in</h2><p class="muted">Agents that support OAuth sign in from the app: see <a href="/connect">Connect an agent</a>.</p></div>`
      : html`<div class="list">
${opts.grants.map(
  (g) => html`<article class="row token-row">
${icon('plug')}
<div class="row-main"><span class="ttl">${g.clientName}</span><div class="sub">signed in ${time(g.createdAt)} as ${g.user}</div></div>
<div class="sub">${g.lastUsedAt ? html`used ${time(g.lastUsedAt)}` : 'never used'}</div>
<form method="post" action="/settings/connections/${encodeURIComponent(g.id)}/revoke" data-confirm="Revoke this sign-in? ${g.clientName} loses access until it signs in again."><button class="btn sm danger" type="submit">Revoke</button></form>
</article>`,
)}
</div>`;

  const rows =
    opts.tokens.length === 0
      ? html`<div class="empty">${icon('key', 'big')}<h2>No tokens yet</h2><p class="muted">For agents without OAuth: create one per agent or machine.</p></div>`
      : html`<div class="list">
${opts.tokens.map(
  (t) => html`<article class="row token-row">
${icon('key')}
<div class="row-main"><span class="ttl">${t.name}</span><div class="sub">created ${time(t.createdAt)}</div></div>
<div class="sub">${t.lastUsedAt ? html`used ${time(t.lastUsedAt)}` : 'never used'}</div>
<form method="post" action="/settings/tokens/${encodeURIComponent(t.id)}/revoke" data-confirm="Revoke this token? Agents using it lose access."><button class="btn sm danger" type="submit">Revoke</button></form>
</article>`,
)}
</div>`;

  return appShell(opts.shell, {
    title: 'Connections',
    body: html`<div class="h1row"><h1>Connections</h1></div>
<p class="lead">Agents publish over MCP. Apps that support OAuth sign in through this site; the others use a personal access token. See <a href="/connect">Connect an agent</a>.</p>
<div class="h1row section"><h2>Signed-in apps</h2><span class="count">${plural(opts.grants.length, 'app')}</span></div>
${grants}
<div class="h1row section"><h2>Personal access tokens</h2><span class="count">${plural(opts.tokens.length, 'token')}</span></div>
${created}
${opts.error ? html`<div class="notice error">${opts.error}</div>` : ''}
<form method="post" action="/settings/tokens" class="inline-form">
<input class="input" type="text" name="name" placeholder="Name, e.g. laptop-claude-code" required maxlength="100" aria-label="Token name">
<button class="btn primary" type="submit">${icon('plus')}Create token</button>
</form>
${rows}`,
  });
}

/** Where the consent sends the browser back to, in words. */
function redirectTarget(uri: string): { host: string; local: boolean } {
  const url = new URL(uri);
  return { host: url.host, local: isLoopback(uri) };
}

/**
 * The OAuth consent page: who asks, where the answer goes, and Allow or Deny. The hidden fields
 * repeat the request; the POST checks all of it again.
 */
export function consentPage(opts: {
  theme: Theme;
  user: string;
  name: string;
  request: AuthorizeRequest;
  /** The request's own parameters, posted back as they came. */
  params: AuthorizeParams;
}): Html {
  const { request, params } = opts;
  const target = redirectTarget(request.redirectUri);
  const hidden = Object.entries(params).map(([key, value]) =>
    value === undefined ? '' : html`<input type="hidden" name="${key}" value="${value}">`,
  );
  return htmlPage({
    title: `Connect ${request.client.name}`,
    theme: opts.theme,
    bodyClass: 'bare',
    body: html`<main class="message consent">
<a class="brand" href="/"><span class="logo">${icon('lib')}</span>Agent Artifacts</a>
<div class="message-card">
<span class="consent-icon" aria-hidden="true">${icon('plug', 'consent-ic')}</span>
<h1>Connect ${request.client.name}?</h1>
<p class="muted">It will be able to publish, read, change and delete your artifacts, comments and live page data over MCP.</p>
<dl class="details consent-details">
<dt>App</dt><dd><b>${request.client.name}</b> <span class="badge">named by the app itself</span></dd>
<dt>Returns to</dt><dd><span class="mono">${target.host}</span>${target.local ? html` <span class="muted">· an app on this computer</span>` : ''}</dd>
<dt>Signed in as</dt><dd>${opts.name === opts.user ? opts.user : html`${opts.name} <span class="muted">· ${opts.user}</span>`}</dd>
</dl>
${target.local ? '' : html`<div class="notice warn"><p>After you allow it, your browser goes to <b>${target.host}</b>. Only allow this if you know that site.</p></div>`}
<form method="post" action="/oauth/authorize" class="consent-form">
${hidden}
<button class="btn" type="submit" name="decision" value="deny">Deny</button>
<button class="btn primary" type="submit" name="decision" value="allow">Allow</button>
</form>
<p class="note">Only allow this if you just started connecting this app. You can revoke it any time under <a href="/settings/connections">Connections</a>.</p>
</div>
</main>`,
  });
}

export function connectPage(opts: { shell: Shell; appOrigin: string }): Html {
  const mcpUrl = `${opts.appOrigin}/mcp`;
  const claude = `claude mcp add --transport http -s user agent-artifacts ${mcpUrl}`;
  const opencode = `opencode mcp add agent-artifacts --global --url ${mcpUrl}\nopencode mcp auth agent-artifacts`;
  const codex = `codex mcp add agent-artifacts --url ${mcpUrl}\ncodex mcp login agent-artifacts`;
  const generic = JSON.stringify(
    { mcpServers: { 'agent-artifacts': { type: 'http', url: mcpUrl } } },
    null,
    2,
  );
  const claudeToken = `claude mcp add --transport http -s user agent-artifacts ${mcpUrl} --header "Authorization: Bearer <TOKEN>"`;
  const opencodeToken = JSON.stringify(
    {
      mcp: {
        servers: {
          'agent-artifacts': {
            type: 'remote',
            url: mcpUrl,
            oauth: false,
            headers: { Authorization: 'Bearer {env:AGENT_ARTIFACTS_TOKEN}' },
          },
        },
      },
    },
    null,
    2,
  );
  const genericToken = JSON.stringify(
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

  return appShell(opts.shell, {
    title: 'Connect',
    body: html`<div class="prose">
<div class="h1row"><h1>Connect an agent</h1></div>
<p class="lead">Agents publish over MCP (streamable HTTP). Add the MCP URL to your agent and sign in: it opens this site in your browser, where you allow it. Signed-in apps are listed under <a href="/settings/connections">Connections</a>, where you can revoke them.</p>
<h2>MCP URL</h2>
${snippet('mcp-url', mcpUrl)}
<h2>Claude Code</h2>
${snippet('claude', claude)}
<p class="muted">Then run <code>/mcp</code> in Claude Code, pick <b>agent-artifacts</b> and choose Authenticate.</p>
<h2>OpenCode</h2>
${snippet('opencode', opencode)}
<p class="muted">Or run <code>/mcps</code> in OpenCode, select <b>agent-artifacts</b> and sign in.</p>
<h2>Codex</h2>
${snippet('codex', codex)}
<h2>Other MCP clients</h2>
<p class="muted">Any client that supports MCP authorization (OAuth 2.1 with dynamic client registration) finds the sign-in by itself:</p>
${snippet('generic', generic)}
<h2>With a token instead</h2>
<p>For a client without OAuth, <a href="/settings/connections">create a personal access token</a> and use it in place of <code>&lt;TOKEN&gt;</code>.</p>
<p class="muted">Claude Code:</p>
${snippet('claude-token', claudeToken)}
<p class="muted">OpenCode, in <code>opencode.jsonc</code>, with the token in the <code>AGENT_ARTIFACTS_TOKEN</code> environment variable:</p>
${snippet('opencode-token', opencodeToken)}
<p class="muted">Other MCP clients:</p>
${snippet('generic-token', genericToken)}
<h2>Live pages</h2>
<p>HTML artifacts can keep data, such as poll votes or a checklist: see <a href="/docs/runtime">the runtime</a>.</p>
</div>`,
  });
}
