import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Append only: each step runs once, in order, tracked by PRAGMA user_version. */
const MIGRATIONS = [
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
];

export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'artifacts.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const { user_version: current } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  for (const [index, sql] of MIGRATIONS.entries()) {
    if (index < current) continue;
    transaction(db, () => {
      db.exec(sql);
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
