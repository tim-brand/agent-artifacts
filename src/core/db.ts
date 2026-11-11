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
