import type { DatabaseSync } from 'node:sqlite';
import {
  type Anchor,
  type AnchorInput,
  AppError,
  ASK_LIMITS,
  type Ask,
  type AskInput,
  type AskOption,
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
type AskRow = {
  comment_id: string;
  question: string;
  options_json: string;
  recommended_json: string | null;
  answer_option: string | null;
  answered_by: string | null;
  answered_at: string | null;
};

function toAsk(row: AskRow): Ask {
  const options = JSON.parse(row.options_json) as AskOption[];
  const chosen = options.find((o) => o.id === row.answer_option);
  return {
    question: row.question,
    options,
    recommended: row.recommended_json ? JSON.parse(row.recommended_json) : null,
    answer:
      chosen && row.answered_by && row.answered_at
        ? {
            optionId: chosen.id,
            label: chosen.label,
            by: row.answered_by,
            at: row.answered_at,
            typed: true,
          }
        : null,
  };
}

const toComment = (row: CommentRow, ask?: AskRow): Comment => ({
  id: row.id,
  author: row.author,
  typed: row.typed === 1,
  body: row.body,
  createdAt: row.created_at,
  ...(ask ? { ask: toAsk(ask) } : {}),
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

const OPTION_ID = new RegExp(`^[A-Za-z0-9_-]{1,${ASK_LIMITS.optionId}}$`);

/** Trimmed text of 1 to `max` characters, or `name` is refused. */
function text(value: unknown, max: number, name: string): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > max) {
    throw new AppError('invalid_input', `${name} is 1 to ${max} characters`);
  }
  return result;
}

/**
 * A fresh ask from only the fields an ask has: anything else in the input (such as an `answer`) is
 * dropped, so no caller can store an answer with the question.
 */
export function cleanAsk(ask: AskInput): Omit<Ask, 'answer'> {
  if (!ask || typeof ask !== 'object') throw new AppError('invalid_input', 'ask is an object');
  const question = text(ask.question, ASK_LIMITS.question, 'ask.question');
  const given = Array.isArray(ask.options) ? ask.options : [];
  if (given.length < ASK_LIMITS.minOptions || given.length > ASK_LIMITS.maxOptions) {
    throw new AppError(
      'invalid_input',
      `ask.options has ${ASK_LIMITS.minOptions} to ${ASK_LIMITS.maxOptions} options`,
    );
  }
  const options = given.map((option): AskOption => {
    const id = typeof option?.id === 'string' ? option.id : '';
    if (!OPTION_ID.test(id)) {
      throw new AppError(
        'invalid_input',
        `An option id is 1 to ${ASK_LIMITS.optionId} characters of A-Z, a-z, 0-9, _ and -`,
      );
    }
    const label = text(option.label, ASK_LIMITS.label, 'An option label');
    const detail = typeof option.detail === 'string' ? option.detail.trim() : '';
    if (detail.length > ASK_LIMITS.detail) {
      throw new AppError(
        'invalid_input',
        `An option detail is at most ${ASK_LIMITS.detail} characters`,
      );
    }
    return detail ? { id, label, detail } : { id, label };
  });
  if (new Set(options.map((o) => o.id)).size !== options.length) {
    throw new AppError('invalid_input', 'Option ids must be unique');
  }
  let recommended: Ask['recommended'] = null;
  if (ask.recommended !== undefined && ask.recommended !== null) {
    const optionId = ask.recommended.optionId;
    if (!options.some((o) => o.id === optionId)) {
      throw new AppError('invalid_input', 'ask.recommended.optionId must be one of the options');
    }
    recommended = {
      optionId,
      why: text(ask.recommended.why, ASK_LIMITS.why, 'ask.recommended.why'),
    };
  }
  return { question, options, recommended };
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
      `SELECT c.*, k.comment_id, k.question, k.options_json, k.recommended_json, k.answer_option,
         k.answered_by, k.answered_at
       FROM comments c LEFT JOIN asks k ON k.comment_id = c.id
       WHERE c.thread_id IN (SELECT value FROM json_each(?))
       ORDER BY c.created_at, c.rowid`,
    ),
    insertAsk: db.prepare(
      `INSERT INTO asks (comment_id, question, options_json, recommended_json) VALUES (?, ?, ?, ?)`,
    ),
    askOf: db.prepare(
      `SELECT c.thread_id, t.artifact_id, t.resolved_at, k.options_json
       FROM comments c JOIN threads t ON t.id = c.thread_id ${live}
       LEFT JOIN asks k ON k.comment_id = c.id WHERE c.id = ?`,
    ),
    setAnswer: db.prepare(
      'UPDATE asks SET answer_option = ?, answered_by = ?, answered_at = ? WHERE comment_id = ?',
    ),
    openAskCounts: db.prepare(
      `SELECT t.artifact_id AS id, COUNT(*) AS open FROM asks k
       JOIN comments c ON c.id = k.comment_id JOIN threads t ON t.id = c.thread_id ${live}
       WHERE k.answered_at IS NULL AND t.resolved_at IS NULL
         AND t.artifact_id IN (SELECT value FROM json_each(?))
       GROUP BY t.artifact_id`,
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
    const all = stmt.comments.all(JSON.stringify(rows.map((r) => r.id))) as (CommentRow &
      (AskRow | { [K in keyof AskRow]: null }))[];
    for (const row of all) {
      const list = byThread.get(row.thread_id) ?? [];
      list.push(toComment(row, row.comment_id === null ? undefined : (row as AskRow)));
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
      // Asks come from agents; the owner answers them and never asks.
      if (input.ask !== undefined && author.typed) {
        throw new AppError('invalid_input', 'Only agents ask; the owner answers');
      }
      const ask = input.ask === undefined ? null : cleanAsk(input.ask);
      const given = typeof input.body === 'string' ? input.body.trim() : '';
      const body = cleanBody(ask && !given ? ask.question : input.body);
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
        const commentId = randomId();
        stmt.insertComment.run(commentId, threadId, author.name, author.typed ? 1 : 0, body, time);
        if (ask) {
          stmt.insertAsk.run(
            commentId,
            ask.question,
            JSON.stringify(ask.options),
            ask.recommended ? JSON.stringify(ask.recommended) : null,
          );
        }
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

    async openAskCounts(artifactIds) {
      if (artifactIds.length === 0) return {};
      const rows = stmt.openAskCounts.all(JSON.stringify(artifactIds)) as {
        id: string;
        open: number;
      }[];
      return Object.fromEntries(rows.map((r) => [r.id, r.open]));
    },

    async answer(artifactId, commentId, optionId, by) {
      return transaction(db, () => {
        const row = stmt.askOf.get(commentId) as
          | {
              thread_id: string;
              artifact_id: string;
              resolved_at: string | null;
              options_json: string | null;
            }
          | undefined;
        if (!row || row.artifact_id !== artifactId) return null;
        if (row.options_json === null) throw notFound(`Ask ${commentId}`);
        const options = JSON.parse(row.options_json) as AskOption[];
        if (!options.some((o) => o.id === optionId)) {
          throw new AppError('invalid_input', 'That is not one of the options of this ask');
        }
        if (row.resolved_at !== null) {
          throw new AppError('invalid_input', 'The thread is resolved: reopen it to answer');
        }
        const time = now();
        stmt.setAnswer.run(optionId, by, time, commentId);
        stmt.touch.run(time, row.thread_id);
        return withComments([findThread(row.thread_id) as ThreadRow])[0] ?? null;
      });
    },
  };
}
