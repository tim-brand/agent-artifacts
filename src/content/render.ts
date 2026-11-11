import hljs from 'highlight.js';
import { Marked } from 'marked';

// Rendered pages for markdown and code entries. They are served under the same sandbox CSP as any
// other artifact file, so raw HTML the agent put in its markdown is acceptable; we add no script.

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = lang?.trim().split(/\s+/)[0] ?? '';
      const html = hljs.getLanguage(language)
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escapeHtml(text);
      return `<pre><code class="hljs">${html}</code></pre>\n`;
    },
  },
});

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderMarkdown(title: string, source: string): string {
  return page(title, `<article>${marked.parse(source, { async: false })}</article>`);
}

export function renderCode(title: string, path: string, source: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  const language = (dot > 0 ? name.slice(dot + 1) : name).toLowerCase();
  const code = hljs.getLanguage(language)
    ? hljs.highlight(source, { language, ignoreIllegals: true }).value
    : hljs.highlightAuto(source).value;
  const lines = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n');
  const numbers = lines.map((_, i) => i + 1).join('\n');
  return page(
    title,
    `<p class="file">${escapeHtml(path)}</p>` +
      `<div class="code"><pre class="ln" aria-hidden="true">${numbers}</pre>` +
      `<pre><code class="hljs">${code}</code></pre></div>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

const CSS = `
:root {
  --fg: #1f2328; --bg: #ffffff; --muted: #59636e; --line: #d1d9e0; --code-bg: #f6f8fa;
  --kw: #cf222e; --str: #0a3069; --num: #0550ae; --fn: #8250df; --com: #59636e; --type: #953800;
  --tag: #116329;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6edf3; --bg: #0d1117; --muted: #9198a1; --line: #3d444d; --code-bg: #161b22;
    --kw: #ff7b72; --str: #a5d6ff; --num: #79c0ff; --fn: #d2a8ff; --com: #9198a1; --type: #ffa657;
    --tag: #7ee787;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto; max-width: 900px; padding: 2rem 1.25rem 4rem; color: var(--fg);
  background: var(--bg); line-height: 1.6;
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.6em; }
h1, h2 { border-bottom: 1px solid var(--line); padding-bottom: 0.3em; }
a { color: var(--num); }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid var(--line); }
blockquote { margin: 0; padding: 0 1em; color: var(--muted); border-left: 0.25em solid var(--line); }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 0.4em 0.8em; }
code, pre { font: 0.875rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:not(pre) > code { background: var(--code-bg); padding: 0.15em 0.35em; border-radius: 4px; }
pre { background: var(--code-bg); padding: 1rem; border-radius: 6px; overflow-x: auto; margin: 0 0 1rem; }
.file { color: var(--muted); font-family: ui-monospace, monospace; margin: 0 0 0.5rem; }
.code { display: flex; background: var(--code-bg); border-radius: 6px; overflow: hidden; }
.code pre { margin: 0; border-radius: 0; }
.code pre:last-child { flex: 1; padding-left: 0.75rem; }
.ln { color: var(--muted); text-align: right; user-select: none; padding-right: 0.75rem;
  border-right: 1px solid var(--line); overflow: visible; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag, .hljs-meta .hljs-keyword { color: var(--kw); }
.hljs-string, .hljs-regexp, .hljs-meta .hljs-string { color: var(--str); }
.hljs-number, .hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable,
.hljs-symbol, .hljs-bullet, .hljs-link, .hljs-selector-id, .hljs-selector-class { color: var(--num); }
.hljs-title, .hljs-section, .hljs-function .hljs-title { color: var(--fn); }
.hljs-comment, .hljs-quote, .hljs-meta { color: var(--com); }
.hljs-comment, .hljs-quote { font-style: italic; }
.hljs-type, .hljs-built_in, .hljs-params, .hljs-title.class_ { color: var(--type); }
.hljs-name, .hljs-tag, .hljs-selector-pseudo { color: var(--tag); }
.hljs-addition { color: var(--tag); }
.hljs-deletion { color: var(--kw); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
`;
