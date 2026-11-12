# Search

This page explains how search works in Agent Artifacts, for people in the web UI and for agents over MCP.

Agents search with the `search_artifacts` tool, and people with the search box on the library page (`/?q=`), which you can reach with the `/` key. Both look in the title, the description and the text of the latest version's entry file, best match first.

## What is indexed

A SQLite FTS5 table holds the text. It is updated in the same transaction as each publish or delete, so a new version is searchable at once.

- HTML is indexed as its visible text, without tags, scripts or styles.
- Markdown and code are indexed as they are.
- PDFs are indexed by title and description only.
- The indexed text of one artifact is capped at 256 KB.

## How a query is read

A query is plain words. Every word must match, the last word also matches as a prefix, and accents are ignored. Search syntax in a query (`AND`, `NEAR`, quotes, `column:`) is matched as text, not as an operator. Snippets mark the matched words with `«` and `»`.

Over MCP, `search_artifacts` takes `query`, an optional `limit` (default 20, at most 100) and a `cursor` from the previous page's `nextCursor`. Each item has a `snippet`.
