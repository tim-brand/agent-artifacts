import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Format } from '../contracts.ts';
import type { BlobStore } from './blobs.ts';
import { entryBody } from './search.ts';

/** SQL, or a function for a step that needs more than SQL (such as reading blobs). */
type Migration = string | ((db: DatabaseSync, blobs: BlobStore) => void);

/** Append only: each step runs once, in order, tracked by PRAGMA user_version. */
const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL,
    latest_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX artifacts_by_updated ON artifacts (updated_at DESC, id DESC) WHERE deleted_at IS NULL;

  CREATE TABLE versions (
    artifact_id TEXT NOT NULL REFERENCES artifacts (id),
    version INTEGER NOT NULL,
    entry TEXT NOT NULL,
    format TEXT NOT NULL,
    published_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version)
  ) WITHOUT ROWID;

  CREATE TABLE version_files (
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version, path),
    FOREIGN KEY (artifact_id, version) REFERENCES versions (artifact_id, version)
  ) WITHOUT ROWID;

  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  `,

  // Full-text search, backfilled from every live artifact. Its SQL is written out here instead of
  // reusing the search index, so later schema changes can't break this step.
  (db, blobs) => {
    db.exec(`CREATE VIRTUAL TABLE artifacts_fts USING fts5(
      artifact_id UNINDEXED, title, description, body,
      tokenize = 'unicode61 remove_diacritics 2'
    )`);
    const rows = db
      .prepare(
        `SELECT a.id, a.title, a.description, v.format, f.sha256
         FROM artifacts a
         JOIN versions v ON v.artifact_id = a.id AND v.version = a.latest_version
         LEFT JOIN version_files f ON f.artifact_id = v.artifact_id AND f.version = v.version AND f.path = v.entry
         WHERE a.deleted_at IS NULL`,
      )
      .all() as {
      id: string;
      title: string;
      description: string;
      format: Format;
      sha256: string | null;
    }[];
    const insert = db.prepare(
      'INSERT INTO artifacts_fts (artifact_id, title, description, body) VALUES (?, ?, ?, ?)',
    );
    for (const row of rows) {
      insert.run(row.id, row.title, row.description, entryBody(blobs, row.format, row.sha256));
    }
  },

  // Public share links. A NULL version follows the latest one. Purging an artifact removes its links.
  `
  CREATE TABLE share_links (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    version INTEGER,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT
  );
  CREATE INDEX share_links_by_artifact ON share_links (artifact_id, created_at DESC);
  `,

  // Comments. ON DELETE CASCADE so purging an artifact for good takes its threads and comments.
  `
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    anchor_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX threads_by_artifact ON threads (artifact_id, updated_at DESC);

  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    typed INTEGER NOT NULL CHECK (typed IN (0, 1)),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX comments_by_thread ON comments (thread_id, created_at);
  `,

  // Live pages. Capabilities are JSON ({"db":true,"viewer":false}). data_rev counts the artifact's
  // data writes; each document row keeps the revision of its last write, so a page can poll for
  // what changed. A delete leaves a tombstone (json NULL) so pollers see it; data_floor is the
  // revision up to which tombstones have been dropped. ON DELETE CASCADE: the purge takes the data.
  `
  ALTER TABLE artifacts ADD COLUMN capabilities TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE artifacts ADD COLUMN data_rev INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE artifacts ADD COLUMN data_floor INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE artifact_data (
    artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    doc_id TEXT NOT NULL,
    json TEXT,
    rev INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (artifact_id, doc_id)
  ) WITHOUT ROWID;
  CREATE INDEX artifact_data_by_rev ON artifact_data (artifact_id, rev);
  `,
];

export function openDb(dataDir: string, blobs: BlobStore): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'artifacts.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const { user_version: current } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  for (const [index, migration] of MIGRATIONS.entries()) {
    if (index < current) continue;
    transaction(db, () => {
      if (typeof migration === 'string') db.exec(migration);
      else migration(db, blobs);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    });
  }
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
