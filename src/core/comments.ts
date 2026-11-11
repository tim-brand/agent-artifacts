import type { DatabaseSync } from 'node:sqlite';
import {
  type Anchor,
  type AnchorInput,
  AppError,
  COMMENT_LIMITS,
  type Comment,
  type CommentService,
  type CommentStatus,
  type Thread,
} from '../contracts.ts';
import { transaction } from './db.ts';
import { now, randomId } from './ids.ts';

type ThreadRow = {
  id: string;
  artifact_id: string;
  anchor_json: string;
  version: number;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};
type CommentRow = {
  id: string;
  thread_id: string;
  author: string;
  typed: number;
  body: string;
  created_at: string;
};

const toComment = (row: CommentRow): Comment => ({
  id: row.id,
  author: row.author,
  typed: row.typed === 1,
  body: row.body,
  createdAt: row.created_at,
});

const collapse = (text: string) => text.replace(/\s+/g, ' ');

export function cleanBody(body: unknown): string {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text || text.length > COMMENT_LIMITS.body) {
    throw new AppError(
      'invalid_input',
      `A comment is 1 to ${COMMENT_LIMITS.body} characters, not ${text.length}`,
    );
  }
  return text;
}

/** Whitespace is collapsed, so a quote matches however the page's source wraps its text. */
export function cleanAnchor(anchor: AnchorInput | undefined): Anchor {
  if (!anchor || anchor.kind === 'note') return { kind: 'note' };
  if (anchor.kind !== 'text') throw new AppError('invalid_input', 'anchor.kind is note or text');
  const text = (value: unknown) => collapse(typeof value === 'string' ? value : '');
  const exact = text(anchor.exact).trim();
  const prefix = text(anchor.prefix);
  const suffix = text(anchor.suffix);
  if (!exact || exact.length > COMMENT_LIMITS.exact) {
    throw new AppError('invalid_input', `anchor.exact is 1 to ${COMMENT_LIMITS.exact} characters`);
  }
  if (prefix.length > COMMENT_LIMITS.context || suffix.length > COMMENT_LIMITS.context) {
    throw new AppError(
      'invalid_input',
      `anchor.prefix and anchor.suffix are at most ${COMMENT_LIMITS.context} characters`,
    );
  }
  return { kind: 'text', exact, prefix, suffix };
}

function parseAnchor(json: string): Anchor {
  const value = JSON.parse(json) as Anchor;
  return value.kind === 'text'
    ? { kind: 'text', exact: value.exact, prefix: value.prefix, suffix: value.suffix }
    : { kind: 'note' };
}

const STATUSES: readonly CommentStatus[] = ['open', 'resolved', 'all'];

/** Every query joins artifacts on deleted_at IS NULL: a deleted artifact's comments are hidden. */
export function createCommentService(db: DatabaseSync): CommentService {
  const live = `JOIN artifacts a ON a.id = t.artifact_id AND a.deleted_at IS NULL`;
  const stmt = {
    artifact: db.prepare(
      'SELECT latest_version FROM artifacts WHERE id = ? AND deleted_at IS NULL',
    ),
    versionExists: db.prepare('SELECT 1 FROM versions WHERE artifact_id = ? AND version = ?'),
    thread: db.prepare(`SELECT t.* FROM threads t ${live} WHERE t.id = ?`),
    threads: db.prepare(
      `SELECT t.* FROM threads t ${live}
       WHERE t.artifact_id = ? AND (? = 'all' OR (? = 'open') = (t.resolved_at IS NULL))
       ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ${COMMENT_LIMITS.threads}`,
    ),
    comments: db.prepare(
      `SELECT * FROM comments WHERE thread_id IN (SELECT value FROM json_each(?))
       ORDER BY created_at, rowid`,
    ),
    insertThread: db.prepare(
      `INSERT INTO threads (id, artifact_id, anchor_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    insertComment: db.prepare(
      `INSERT INTO comments (id, thread_id, author, typed, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    touch: db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?'),
    setResolved: db.prepare('UPDATE threads SET resolved_at = ?, updated_at = ? WHERE id = ?'),
    openCounts: db.prepare(
      `SELECT t.artifact_id AS id, COUNT(*) AS open FROM threads t ${live}
       WHERE t.resolved_at IS NULL AND t.artifact_id IN (SELECT value FROM json_each(?))
       GROUP BY t.artifact_id`,
    ),
  };

  const withComments = (rows: ThreadRow[]): Thread[] => {
    const byThread = new Map<string, Comment[]>();
    for (const row of stmt.comments.all(JSON.stringify(rows.map((r) => r.id))) as CommentRow[]) {
      const list = byThread.get(row.thread_id) ?? [];
      list.push(toComment(row));
      byThread.set(row.thread_id, list);
    }
    return rows.map((row) => ({
      id: row.id,
      artifactId: row.artifact_id,
      anchor: parseAnchor(row.anchor_json),
      version: row.version,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      comments: byThread.get(row.id) ?? [],
    }));
  };

  const findThread = (id: string, artifactId?: string) => {
    const row = stmt.thread.get(id) as ThreadRow | undefined;
    return row && (artifactId === undefined || row.artifact_id === artifactId) ? row : undefined;
  };

  const notFound = (what: string) => new AppError('not_found', `${what} not found`);

  return {
    async list(artifactId, status = 'open') {
      if (!STATUSES.includes(status)) {
        throw new AppError('invalid_input', 'status is open, resolved or all');
      }
      if (!stmt.artifact.get(artifactId)) return null;
      return withComments(stmt.threads.all(artifactId, status, status) as ThreadRow[]);
    },

    async add(input, author) {
      const body = cleanBody(input.body);
      const anchor = input.threadId === undefined ? cleanAnchor(input.anchor) : null;
      if (input.threadId !== undefined && (input.anchor || input.version !== undefined)) {
        throw new AppError('invalid_input', 'anchor and version are only for a new thread');
      }
      return transaction(db, () => {
        const artifact = stmt.artifact.get(input.artifactId) as
          | { latest_version: number }
          | undefined;
        if (!artifact) throw notFound(`Artifact ${input.artifactId}`);
        const time = now();

        let threadId: string;
        if (input.threadId === undefined) {
          const version = input.version ?? artifact.latest_version;
          if (!Number.isInteger(version) || !stmt.versionExists.get(input.artifactId, version)) {
            throw notFound(`Version ${version} of artifact ${input.artifactId}`);
          }
          threadId = randomId();
          stmt.insertThread.run(
            threadId,
            input.artifactId,
            JSON.stringify(anchor),
            version,
            time,
            time,
          );
        } else {
          const thread = findThread(input.threadId, input.artifactId);
          if (!thread) throw notFound(`Thread ${input.threadId}`);
          threadId = thread.id;
          stmt.touch.run(time, threadId);
        }
        stmt.insertComment.run(randomId(), threadId, author.name, author.typed ? 1 : 0, body, time);
        return withComments([findThread(threadId) as ThreadRow])[0] as Thread;
      });
    },

    async resolve(threadId, resolved, artifactId) {
      return transaction(db, () => {
        const thread = findThread(threadId, artifactId);
        if (!thread) return null;
        if (resolved !== (thread.resolved_at !== null)) {
          const time = now();
          stmt.setResolved.run(resolved ? time : null, time, threadId);
        }
        return withComments([findThread(threadId) as ThreadRow])[0] ?? null;
      });
    },

    async openCounts(artifactIds) {
      if (artifactIds.length === 0) return {};
      const rows = stmt.openCounts.all(JSON.stringify(artifactIds)) as {
        id: string;
        open: number;
      }[];
      return Object.fromEntries(rows.map((r) => [r.id, r.open]));
    },
  };
}
