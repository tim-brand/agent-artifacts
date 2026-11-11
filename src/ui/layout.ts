import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { html, raw } from 'hono/html';

export type Html = ReturnType<typeof html>;

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e4e4e4;--soft:#f5f5f5;--accent:#2563eb;--danger:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--muted:#9a9a9a;--line:#2c2c2c;--soft:#1f1f1f;--accent:#6ea0ff;--danger:#ef6b6b}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:1.25rem;padding:.6rem 1.25rem;border-bottom:1px solid var(--line);flex-wrap:wrap}
header .brand{font-weight:600;color:var(--fg)}
header nav{display:flex;gap:1rem;flex:1}
header nav a{color:var(--muted)}header nav a[aria-current=page]{color:var(--fg);font-weight:500}
header .user{color:var(--muted);font-size:.85rem}
main{flex:1;display:flex;flex-direction:column;width:100%;max-width:60rem;margin:0 auto;padding:1.25rem}
main.wide{max-width:none}
h1{font-size:1.4rem;margin:0 0 .5rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem}
p{margin:.4rem 0}
.muted{color:var(--muted)}
.badge{display:inline-block;padding:0 .45rem;border-radius:999px;font-size:.75rem;border:1px solid var(--line);background:var(--soft);color:var(--muted);white-space:nowrap}
.chips{display:flex;gap:.4rem;flex-wrap:wrap;margin:.5rem 0 1rem}
.chips a{padding:.15rem .7rem;border:1px solid var(--line);border-radius:999px;color:var(--fg);font-size:.85rem}
.chips a[aria-current=page]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
ul.list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
ul.list li{display:flex;gap:.75rem;align-items:baseline;padding:.6rem 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
ul.list .title{flex:1;min-width:12rem;font-weight:500}
ul.list .meta{color:var(--muted);font-size:.85rem}
ul.list .hit{flex-basis:100%;margin:0;color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
mark{background:#fde68a;color:#1a1a1a;border-radius:2px}
form.search{display:flex;gap:.5rem;margin:.5rem 0}form.search input{flex:1;min-width:0}
.empty{padding:2rem;text-align:center;border:1px dashed var(--line);border-radius:8px}
.more{margin-top:1rem}
.bar{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;margin:.25rem 0 .75rem}
.desc{white-space:pre-wrap;color:var(--muted);margin:0 0 .5rem}
details.menu{position:relative}
details.menu summary{cursor:pointer;padding:.2rem .6rem;border:1px solid var(--line);border-radius:6px;list-style:none}
details.menu ul{position:absolute;z-index:1;margin:.25rem 0 0;padding:.25rem 0;list-style:none;background:var(--bg);border:1px solid var(--line);border-radius:6px;min-width:18rem;max-height:60vh;overflow:auto}
details.menu li a{display:block;padding:.3rem .75rem;color:var(--fg)}
details.menu li a[aria-current=page]{background:var(--soft);font-weight:500}
details.files{margin:0 0 .75rem}details.files ul{margin:.25rem 0;padding-left:1.25rem}
details.share{margin:0 0 .75rem}details.share summary{cursor:pointer}
iframe.artifact{flex:1 1 auto;width:100%;min-height:24rem;border:1px solid var(--line);border-radius:6px;background:#fff}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500;font-size:.85rem}
form.inline{display:inline}
input[type=text],input[type=search],select{font:inherit;padding:.35rem .5rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);min-width:16rem}
button{font:inherit;padding:.3rem .8rem;border:1px solid var(--line);border-radius:6px;background:var(--soft);color:var(--fg);cursor:pointer}
button.danger{color:var(--danger)}
.notice{padding:.75rem 1rem;border:1px solid var(--line);border-radius:8px;background:var(--soft);margin:1rem 0}
.notice.warn{border-color:#d4a017}.notice.error{border-color:var(--danger)}
pre{background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:.75rem;overflow:auto;font-size:.85rem;margin:.25rem 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.snippet{position:relative}.snippet button{position:absolute;top:.4rem;right:.4rem;font-size:.75rem;padding:.1rem .5rem}
.token{display:block;word-break:break-all;font-size:.95rem;margin:.5rem 0}
[hidden]{display:none!important}
.viewer{flex:1;display:flex;gap:1rem;min-height:24rem}
.frame{position:relative;flex:1 1 auto;display:flex;min-width:0}
.frame iframe.artifact{min-height:0}
#comment-on-selection{position:absolute;left:50%;bottom:1rem;transform:translateX(-50%);background:var(--accent);color:#fff;border-color:var(--accent);box-shadow:0 2px 8px rgba(0,0,0,.25)}
details.comments{flex:0 0 22rem;min-width:0;display:flex;flex-direction:column;border:1px solid var(--line);border-radius:6px;padding:.5rem .75rem;overflow:auto;max-height:calc(100vh - 10rem)}
details.comments:not([open]){flex-basis:auto}
details.comments>summary{cursor:pointer;font-weight:500}
.comments textarea{display:block;width:100%;font:inherit;padding:.35rem .5rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);resize:vertical}
.comments form{margin:.5rem 0}.comments form .row{display:flex;gap:.5rem;justify-content:flex-end;margin-top:.35rem}
.thread{border-top:1px solid var(--line);padding:.6rem 0}
.thread ol{list-style:none;margin:0;padding:0}.thread li{margin:.35rem 0}
.thread .who{font-size:.8rem;color:var(--muted)}
.thread .text{white-space:pre-wrap;overflow-wrap:anywhere;margin:.1rem 0}
.quote{margin:.25rem 0;padding:.15rem .6rem;border-left:3px solid #d4a017;color:var(--muted);font-size:.9rem;overflow-wrap:anywhere;max-height:6.5em;overflow:hidden}
.thread.done{opacity:.75}
details.resolved>summary{cursor:pointer;color:var(--muted);margin:.5rem 0}
@media (max-width:60rem){.viewer{flex-direction:column}.frame{min-height:24rem}details.comments{flex:none;max-height:none}}
@media (max-width:40rem){main{padding:.75rem}header{padding:.5rem .75rem;gap:.75rem}}
`;

/** The client code, served by the UI at /static/app.js; the version in its URL busts caches. */
export const APP_JS = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
const APP_JS_URL = `/static/app.js?v=${createHash('sha256').update(APP_JS).digest('hex').slice(0, 12)}`;

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

/** No inline script, and no inline style beyond the block above, pinned by its hash. */
export function contentSecurityPolicy(contentOrigin: string): string {
  return [
    "default-src 'self'",
    `frame-src ${contentOrigin}`,
    "img-src 'self' data:",
    `style-src ${sha256(STYLE)}`,
    "script-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

export type Nav = 'artifacts' | 'connect' | 'tokens' | 'trash' | null;

export function layout(opts: {
  title: string;
  user: string | null;
  nav?: Nav;
  wide?: boolean;
  body: Html;
}): Html {
  const link = (href: string, label: string, key: Nav) =>
    html`<a href="${href}"${opts.nav === key ? raw(' aria-current="page"') : ''}>${label}</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${opts.title} · Agent Artifacts</title>
<style>${raw(STYLE)}</style>
<script src="${APP_JS_URL}" defer></script>
</head>
<body>
<header>
<a class="brand" href="/">Agent Artifacts</a>
${
  opts.user
    ? html`<nav>${link('/', 'Artifacts', 'artifacts')}${link('/connect', 'Connect', 'connect')}${link('/settings/tokens', 'Tokens', 'tokens')}${link('/trash', 'Trash', 'trash')}</nav>
<span class="user">${opts.user}</span>`
    : ''
}
</header>
<main${opts.wide ? raw(' class="wide"') : ''}>
${opts.body}
</main>
</body>
</html>`;
}
