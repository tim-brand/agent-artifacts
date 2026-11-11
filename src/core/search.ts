import type { DatabaseSync } from 'node:sqlite';
import type { Format } from '../contracts.ts';
import type { ArtifactRow } from './artifacts.ts';
import type { BlobStore } from './blobs.ts';

/** Cap on the indexed text of one artifact. */
const BODY_BYTES = 256 * 1024;
const MAX_QUERY_TERMS = 20;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  times: '×',
  deg: '°',
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi,
    (match, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? match;
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    },
  );
}

/**
 * Visible text of an HTML document, for the index only: the result is never rendered as HTML.
 * Every pattern can run to the end of the input, so an unclosed tag can't make it quadratic.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<\/?[a-z!?][^>]*(?:>|$)/gi, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function capBytes(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= max) return text;
  // A cut through a multi-byte character decodes to U+FFFD.
  return bytes.subarray(0, max).toString('utf8').replace(/�+$/, '');
}

/** The indexed text of an entry file. PDFs have none: extracting it would need a dependency. */
export function indexText(format: Format, bytes: Uint8Array): string {
  if (format === 'pdf') return '';
  const text = new TextDecoder().decode(bytes);
  return capBytes(format === 'html' ? htmlToText(text) : text, BODY_BYTES);
}

/** A missing or unreadable blob leaves the body empty rather than failing a publish or startup. */
export function entryBody(blobs: BlobStore, format: Format, sha256: string | null): string {
  if (!sha256) return '';
  try {
    return indexText(format, blobs.readSync(sha256));
  } catch (error) {
    console.error('search: could not index blob', sha256, error);
    return '';
  }
}

/**
 * Turns user input into FTS5 syntax that can't fail or inject operators: every whitespace-separated
 * word becomes a quoted string (so AND, NEAR, column filters and stray quotes are just text), and
 * the last one also matches as a prefix. Null when nothing in it is searchable.
 */
export function toFtsQuery(query: string): string | null {
  // FTS5's unicode61 tokenizer only keeps letters, numbers and private-use characters.
  const terms = String(query)
    .slice(0, 1000)
    .split(/\s+/)
    .filter((term) => /[\p{L}\p{N}\p{Co}]/u.test(term))
    .slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) return null;
  const last = terms.length - 1;
  return terms
    .map((term, i) => `"${term.replaceAll('"', '""')}"${i === last ? '*' : ''}`)
    .join(' ');
}

export type SearchRow = ArtifactRow & { snippet: string };

export type SearchIndex = {
  /**
   * Brings the artifact's row in line with the database: title, description and the text of the
   * latest version's entry file, or no row when the artifact is gone or deleted. Call it in the
   * transaction that changed the artifact (publish, delete, undelete), so search sees it at once.
   */
  reindexArtifact(id: string): void;
  /** Best match first (bm25, a title match weighs most), deleted artifacts left out. */
  search(query: string, limit: number, offset: number): SearchRow[];
};

export function createSearchIndex(db: DatabaseSync, blobs: BlobStore): SearchIndex {
  const stmt = {
    source: db.prepare(
      `SELECT a.id, a.title, a.description, v.format, f.sha256
       FROM artifacts a
       JOIN versions v ON v.artifact_id = a.id AND v.version = a.latest_version
       LEFT JOIN version_files f ON f.artifact_id = v.artifact_id AND f.version = v.version AND f.path = v.entry
       WHERE a.id = ? AND a.deleted_at IS NULL`,
    ),
    remove: db.prepare('DELETE FROM artifacts_fts WHERE artifact_id = ?'),
    insert: db.prepare(
      'INSERT INTO artifacts_fts (artifact_id, title, description, body) VALUES (?, ?, ?, ?)',
    ),
    search: db.prepare(
      `SELECT a.*, snippet(artifacts_fts, -1, '«', '»', '…', 16) AS snippet
       FROM artifacts_fts JOIN artifacts a ON a.id = artifacts_fts.artifact_id
       WHERE artifacts_fts MATCH ? AND a.deleted_at IS NULL
       ORDER BY bm25(artifacts_fts, 0, 10, 4, 1), a.updated_at DESC, a.id
       LIMIT ? OFFSET ?`,
    ),
  };

  return {
    reindexArtifact(id) {
      stmt.remove.run(id);
      const row = stmt.source.get(id) as
        | { id: string; title: string; description: string; format: Format; sha256: string | null }
        | undefined;
      if (!row) return;
      stmt.insert.run(row.id, row.title, row.description, entryBody(blobs, row.format, row.sha256));
    },

    search(query, limit, offset) {
      const match = toFtsQuery(query);
      if (!match) return [];
      return stmt.search.all(match, limit, offset) as SearchRow[];
    },
  };
}
