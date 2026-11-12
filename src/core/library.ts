import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  AppError,
  type LibraryFilter,
  type LibraryQuery,
  type LibrarySort,
  type LibrarySummary,
} from '../contracts.ts';
import type { ArtifactRow } from './artifacts.ts';
import { now } from './ids.ts';

export type LibraryRow = ArtifactRow & {
  entry: string;
  agent: string;
  public_links: number;
  open_comments: number;
  open_asks: number;
};

const RESTORED = "' (restored v'";

/** Unanswered asks in open threads, as `FROM … WHERE …` with the thread as t. */
const OPEN_ASKS = `asks k JOIN comments c ON c.id = k.comment_id JOIN threads t ON t.id = c.thread_id
  WHERE k.answered_at IS NULL AND t.resolved_at IS NULL`;

/**
 * Every live artifact with what the library filters and shows: the latest version's entry and
 * publisher (a restore appends " (restored v<n>)" to the restorer's name; that is left off), the
 * public links that still work and the open threads. A personal library is small, so the counts are
 * subqueries rather than stored columns.
 */
const LIB = `WITH lib AS (
  SELECT a.*, v.entry AS entry,
    CASE WHEN instr(v.published_by, ${RESTORED}) > 0
      THEN substr(v.published_by, 1, instr(v.published_by, ${RESTORED}) - 1)
      ELSE v.published_by END AS agent,
    (SELECT count(*) FROM share_links s WHERE s.artifact_id = a.id AND s.revoked_at IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > :now)) AS public_links,
    (SELECT count(*) FROM threads t WHERE t.artifact_id = a.id AND t.resolved_at IS NULL)
      AS open_comments,
    (SELECT count(*) FROM ${OPEN_ASKS} AND t.artifact_id = a.id) AS open_asks
  FROM artifacts a JOIN versions v ON v.artifact_id = a.id AND v.version = a.latest_version
  WHERE a.deleted_at IS NULL
)`;

const FILTER = `(:format IS NULL OR format = :format)
  AND (:agent IS NULL OR agent = :agent)
  AND (:live = 0 OR json_extract(capabilities, '$.db') = 1)
  AND (:shared = 0 OR public_links > 0)
  AND (:comments = 0 OR open_comments > 0)
  AND (:asks = 0 OR open_asks > 0)`;

/** Keyset paging per sort: the key of the last row, then its id. */
const SORTS: Record<LibrarySort, { key: (row: LibraryRow) => string; sql: string }> = {
  updated: {
    key: (row) => row.updated_at,
    sql: `AND (:after IS NULL OR (updated_at, id) < (:after, :afterId))
      ORDER BY updated_at DESC, id DESC`,
  },
  title: {
    key: (row) => row.title.toLowerCase(),
    sql: `AND (:after IS NULL OR (lower(title), id) > (:after, :afterId))
      ORDER BY lower(title), id`,
  },
};

const params = (filter: LibraryFilter) => ({
  now: now(),
  format: filter.format ?? null,
  agent: filter.agent ?? null,
  live: filter.live ? 1 : 0,
  shared: filter.shared ? 1 : 0,
  comments: filter.openComments ? 1 : 0,
  asks: filter.openAsks ? 1 : 0,
});

function encodeCursor(sort: LibrarySort, key: string, id: string): string {
  return Buffer.from(JSON.stringify([sort, key, id])).toString('base64url');
}

function decodeCursor(cursor: string, sort: LibrarySort): [string, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === sort &&
      typeof value[1] === 'string' &&
      typeof value[2] === 'string'
    ) {
      return [value[1], value[2]];
    }
  } catch {}
  throw new AppError('invalid_input', 'Invalid cursor');
}

export function createLibrary(db: DatabaseSync, pageLimit: (n?: number) => number) {
  const lists = new Map<LibrarySort, StatementSync>();
  const list = (sort: LibrarySort) => {
    let stmt = lists.get(sort);
    if (!stmt) {
      stmt = db.prepare(`${LIB} SELECT * FROM lib WHERE ${FILTER} ${SORTS[sort].sql} LIMIT :limit`);
      lists.set(sort, stmt);
    }
    return stmt;
  };
  const stmt = {
    count: db.prepare(`${LIB} SELECT count(*) AS n FROM lib WHERE ${FILTER}`),
    agents: db.prepare(
      `${LIB} SELECT agent AS name, count(*) AS count FROM lib GROUP BY agent
       ORDER BY count DESC, lower(agent), agent`,
    ),
    total: db.prepare('SELECT count(*) AS n FROM artifacts WHERE deleted_at IS NULL'),
    trash: db.prepare('SELECT count(*) AS n FROM artifacts WHERE deleted_at IS NOT NULL'),
    openAsks: db.prepare(
      `SELECT count(*) AS n FROM ${OPEN_ASKS}
       AND t.artifact_id IN (SELECT id FROM artifacts WHERE deleted_at IS NULL)`,
    ),
  };

  return {
    browse(query: LibraryQuery): { rows: LibraryRow[]; nextCursor: string | null } {
      const sort: LibrarySort = query.sort === 'title' ? 'title' : 'updated';
      const limit = pageLimit(query.limit);
      const [after, afterId] = query.cursor ? decodeCursor(query.cursor, sort) : [null, null];
      const rows = list(sort).all({
        ...params(query),
        after,
        afterId,
        limit: limit + 1,
      }) as LibraryRow[];
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        rows: page,
        nextCursor:
          rows.length > limit && last ? encodeCursor(sort, SORTS[sort].key(last), last.id) : null,
      };
    },

    count(filter: LibraryFilter): number {
      return (stmt.count.get(params(filter)) as { n: number }).n;
    },

    summary(): LibrarySummary {
      return {
        total: (stmt.total.get() as { n: number }).n,
        trash: (stmt.trash.get() as { n: number }).n,
        agents: (stmt.agents.all({ now: now() }) as { name: string; count: number }[]).map(
          (row) => ({ name: row.name, count: row.count }),
        ),
        openAsks: (stmt.openAsks.get() as { n: number }).n,
      };
    },
  };
}
