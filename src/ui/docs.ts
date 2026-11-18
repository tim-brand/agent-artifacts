import { html } from 'hono/html';
import { DATA_LIMITS, LIMITS } from '../contracts.ts';
import { appShell, type Html, type Shell } from './layout.ts';

/** A complete live page: publish it as html with capabilities { db: true, viewer: true }. */
export const SAMPLE_POLL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lunch poll</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; }
  body.dark { background: #141414; color: #e8e8e8; }
  button { display: flex; justify-content: space-between; width: 100%; margin: .4rem 0;
    padding: .6rem .8rem; font: inherit; color: inherit; background: none; cursor: pointer;
    border: 1px solid #8886; border-radius: 8px; }
  button[aria-pressed="true"] { border-color: #2563eb; font-weight: 600; }
  #note { color: #888; }
</style>
</head>
<body>
<h1>Where do we eat on Friday?</h1>
<div id="options"></div>
<p id="note"></p>
<script>
  const OPTIONS = ['Pizza', 'Sushi', 'Tacos'];
  const { db, ready, onTheme } = window.openArtifacts;
  const votes = new Map(); // document id -> { option }
  let mine = null; // this viewer's document id

  const note = (text) => { document.getElementById('note').textContent = text; };
  const render = () => {
    document.getElementById('options').replaceChildren(...OPTIONS.map((option) => {
      const count = [...votes.values()].filter((v) => v.option === option).length;
      const button = document.createElement('button');
      button.setAttribute('aria-pressed', String(votes.get(mine)?.option === option));
      button.append(option, Object.assign(document.createElement('span'), { textContent: count }));
      button.disabled = !mine;
      button.onclick = async () => {
        try {
          votes.set(mine, (await db.set(mine, { option })).data);
          render();
        } catch (error) {
          note(error.message);
        }
      };
      return button;
    }));
  };

  const theme = (t) => document.body.classList.toggle('dark', t === 'dark');
  theme(window.openArtifacts.theme);
  onTheme(theme);
  render();

  ready.then(async () => {
    // One vote per person: the document id comes from the email (ids are A-Z, a-z, 0-9, _ and -).
    const viewer = window.openArtifacts.viewer;
    if (viewer) mine = 'vote-' + viewer.email.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
    try {
      await db.subscribe(({ docs, deleted, reset }) => {
        if (reset) votes.clear();
        for (const doc of docs) votes.set(doc.id, doc.data);
        for (const id of deleted) votes.delete(id);
        render();
      });
      note(mine ? '' : 'Voting needs the viewer capability.');
    } catch (error) {
      note(error.code === 'no_shell' ? 'Open this poll in Agent Artifacts to vote.' : error.message);
    }
  });
</script>
</body>
</html>
`;

const KB = 1024;

export function docsRuntimePage(opts: { shell: Shell }): Html {
  const publish = JSON.stringify(
    {
      title: 'Lunch poll',
      format: 'html',
      content: '<!doctype html>…',
      capabilities: { db: true, viewer: true },
    },
    null,
    2,
  );
  const api = `const { ready, theme, onTheme, viewer, db } = window.openArtifacts;

await ready;                                  // the app has answered (outside it: at once)
theme;                                        // 'light' or 'dark', as the app shows it
onTheme((theme) => {});                       // called when it changes; returns an unsubscribe
openArtifacts.viewer;                         // { email, name } with the viewer capability, else null

await db.get('id');                           // { id, data, updatedAt } or null
await db.set('id', { done: true });           // creates or replaces; resolves to the document
await db.update('id', { note: 'x' });         // merges top-level fields, creating it when missing
await db.delete('id');                        // true, or false when it didn't exist
await db.list({ cursor, limit });             // { items, nextCursor }, by id
await db.query({ where: { done: false }, orderBy: 'createdAt', order: 'desc', limit: 20 });
const stop = await db.subscribe(({ docs, deleted, reset }) => {});`;

  const block = (id: string, text: string) =>
    html`<div class="snippet"><pre><code id="${id}">${text}</code></pre><button type="button" class="btn sm copy" data-copy="${id}">Copy</button></div>`;

  return appShell(opts.shell, {
    title: 'Live pages',
    body: html`<div class="prose">
<div class="h1row"><h1>Live pages</h1></div>
<p class="lead">An HTML artifact can keep data, such as poll votes, a checklist or a tracker, without ever holding a credential. Its page calls <code>window.openArtifacts</code>; the app's artifact page makes the call for it, signed in as you, and only for that artifact.</p>
<h2>Declare capabilities</h2>
<p>Publish with <code>capabilities</code>. They belong to the artifact, not a version, and a settings-only publish (an <code>id</code> and <code>capabilities</code>, no content) changes them. A call the artifact didn't declare is refused, by the server too.</p>
<ul>
<li><code>db</code>: the artifact's own documents. They belong to the artifact, so every version sees the same data.</li>
<li><code>viewer</code>: the signed-in user's <code>{ email, name }</code>, and who wrote each document (<code>updatedBy</code>).</li>
</ul>
${block('publish', publish)}
<h2>The runtime</h2>
${block('api', api)}
<p>Calls reject with an <code>Error</code> that has a <code>code</code>: <code>no_shell</code>, <code>forbidden</code> (not declared), <code>not_found</code>, <code>invalid_input</code>, <code>too_large</code>, <code>rate_limited</code> or <code>unavailable</code>.</p>
<p><code>subscribe</code> first calls back with every document (<code>reset: true</code>), then, every 3 seconds while the tab is visible, with the documents that changed and the ids that were deleted. On <code>reset</code>, drop what you had. It resolves to a function that stops it.</p>
<p>The runtime is defined before the page's own scripts run, when the file starts with <code>&lt;!doctype html&gt;</code>. Without a doctype, use it from <code>DOMContentLoaded</code>.</p>
<h2>Every HTML page has it</h2>
<p>In the app, <code>window.openArtifacts</code> is defined for every HTML page, with or without capabilities: <code>theme</code> and <code>onTheme</code> work for all of them. Opened from a file or in its own tab, a page may not have it at all. So write the page to work both ways, and don't run code from the runtime branch that needs setup the rest of your script hasn't done yet (a canvas size, state). To test without the app, define a stub before your script: <code>window.openArtifacts = { theme: 'dark', onTheme() {}, ready: Promise.resolve() }</code>.</p>
<h2>Outside the app</h2>
<p>Opened in its own tab, or through a public link, the page has no app to talk to: <code>ready</code> resolves at once, <code>viewer</code> is null, and <code>db</code> calls reject with <code>{ code: 'no_shell' }</code>. Say so on the page instead of failing.</p>
<h2>Limits</h2>
<ul>
<li>A document is a JSON object of at most ${DATA_LIMITS.docBytes / KB} KB, and an artifact holds at most ${DATA_LIMITS.docs.toLocaleString('en')} of them.</li>
<li>Document ids, and the field names of <code>where</code> and <code>orderBy</code>, are A–Z, a–z, 0–9, <code>_</code> and <code>-</code>: ids up to ${DATA_LIMITS.docId} characters, fields up to ${DATA_LIMITS.field}.</li>
<li><code>where</code> is equality on up to ${DATA_LIMITS.where} top-level fields. <code>list</code> and <code>query</code> return at most ${DATA_LIMITS.page} documents.</li>
<li>Writes are limited to a burst of 60, then one a second, per artifact.</li>
</ul>
<h2>Agents</h2>
<p>Agents read and seed the same data over MCP: <code>artifact_data_get</code>, <code>artifact_data_list</code>, <code>artifact_data_query</code>, <code>artifact_data_set</code>, <code>artifact_data_update</code> and <code>artifact_data_delete</code>, for example to read a poll's results.</p>
<h2>Sample: a poll</h2>
<p>Publish it as html with <code>capabilities: { db: true, viewer: true }</code>. Each person's vote is one document, named after their email.</p>
${block('sample-poll', SAMPLE_POLL)}
</div>`,
  });
}

const SAMPLE_CSS = `/* Sample style: a quiet, warm look. Tokens first, then a few classes (see guide.md). */
:root {
  color-scheme: light;
  --bg: #faf9f6;
  --surface: #ffffff;
  --text: #1f2321;
  --muted: #5f6662;
  --line: #dddbd3;
  --accent: #2f6b4f;
  --on-accent: #ffffff;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.25rem;
  --text-xl: 1.75rem;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --radius-sm: 4px;
  --radius: 8px;
}
/* Dark: from the system setting, unless the app says light; or when the app says dark. */
@media (prefers-color-scheme: dark) {
  :root:not([data-aa-theme="light"]) {
    color-scheme: dark;
    --bg: #161917;
    --surface: #1f2321;
    --text: #e8e6df;
    --muted: #a3aaa5;
    --line: #353a37;
    --accent: #7cc4a0;
    --on-accent: #10231a;
  }
}
:root[data-aa-theme="dark"] {
  color-scheme: dark;
  --bg: #161917;
  --surface: #1f2321;
  --text: #e8e6df;
  --muted: #a3aaa5;
  --line: #353a37;
  --accent: #7cc4a0;
  --on-accent: #10231a;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: var(--text-base) / 1.55 var(--font);
}
h1,
h2,
h3 {
  margin: 0;
  line-height: 1.25;
}
h1 {
  font-size: var(--text-xl);
}
h2 {
  font-size: var(--text-lg);
}
p {
  margin: 0;
}
a {
  color: var(--accent);
}
code {
  font: 0.9em var(--mono);
}

.page {
  max-width: 760px;
  margin: 0 auto;
  padding: var(--space-8) var(--space-4);
}
.stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-6);
}
.button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: var(--text-sm);
  text-decoration: none;
  cursor: pointer;
}
.button.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
.badge {
  display: inline-block;
  padding: 0 var(--space-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font: var(--text-sm) / 1.6 var(--mono);
}
.muted {
  color: var(--muted);
}
`;

const SAMPLE_GUIDE = `# Sample style

A quiet, warm look for pages and documents. The app links style.css into your entry file, before your own CSS, so you link nothing yourself. Use the classes below for the parts they cover, and the tokens for anything else.

## Layout

Put the page in \`<main class="page stack">\`: one centred column, at most 760px wide. Give it a heading, then a line of \`.muted\` text that says what the page is, then cards. Keep to one column; use \`.row\` for things that sit side by side.

## Classes

- \`.page\`: the page column, centred, with room around it.
- \`.stack\`: its children one under the other, 16px apart. Combine it with \`.page\` or \`.card\`.
- \`.row\`: its children side by side, wrapping, 12px apart.
- \`.card\`: a box on the surface colour, with a border and padding. One topic per card.
- \`.button\`: a button, or a link that acts as one. Add \`.primary\` for the one main action of a page.
- \`.badge\`: a short status label, such as "Draft" or "3 open".
- \`.muted\`: secondary text.

Plain \`h1\`, \`h2\`, \`p\`, \`a\` and \`code\` are styled too.

## Tokens

Use these custom properties in your own CSS instead of fixed values, so your additions follow light and dark:

- Colour: \`--bg\`, \`--surface\`, \`--text\`, \`--muted\`, \`--line\`, \`--accent\`, \`--on-accent\` (text on the accent).
- Type: \`--font\`, \`--mono\`, \`--text-sm\`, \`--text-base\`, \`--text-lg\`, \`--text-xl\`.
- Spacing: \`--space-1\` (4px), \`--space-2\` (8px), \`--space-3\` (12px), \`--space-4\` (16px), \`--space-6\` (24px), \`--space-8\` (32px).
- Radius: \`--radius-sm\`, \`--radius\`.

## Light and dark

The tokens change for dark. Don't set colours of your own; use the tokens.
`;

const SAMPLE_PREVIEW = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sample style</title>
</head>
<body>
<main class="page stack">
<h1>Sample style</h1>
<p class="muted">Every class from the guide, in the app's light or dark theme.</p>
<section class="card stack">
<div class="row"><h2>A card</h2><span class="badge">Badge</span></div>
<p>A card holds one topic. Its children are a <code>.stack</code>, so they keep their distance.</p>
<div class="row"><button class="button primary" type="button">Primary action</button><button class="button" type="button">Button</button><a class="button" href="#">A link as a button</a></div>
</section>
<section class="card stack">
<h2>Text</h2>
<p>Body text with <a href="#">a link</a> and <code>inline code</code>.</p>
<p class="muted">Muted text, for what matters less.</p>
</section>
</main>
</body>
</html>
`;

/** A small, complete style: publish it with format "style" and these files. */
export const SAMPLE_STYLE: Record<'style.css' | 'guide.md' | 'preview.html', string> = {
  'style.css': SAMPLE_CSS,
  'guide.md': SAMPLE_GUIDE,
  'preview.html': SAMPLE_PREVIEW,
};

export function docsStylesPage(opts: { shell: Shell }): Html {
  const publish = JSON.stringify(
    {
      title: 'House style',
      format: 'style',
      files: {
        'style.css': ':root { … }',
        'guide.md': '# House style …',
        'preview.html': '<!doctype html>…',
      },
    },
    null,
    2,
  );
  const use = JSON.stringify(
    { title: 'Pricing page', format: 'html', content: '<!doctype html>…', style: '<style id>' },
    null,
    2,
  );
  const dark = `:root { --bg: #fff; --text: #111; }
@media (prefers-color-scheme: dark) {
  :root:not([data-aa-theme="light"]) { --bg: #111; --text: #eee; }
}
:root[data-aa-theme="dark"] { --bg: #111; --text: #eee; }`;

  const block = (id: string, text: string) =>
    html`<div class="snippet"><pre><code id="${id}">${text}</code></pre><button type="button" class="btn sm copy" data-copy="${id}">Copy</button></div>`;

  return appShell(opts.shell, {
    title: 'Styles',
    body: html`<div class="prose">
<div class="h1row"><h1>Styles</h1></div>
<p class="lead">A style is a shared look for artifacts: one stylesheet and a guide for agents. Pages and documents published with the same style look the same, and when the style changes, they can follow.</p>
<h2>What a style is</h2>
<p>An artifact with the format <code>style</code>, published with <code>files</code>:</p>
<ul>
<li><code>style.css</code>: the stylesheet.</li>
<li><code>guide.md</code>: for agents. The tokens, the classes and components, and how to lay out a page. An agent reads it with <code>get_style</code> before it writes markup.</li>
<li><code>preview.html</code>, optional: a specimen page that shows each part. The app shows it as the style's page; without one, it shows the guide.</li>
<li>Fonts or images that <code>style.css</code> references by a relative path.</li>
</ul>
${block('style-publish', publish)}
<p>A style has versions like any artifact. A new version of a style stays a style, and no other artifact can become one.</p>
<h2>Using a style</h2>
<p>An agent publishes an HTML page or a Markdown document with <code>style</code> set to the style's id. The version then holds a copy of the style's files under <code>_style/</code>, and the app links <code>_style/style.css</code> into the entry file, before the page's own CSS. Other HTML files of the artifact link it themselves.</p>
${block('style-use', use)}
<p>Each version keeps the style version it was published with, so an old version looks as it did. A new version of the page gets the style's latest version. To bring a page up to date without changing it, an agent publishes with only its <code>id</code> and <code>style</code>; nothing is published when it already has the latest. <code>style: null</code> stops using the style.</p>
<h2>The preferred style</h2>
<p>Pick one style as your preferred one, under Details on the style's page. Agents see it as <code>preferred: true</code> in <code>list_styles</code> and use it for new pages when you haven't asked for another look. Only you can set it, here in the app; no agent tool can.</p>
<h2>When a style is deleted</h2>
<p>Pages that use it keep working: each version holds its own copy. A new version of such a page keeps that copy, and the agent gets a warning that the style is gone.</p>
<h2>Light and dark</h2>
<p>In the app, a styled page follows the app's theme: the frame sets <code>data-aa-theme="light"</code> or <code>"dark"</code> on the page's <code>&lt;html&gt;</code>. Elsewhere, such as a public link, it follows the system setting. Write the CSS for both:</p>
${block('style-dark', dark)}
<h2>Limits</h2>
<p>The copied style files count toward the ${LIMITS.files} files of a version, not toward its size.</p>
<h2>Sample: a style</h2>
<p>Publish these three files with <code>format: "style"</code>.</p>
<h3><code>style.css</code></h3>
${block('sample-style-css', SAMPLE_STYLE['style.css'])}
<h3><code>guide.md</code></h3>
${block('sample-style-guide', SAMPLE_STYLE['guide.md'])}
<h3><code>preview.html</code></h3>
${block('sample-style-preview', SAMPLE_STYLE['preview.html'])}
</div>`,
  });
}
