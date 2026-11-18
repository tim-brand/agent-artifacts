import type { DatabaseSync } from 'node:sqlite';
import { type FileInfo, STYLE } from '../contracts.ts';

const PREFIX = `${STYLE.dir}/`;

type FileRow = { path: string; size: number; content_type: string; sha256: string };

/** A path in the folder that holds a version's copy of its style. */
export function isStylePath(path: string): boolean {
  return path.startsWith(PREFIX);
}

/** The latest version of a live style, with its files. Null when `id` isn't a live style. */
export function latestStyleFiles(
  db: DatabaseSync,
  id: string,
): { version: number; files: FileInfo[] } | null {
  const row = db
    .prepare(
      `SELECT latest_version FROM artifacts WHERE id = ? AND deleted_at IS NULL AND format = 'style'`,
    )
    .get(id) as { latest_version: number } | undefined;
  if (!row) return null;
  const files = db
    .prepare(
      'SELECT path, size, content_type, sha256 FROM version_files WHERE artifact_id = ? AND version = ? ORDER BY path',
    )
    .all(id, row.latest_version) as FileRow[];
  return {
    version: row.latest_version,
    files: files.map((f) => ({
      path: f.path,
      size: f.size,
      contentType: f.content_type,
      sha256: f.sha256,
    })),
  };
}

/**
 * A version's files with a style attached: `own` without anything under _style/, plus each file of
 * the style under _style/. Only references: the same size, type and blob.
 */
export function attachStyle(own: FileInfo[], style: FileInfo[]): FileInfo[] {
  return [
    ...own.filter((f) => !isStylePath(f.path)),
    ...style.map((f) => ({ ...f, path: PREFIX + f.path })),
  ];
}
