import type { Dirent } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { TRASH_DAYS } from '../contracts.ts';
import { transaction } from './db.ts';

const HOUR = 60 * 60 * 1000;
/** Blobs younger than this are kept even when unreferenced: their publish may still be running. */
const BLOB_GRACE_MS = HOUR;

export type PurgeResult = { artifacts: number; blobs: number };

/**
 * Permanently deletes artifacts that have been in the trash for more than TRASH_DAYS, then removes
 * blobs that no version references any more.
 */
export function createPurge(db: DatabaseSync, blobsDir: string) {
  const expired = db.prepare('SELECT id FROM artifacts WHERE deleted_at < ?');
  // Delete already drops the search row; removing it again here means none can outlive its artifact.
  const deleteSearch = db.prepare('DELETE FROM artifacts_fts WHERE artifact_id = ?');
  const deleteFiles = db.prepare('DELETE FROM version_files WHERE artifact_id = ?');
  const deleteVersions = db.prepare('DELETE FROM versions WHERE artifact_id = ?');
  // Share links, threads, comments and live page data go with it: ON DELETE CASCADE.
  const deleteArtifact = db.prepare('DELETE FROM artifacts WHERE id = ?');
  const referenced = db.prepare('SELECT DISTINCT sha256 FROM version_files');

  return async function purge(now = Date.now()): Promise<PurgeResult> {
    const cutoff = new Date(now - TRASH_DAYS * 24 * HOUR).toISOString();
    const artifacts = transaction(db, () => {
      const ids = (expired.all(cutoff) as { id: string }[]).map((r) => r.id);
      for (const id of ids) {
        deleteSearch.run(id);
        deleteFiles.run(id);
        deleteVersions.run(id);
        deleteArtifact.run(id);
      }
      return ids.length;
    });

    // Read after the purge commits. A publish writes its blobs before its rows, so a blob it
    // needs may be missing from this set; the grace period keeps it.
    const keep = new Set((referenced.all() as { sha256: string }[]).map((r) => r.sha256));
    let entries: Dirent[];
    try {
      entries = await readdir(blobsDir, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { artifacts, blobs: 0 };
      throw error;
    }
    let blobs = 0;
    for (const entry of entries) {
      // Leftover temp files (<sha>.<random>.tmp) are unreferenced too, so they go once old enough.
      if (!entry.isFile() || keep.has(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      try {
        if ((await stat(path)).mtimeMs > now - BLOB_GRACE_MS) continue;
        await rm(path);
        blobs++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return { artifacts, blobs };
  };
}

/** Runs `purge` now and then every hour. Returns a function that stops it. */
export function schedulePurge(
  purge: () => Promise<PurgeResult>,
  intervalMs = HOUR,
  log: (message: string, error?: unknown) => void = console.log,
): () => void {
  const run = () =>
    purge().then(
      (r) => {
        if (r.artifacts || r.blobs) log(`purged ${r.artifacts} artifacts and ${r.blobs} blobs`);
      },
      (error) => log('purge failed', error),
    );
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
