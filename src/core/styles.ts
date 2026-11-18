import type { DatabaseSync } from 'node:sqlite';
import {
  AppError,
  type ArtifactService,
  type FileInfo,
  STYLE,
  type StyleService,
} from '../contracts.ts';
import { type ArtifactRow, toArtifact } from './artifacts.ts';

const PREFIX = `${STYLE.dir}/`;
/** The settings key of the owner's preferred style. */
export const PREFERRED_STYLE = 'preferred_style';

/** Artifacts whose latest version uses the style `:style`, as `FROM … WHERE …` with them as u. */
const USERS = `artifacts u JOIN versions v ON v.artifact_id = u.id AND v.version = u.latest_version
  WHERE u.deleted_at IS NULL AND v.style_id = :style`;

export function createStyleService(db: DatabaseSync, artifacts: ArtifactService): StyleService {
  const stmt = {
    preferred: db.prepare(
      `SELECT a.id FROM settings s JOIN artifacts a ON a.id = s.value
       WHERE s.key = '${PREFERRED_STYLE}' AND a.deleted_at IS NULL AND a.format = 'style'`,
    ),
    styles: db.prepare(
      `SELECT a.*, (SELECT count(*) FROM ${USERS.replace(':style', 'a.id')}) AS used_by
       FROM artifacts a WHERE a.deleted_at IS NULL AND a.format = 'style'
       ORDER BY a.updated_at DESC, a.id DESC`,
    ),
    usedBy: db.prepare(
      `SELECT u.*, v.style_version FROM ${USERS} ORDER BY u.updated_at DESC, u.id DESC`,
    ),
    live: db.prepare(
      'SELECT format, latest_version FROM artifacts WHERE id = ? AND deleted_at IS NULL',
    ),
    setPreferred: db.prepare(
      `INSERT INTO settings (key, value) VALUES ('${PREFERRED_STYLE}', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ),
    clearPreferred: db.prepare(`DELETE FROM settings WHERE key = '${PREFERRED_STYLE}'`),
  };

  const preferred = () => (stmt.preferred.get() as { id: string } | undefined)?.id ?? null;
  const live = (id: string) =>
    stmt.live.get(id) as { format: string; latest_version: number } | undefined;
  const text = async (id: string, version: number, path: string) => {
    const file = await artifacts.readFile(id, version, path);
    return file ? new TextDecoder().decode(file.bytes) : '';
  };

  return {
    async list() {
      const chosen = preferred();
      const rows = stmt.styles.all() as (ArtifactRow & { used_by: number })[];
      return rows
        .map((row) => ({
          artifact: toArtifact(row),
          preferred: row.id === chosen,
          usedBy: row.used_by,
        }))
        .sort((x, y) => Number(y.preferred) - Number(x.preferred));
    },

    async get(id, version) {
      const found = await artifacts.get(id, version);
      if (found?.artifact.format !== 'style') return null;
      const v = found.version.version;
      return {
        ...found,
        preferred: preferred() === id,
        guide: await text(id, v, STYLE.guide),
        css: await text(id, v, STYLE.css),
      };
    },

    async usedBy(id) {
      const rows = stmt.usedBy.all({ style: id }) as (ArtifactRow & { style_version: number })[];
      return rows.map((row) => ({ artifact: toArtifact(row), styleVersion: row.style_version }));
    },

    async latestVersion(id) {
      const row = live(id);
      return row?.format === 'style' ? row.latest_version : null;
    },

    async preferred() {
      return preferred();
    },

    async setPreferred(id) {
      if (id === null) {
        stmt.clearPreferred.run();
        return;
      }
      const row = live(id);
      if (!row) throw new AppError('not_found', `Artifact ${id} not found`, { id });
      if (row.format !== 'style') {
        throw new AppError('invalid_input', `Artifact ${id} is not a style`, { id });
      }
      stmt.setPreferred.run(id);
    },
  };
}

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
