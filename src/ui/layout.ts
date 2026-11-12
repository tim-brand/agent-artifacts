import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { html, raw } from 'hono/html';
import type { LibrarySummary } from '../contracts.ts';

export type Html = ReturnType<typeof html>;

const read = (path: string) => readFileSync(new URL(`./static/${path}`, import.meta.url));
const version = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 12);

/**
 * The UI's static files, served from 'self' at /static/<name>. The CSS and the script are linked
 * with a hash of their content in the URL, so they can be cached for good. The fonts are Geist and
 * Geist Mono (SIL Open Font License 1.1, see static/fonts/OFL.txt); their files never change.
 */
export const STATIC: ReadonlyMap<string, { body: Uint8Array; type: string }> = new Map([
  ['app.js', { body: read('app.js'), type: 'text/javascript; charset=utf-8' }],
  ['app.css', { body: read('app.css'), type: 'text/css; charset=utf-8' }],
  ['icon.svg', { body: read('icon.svg'), type: 'image/svg+xml' }],
  ['fonts/Geist-Variable.woff2', { body: read('fonts/Geist-Variable.woff2'), type: 'font/woff2' }],
  [
    'fonts/GeistMono-Variable.woff2',
    { body: read('fonts/GeistMono-Variable.woff2'), type: 'font/woff2' },
  ],
]);

const asset = (name: string) => {
  const file = STATIC.get(name);
  if (!file) throw new Error(`No static file ${name}`);
  return `/static/${name}?v=${version(file.body)}`;
};
const APP_JS_URL = asset('app.js');
const APP_CSS_URL = asset('app.css');
const ICON_URL = asset('icon.svg');
const FONT_URL = '/static/fonts/Geist-Variable.woff2';

/**
 * No inline script or style at all: everything comes from 'self'. `formTargets` widens form-action
 * for the consent page, whose form redirects to the OAuth client (browsers check redirects too).
 */
export function contentSecurityPolicy(contentOrigin: string, formTargets: string[] = []): string {
  return [
    "default-src 'self'",
    `frame-src ${contentOrigin}`,
    "img-src 'self' data:",
    "style-src 'self'",
    "font-src 'self'",
    "script-src 'self'",
    ["form-action 'self'", ...formTargets].join(' '),
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** The reader's choice; 'system' follows prefers-color-scheme. */
export type Theme = 'light' | 'dark' | 'system';
export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

export type Nav = 'library' | 'asks' | 'trash' | 'connections' | 'connect' | 'docs' | null;

/** What every page of the app shell needs. */
export type Shell = {
  user: string;
  /** The display name: the name header, else the email. */
  name: string;
  theme: Theme;
  summary: LibrarySummary;
  /** This page's path and query, for the theme form to come back to. */
  path: string;
  nav: Nav;
  /** The library's agent filter, to mark it in the sidebar. */
  agent?: string;
  /** The search box's value. */
  query?: string;
};

// Icons: 16×16 strokes, used as <svg class="ic"><use href="#i-…"/></svg>.
const ICONS: Record<string, string> = {
  lib: '<path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"/>',
  trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 7v4M9.5 7v4"/>',
  key: '<path d="M10 2.5a3.5 3.5 0 1 1-3.3 4.7L2.5 11.4v2h2v-1.5H6v-1.5h1.5l.4-.4"/>',
  plug: '<path d="M6 1.5v3M10 1.5v3M4 4.5h8v3a4 4 0 0 1-8 0zM8 11.5v3"/>',
  book: '<path d="M2.5 3h4a1.5 1.5 0 0 1 1.5 1.5V13a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3h-4A1.5 1.5 0 0 0 8 4.5V13a1.5 1.5 0 0 1 1.5-1.5h4z"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  html: '<path d="M5 4.5 1.5 8 5 11.5M11 4.5 14.5 8 11 11.5"/>',
  markdown: '<path d="M2 3.5h12v9H2zM4.5 10V6l1.75 2L8 6v4M10.5 6v4M9.2 8.7l1.3 1.3 1.3-1.3"/>',
  code: '<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5zM9.5 1.5V5H13M6.5 8 5 9.5 6.5 11M9.5 8 11 9.5 9.5 11"/>',
  image: '<path d="M2 3h12v10H2zM2 11l3.5-3.5 3 3 2-2L14 12"/><circle cx="10.5" cy="6" r="1"/>',
  pdf: '<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5zM9.5 1.5V5H13M5.5 10h5M5.5 12h3"/>',
  live: '<circle cx="8" cy="8" r="2"/><path d="M4.5 4.5a5 5 0 0 0 0 7M11.5 4.5a5 5 0 0 1 0 7"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
  cmt: '<path d="M2.5 3h11v7.5h-6l-3 2.5v-2.5h-2z"/>',
  ask: '<circle cx="8" cy="8" r="6"/><path d="M6.25 6.25a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.75.6-.75 1.15v.25M8 11.5h.01"/>',
  check: '<path d="m3 8.5 3 3 7-7"/>',
  back: '<path d="M10 3 5 8l5 5"/>',
  chev: '<path d="m4.5 6 3.5 3.5L11.5 6"/>',
  ext: '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4"/>',
  share: '<path d="M8 10V2.5M5 5.5l3-3 3 3M3 9v4.5h10V9"/>',
  more: '<path d="M3.5 8h.01M8 8h.01M12.5 8h.01"/>',
  panel: '<path d="M2 3h12v10H2zM10 3v10"/>',
  grid: '<path d="M2.5 2.5h4.5V7H2.5zM9 2.5h4.5V7H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z"/>',
  rows: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  filter: '<path d="M2.5 4h11M4.5 8h7M6.5 12h3"/>',
  copy: '<path d="M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3"/>',
  sun: '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  moon: '<path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/>',
  monitor: '<path d="M2 3h12v8H2zM6 14h4M8 11v3"/>',
  menu: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  restore: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  pencil: '<path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5v-3zM9 4l3 3"/>',
  diff: '<path d="M8 2.5v6M5 5.5h6M5 12.5h6"/>',
};

const SPRITE = raw(
  `<svg class="sprite" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">${Object.entries(ICONS)
    .map(([name, d]) => `<symbol id="i-${name}" viewBox="0 0 16 16">${d}</symbol>`)
    .join('')}</svg>`,
);

/** An icon from the sprite. */
export const icon = (name: keyof typeof ICONS | string, cls = '') =>
  html`<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

/** Two letters for an avatar: of a name's first two words, or of an email's local part. */
export function initials(name: string): string {
  const base = name.includes('@') ? (name.split('@')[0] ?? name) : name;
  const firsts = base
    .split(/[\s._-]+/)
    .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0])
    .filter((c) => c !== undefined);
  const letters =
    firsts.length >= 2
      ? `${firsts[0]}${firsts[1]}`
      : [...base.replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 2).join('');
  return letters.toUpperCase() || '?';
}

/** The whole document. Without an explicit theme, the CSS follows prefers-color-scheme. */
export function htmlPage(opts: {
  title: string;
  theme: Theme;
  body: Html;
  bodyClass?: string;
}): Html {
  const theme = opts.theme === 'system' ? '' : raw(` data-theme="${opts.theme}"`);
  return html`<!doctype html>
<html lang="en"${theme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${opts.title} · Agent Artifacts</title>
<link rel="preload" href="${FONT_URL}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${APP_CSS_URL}">
<link rel="icon" href="${ICON_URL}" type="image/svg+xml">
<script src="${APP_JS_URL}" defer></script>
</head>
<body${opts.bodyClass ? html` class="${opts.bodyClass}"` : ''}>
${SPRITE}
${opts.body}
</body>
</html>`;
}

const THEME_LABELS: Record<Theme, [string, string]> = {
  light: ['Light', 'sun'],
  dark: ['Dark', 'moon'],
  system: ['System', 'monitor'],
};

/** Light / Dark / System. A plain form; app.js switches without a reload. */
export const themeSwitch = (theme: Theme, back: string) =>
  html`<form class="theme" method="post" action="/settings/theme" data-theme-form>
<input type="hidden" name="back" value="${back}">
<span class="theme-label">Theme</span>
<span class="seg" role="group" aria-label="Theme">${THEMES.map((t) => {
    const [label, name] = THEME_LABELS[t];
    return html`<button type="submit" name="theme" value="${t}" title="${label}" aria-label="${label}" aria-pressed="${String(theme === t)}">${icon(name)}</button>`;
  })}</span>
</form>`;

/** The search form; `/` focuses the first one on the page. */
export const searchBox = (query: string, small = false) =>
  html`<form class="search${small ? ' sm' : ''}" method="get" action="/" role="search">
${icon('search')}<input type="search" name="q" value="${query}" placeholder="${small ? 'Search' : 'Search titles and content'}" maxlength="200" aria-label="Search artifacts" data-search>
<kbd class="kbd">/</kbd>
</form>`;

/** The sidebar, the top bar and the page. */
export function appShell(shell: Shell, opts: { title: string; body: Html }): Html {
  const { summary } = shell;
  const nav = (
    href: string,
    label: string,
    name: string,
    on: boolean,
    count?: number,
    attention = false,
  ) =>
    html`<a class="nav${on ? ' on' : ''}" href="${href}"${on ? raw(' aria-current="page"') : ''}>${icon(name)}<span class="label">${label}</span>${count === undefined ? '' : html`<span class="n${attention && count > 0 ? ' attn' : ''}">${count}</span>`}</a>`;
  const agents = summary.agents.map((a) => {
    const on = shell.nav === 'library' && shell.agent === a.name;
    return html`<a class="nav agent${on ? ' on' : ''}" href="/?${new URLSearchParams({ agent: a.name })}"${on ? raw(' aria-current="page"') : ''}><span class="dot"></span><span class="label">${a.name}</span><span class="n">${a.count}</span></a>`;
  });

  const body = html`<div class="shell">
<aside class="side" id="side">
<div class="side-head">
<a class="brand" href="/"><span class="logo">${icon('lib')}</span>Agent Artifacts</a>
<a class="btn ghost icon menu-btn" href="#side" aria-label="Menu" aria-controls="side-body" aria-expanded="false" data-menu>${icon('menu')}</a>
</div>
<div class="side-body" id="side-body">
<nav class="side-nav" aria-label="Main">
${nav('/', 'Library', 'lib', shell.nav === 'library' && !shell.agent, summary.total)}
${nav('/?tab=asks', 'Asks for you', 'ask', shell.nav === 'asks', summary.openAsks, true)}
${nav('/trash', 'Trash', 'trash', shell.nav === 'trash', summary.trash)}
${agents.length ? html`<div class="group">Agents</div>${agents}` : ''}
<div class="group">Settings</div>
${nav('/settings/connections', 'Connections', 'key', shell.nav === 'connections')}
${nav('/connect', 'Connect an agent', 'plug', shell.nav === 'connect')}
${nav('/docs/runtime', 'Live pages docs', 'book', shell.nav === 'docs')}
</nav>
<div class="who">
<div class="who-row"><span class="av" aria-hidden="true">${initials(shell.name)}</span><span class="who-text"><span class="who-name">${shell.name}</span><small>${shell.name === shell.user ? 'signed in' : shell.user}</small></span></div>
${themeSwitch(shell.theme, shell.path)}
</div>
</div>
</aside>
<div class="main">
<header class="top">${searchBox(shell.query ?? '')}</header>
<main class="page">
${opts.body}
</main>
</div>
</div>`;
  return htmlPage({ title: opts.title, theme: shell.theme, body });
}

/** 401, 403, 404, 500 and bad requests: no sidebar, so they need nothing from the database. */
export function messageDocument(opts: {
  theme: Theme;
  signedIn: boolean;
  title: string;
  message: string;
  status?: number;
}): Html {
  return htmlPage({
    title: opts.title,
    theme: opts.theme,
    bodyClass: 'bare',
    body: html`<main class="message">
<a class="brand" href="/"><span class="logo">${icon('lib')}</span>Agent Artifacts</a>
<div class="message-card">
${opts.status ? html`<p class="status">${opts.status}</p>` : ''}
<h1>${opts.title}</h1>
<p class="muted">${opts.message}</p>
${opts.signedIn ? html`<p><a class="btn" href="/">${icon('back')}Back to the library</a></p>` : ''}
</div>
</main>`,
  });
}
