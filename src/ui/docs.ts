import { html } from 'hono/html';
import { DATA_LIMITS } from '../contracts.ts';
import { type Html, layout } from './layout.ts';

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

export function docsRuntimePage(opts: { user: string }): Html {
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
theme;                                        // 'light' or 'dark', the system setting
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
    html`<div class="snippet"><pre><code id="${id}">${text}</code></pre><button type="button" data-copy="${id}">Copy</button></div>`;

  return layout({
    title: 'Live pages',
    user: opts.user,
    nav: 'connect',
    body: html`<h1>Live pages</h1>
<p>An HTML artifact can keep data, such as poll votes, a checklist or a tracker, without ever holding a credential. Its page calls <code>window.openArtifacts</code>; the app's artifact page makes the call for it, signed in as you, and only for that artifact.</p>
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
${block('sample-poll', SAMPLE_POLL)}`,
  });
}
