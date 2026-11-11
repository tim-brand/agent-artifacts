import type { DatabaseSync } from 'node:sqlite';
import {
  AppError,
  DATA_LIMITS,
  type DataChange,
  type DataDoc,
  type DataService,
  type JsonObject,
} from '../contracts.ts';
import { parseCapabilities } from './artifacts.ts';
import { transaction } from './db.ts';
import { now } from './ids.ts';

type DocRow = {
  doc_id: string;
  json: string | null;
  rev: number;
  updated_at: string;
  updated_by: string;
};
type ArtifactRow = { capabilities: string; data_rev: number; data_floor: number };

/** Tombstones kept per artifact before they are dropped (and pollers further back get a reset). */
const TOMBSTONES = 1000;

const ID = new RegExp(`^[A-Za-z0-9_-]{1,${DATA_LIMITS.docId}}$`);
const FIELD = new RegExp(`^[A-Za-z0-9_-]{1,${DATA_LIMITS.field}}$`);

function docId(value: unknown): string {
  if (typeof value === 'string' && ID.test(value)) return value;
  throw new AppError(
    'invalid_input',
    `A document id is 1 to ${DATA_LIMITS.docId} characters of A-Z, a-z, 0-9, _ and -`,
  );
}

/** A JSON path for a checked field name, so it can't break out of the quotes. */
function path(value: unknown, what: string): string {
  if (typeof value === 'string' && FIELD.test(value)) return `$."${value}"`;
  throw new AppError(
    'invalid_input',
    `${what} is 1 to ${DATA_LIMITS.field} characters of A-Z, a-z, 0-9, _ and -`,
  );
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The document as stored: a JSON object of at most DATA_LIMITS.docBytes. */
function encode(data: unknown): string {
  if (!isObject(data)) throw new AppError('invalid_input', 'A document is a JSON object');
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    throw new AppError('invalid_input', 'A document must be plain JSON');
  }
  if (Buffer.byteLength(json) > DATA_LIMITS.docBytes) {
    throw new AppError('too_large', `A document is at most ${DATA_LIMITS.docBytes} bytes of JSON`);
  }
  return json;
}

function limit(value: unknown): number {
  if (value === undefined) return DATA_LIMITS.page;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new AppError('invalid_input', 'limit is 1 or more');
  return Math.min(n, DATA_LIMITS.page);
}

const toChange = (row: DocRow): DataChange => ({
  id: row.doc_id,
  data: row.json === null ? null : (JSON.parse(row.json) as JsonObject),
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});
const toDoc = (row: DocRow) => toChange(row) as DataDoc;

/**
 * Every call looks the artifact up first, joined on deleted_at IS NULL, and checks its `db`
 * capability: a deleted artifact's data can't be read or written, and the page's declaration is
 * enforced here, on the server, whoever calls.
 */
export function createDataService(db: DatabaseSync): DataService {
  const stmt = {
    artifact: db.prepare(
      'SELECT capabilities, data_rev, data_floor FROM artifacts WHERE id = ? AND deleted_at IS NULL',
    ),
    doc: db.prepare('SELECT * FROM artifact_data WHERE artifact_id = ? AND doc_id = ?'),
    live: db.prepare(
      'SELECT COUNT(*) AS n FROM artifact_data WHERE artifact_id = ? AND json IS NOT NULL',
    ),
    tombstones: db.prepare(
      'SELECT COUNT(*) AS n FROM artifact_data WHERE artifact_id = ? AND json IS NULL',
    ),
    dropTombstones: db.prepare('DELETE FROM artifact_data WHERE artifact_id = ? AND json IS NULL'),
    bump: db.prepare(
      'UPDATE artifacts SET data_rev = data_rev + 1 WHERE id = ? RETURNING data_rev',
    ),
    floor: db.prepare('UPDATE artifacts SET data_floor = data_rev WHERE id = ?'),
    upsert: db.prepare(
      `INSERT INTO artifact_data (artifact_id, doc_id, json, rev, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (artifact_id, doc_id) DO UPDATE SET
         json = excluded.json, rev = excluded.rev, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    ),
    list: db.prepare(
      `SELECT * FROM artifact_data WHERE artifact_id = ? AND json IS NOT NULL AND doc_id > ?
       ORDER BY doc_id LIMIT ?`,
    ),
    changes: db.prepare(
      'SELECT * FROM artifact_data WHERE artifact_id = ? AND rev > ? ORDER BY rev LIMIT ?',
    ),
  };

  const artifact = (id: string): ArtifactRow => {
    const row = stmt.artifact.get(id) as ArtifactRow | undefined;
    if (!row) throw new AppError('not_found', `Artifact ${id} not found`);
    if (!parseCapabilities(row.capabilities).db) {
      throw new AppError(
        'forbidden',
        `Artifact ${id} doesn't declare the db capability: publish it with capabilities { db: true }`,
      );
    }
    return row;
  };
  const find = (artifactId: string, id: string) => {
    const row = stmt.doc.get(artifactId, id) as DocRow | undefined;
    return row?.json == null ? undefined : row;
  };

  /** Runs inside a transaction, after the artifact check. */
  const write = (artifactId: string, id: string, json: string | null, by: string): DocRow => {
    if (json !== null && !find(artifactId, id)) {
      const { n } = stmt.live.get(artifactId) as { n: number };
      if (n >= DATA_LIMITS.docs) {
        throw new AppError('too_large', `An artifact holds at most ${DATA_LIMITS.docs} documents`);
      }
    }
    const { data_rev: rev } = stmt.bump.get(artifactId) as { data_rev: number };
    const time = now();
    stmt.upsert.run(artifactId, id, json, rev, time, by);
    return { doc_id: id, json, rev, updated_at: time, updated_by: by };
  };

  return {
    async get(artifactId, id) {
      artifact(artifactId);
      const row = find(artifactId, docId(id));
      return row ? toDoc(row) : null;
    },

    async set(artifactId, id, data, by) {
      const key = docId(id);
      const json = encode(data);
      return transaction(db, () => {
        artifact(artifactId);
        return toDoc(write(artifactId, key, json, by));
      });
    },

    async update(artifactId, id, fields, by) {
      const key = docId(id);
      if (!isObject(fields)) throw new AppError('invalid_input', 'fields is a JSON object');
      return transaction(db, () => {
        artifact(artifactId);
        const old = find(artifactId, key);
        const merged = {
          ...(old ? (JSON.parse(old.json as string) as JsonObject) : {}),
          ...fields,
        };
        return toDoc(write(artifactId, key, encode(merged), by));
      });
    },

    async delete(artifactId, id, by) {
      const key = docId(id);
      return transaction(db, () => {
        artifact(artifactId);
        if (!find(artifactId, key)) return false;
        write(artifactId, key, null, by);
        // Tombstones only serve pollers, so they are capped; a poller from before the cap was hit
        // gets reset: everything again.
        if ((stmt.tombstones.get(artifactId) as { n: number }).n > TOMBSTONES) {
          stmt.floor.run(artifactId);
          stmt.dropTombstones.run(artifactId);
        }
        return true;
      });
    },

    async list(artifactId, query = {}) {
      artifact(artifactId);
      const n = limit(query.limit);
      const after = query.cursor === undefined || query.cursor === '' ? '' : docId(query.cursor);
      const rows = stmt.list.all(artifactId, after, n + 1) as DocRow[];
      const page = rows.slice(0, n);
      return {
        items: page.map(toDoc),
        nextCursor: rows.length > n ? (page.at(-1)?.doc_id ?? null) : null,
      };
    },

    async query(artifactId, query = {}) {
      artifact(artifactId);
      const where = query.where ?? {};
      if (!isObject(where)) throw new AppError('invalid_input', 'where is an object');
      const entries = Object.entries(where);
      if (entries.length > DATA_LIMITS.where) {
        throw new AppError('invalid_input', `where has at most ${DATA_LIMITS.where} fields`);
      }
      const order = query.order ?? 'asc';
      if (order !== 'asc' && order !== 'desc') {
        throw new AppError('invalid_input', 'order is asc or desc');
      }
      // Typed equality: "1" doesn't match 1, and true doesn't match 1.
      const conditions: string[] = [];
      const params: (string | number)[] = [artifactId];
      for (const [field, value] of entries) {
        const p = path(field, 'A where field');
        if (value === null) {
          conditions.push(`json_type(json, ?) = 'null'`);
          params.push(p);
        } else if (typeof value === 'boolean') {
          conditions.push('json_type(json, ?) = ?');
          params.push(p, value ? 'true' : 'false');
        } else if (typeof value === 'string') {
          conditions.push(`json_type(json, ?) = 'text' AND json_extract(json, ?) = ?`);
          params.push(p, p, value);
        } else if (typeof value === 'number' && Number.isFinite(value)) {
          conditions.push(
            `json_type(json, ?) IN ('integer', 'real') AND json_extract(json, ?) = ?`,
          );
          params.push(p, p, value);
        } else {
          throw new AppError(
            'invalid_input',
            'where values are strings, numbers, booleans or null',
          );
        }
      }
      let orderBy = `doc_id ${order}`;
      if (query.orderBy !== undefined) {
        orderBy = `json_extract(json, ?) ${order}, ${orderBy}`;
        params.push(path(query.orderBy, 'orderBy'));
      }
      params.push(limit(query.limit));
      const sql = `SELECT * FROM artifact_data WHERE artifact_id = ? AND json IS NOT NULL
        ${conditions.map((c) => `AND ${c}`).join(' ')} ORDER BY ${orderBy} LIMIT ?`;
      return (db.prepare(sql).all(...params) as DocRow[]).map(toDoc);
    },

    async changes(artifactId, since) {
      const row = artifact(artifactId);
      if (!Number.isSafeInteger(since) || since < 0 || since > row.data_rev) {
        throw new AppError('invalid_input', `since is a revision from 0 to ${row.data_rev}`);
      }
      // A full read is a list() by id, not this: paging by revision could stop below the floor.
      if (since === 0 || since < row.data_floor) {
        return { items: [], rev: row.data_rev, more: false, reset: true };
      }
      const rows = stmt.changes.all(artifactId, since, DATA_LIMITS.page + 1) as DocRow[];
      const page = rows.slice(0, DATA_LIMITS.page);
      const more = rows.length > DATA_LIMITS.page;
      return {
        items: page.map(toChange),
        rev: more ? (page.at(-1)?.rev ?? since) : row.data_rev,
        more,
        reset: false,
      };
    },
  };
}
