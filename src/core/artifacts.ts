import type { DatabaseSync } from 'node:sqlite';
import {
  AppError,
  type Artifact,
  type ArtifactService,
  type FileInfo,
  type Format,
  type PublishInput,
  type Version,
} from '../contracts.ts';
import type { BlobStore } from './blobs.ts';
import { transaction } from './db.ts';
import { hasContent, prepareVersion } from './files.ts';
import { now, randomId } from './ids.ts';

type ArtifactRow = {
  id: string;
  title: string;
  description: string;
  format: string;
  latest_version: number;
  created_at: string;
  updated_at: string;
};
type VersionRow = {
  artifact_id: string;
  version: number;
  entry: string;
  format: string;
  published_by: string;
  created_at: string;
};
type FileRow = {
  version: number;
  path: string;
  size: number;
  content_type: string;
  sha256: string;
};

const toArtifact = (row: ArtifactRow): Artifact => ({
  id: row.id,
  title: row.title,
  description: row.description,
  format: row.format as Format,
  latestVersion: row.latest_version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toFile = (row: FileRow): FileInfo => ({
  path: row.path,
  size: row.size,
  contentType: row.content_type,
  sha256: row.sha256,
});

const toVersion = (row: VersionRow, files: FileInfo[]): Version => ({
  artifactId: row.artifact_id,
  version: row.version,
  entry: row.entry,
  format: row.format as Format,
  files,
  createdAt: row.created_at,
  publishedBy: row.published_by,
});

function encodeCursor(row: ArtifactRow): string {
  return Buffer.from(JSON.stringify([row.updated_at, row.id])).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string'
    ) {
      return [value[0], value[1]];
    }
  } catch {}
  throw new AppError('invalid_input', 'Invalid cursor');
}

function cleanTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const trimmed = String(title).trim();
  if (!trimmed) throw new AppError('invalid_input', 'title must not be empty');
  return trimmed;
}

export function createArtifactService(
  db: DatabaseSync,
  blobs: BlobStore,
  appOrigin: string,
): ArtifactService {
  const stmt = {
    artifact: db.prepare('SELECT * FROM artifacts WHERE id = ? AND deleted_at IS NULL'),
    insertArtifact: db.prepare(
      `INSERT INTO artifacts (id, title, description, format, latest_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateArtifact: db.prepare(
      `UPDATE artifacts SET title = ?, description = ?, format = ?, latest_version = ?, updated_at = ?
       WHERE id = ?`,
    ),
    insertVersion: db.prepare(
      `INSERT INTO versions (artifact_id, version, entry, format, published_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    insertFile: db.prepare(
      `INSERT INTO version_files (artifact_id, version, path, size, content_type, sha256)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    version: db.prepare('SELECT * FROM versions WHERE artifact_id = ? AND version = ?'),
    versions: db.prepare('SELECT * FROM versions WHERE artifact_id = ? ORDER BY version DESC'),
    files: db.prepare(
      'SELECT * FROM version_files WHERE artifact_id = ? AND version = ? ORDER BY path',
    ),
    allFiles: db.prepare('SELECT * FROM version_files WHERE artifact_id = ? ORDER BY path'),
    file: db.prepare(
      `SELECT f.* FROM version_files f JOIN artifacts a ON a.id = f.artifact_id
       WHERE a.id = ? AND a.deleted_at IS NULL AND f.version = ? AND f.path = ?`,
    ),
    list: db.prepare(
      `SELECT * FROM artifacts
       WHERE deleted_at IS NULL AND (? IS NULL OR format = ?) AND (? IS NULL OR (updated_at, id) < (?, ?))
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ),
    delete: db.prepare('UPDATE artifacts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
  };

  const findArtifact = (id: string) => stmt.artifact.get(id) as ArtifactRow | undefined;

  return {
    async publish(input: PublishInput, publishedBy: string) {
      const title = cleanTitle(input.title);
      const description = input.description === undefined ? undefined : String(input.description);
      const prepared = hasContent(input) ? prepareVersion(input) : null;

      if (input.id === undefined) {
        if (!title) throw new AppError('invalid_input', 'title is required for a new artifact');
        if (!prepared) {
          throw new AppError('invalid_input', 'Give content (with format) or files');
        }
      } else if (!findArtifact(input.id)) {
        // Checked before writing blobs so a bad id leaves nothing behind; checked again below.
        throw new AppError('not_found', `Artifact ${input.id} not found`);
      }

      const stored = prepared
        ? await Promise.all(
            prepared.files.map(async (f) => ({ ...f, sha256: await blobs.put(f.bytes) })),
          )
        : [];

      return transaction(db, () => {
        const time = now();
        const existing = input.id === undefined ? undefined : findArtifact(input.id);
        if (input.id !== undefined && !existing) {
          throw new AppError('not_found', `Artifact ${input.id} not found`);
        }
        if (
          existing &&
          input.expectedVersion !== undefined &&
          input.expectedVersion !== existing.latest_version
        ) {
          throw new AppError(
            'version_conflict',
            `Latest version is ${existing.latest_version}, not ${input.expectedVersion}`,
            { currentVersion: existing.latest_version },
          );
        }

        const id = existing?.id ?? randomId();
        const version = prepared
          ? (existing?.latest_version ?? 0) + 1
          : (existing?.latest_version ?? 0);
        const newTitle = title ?? existing?.title ?? '';
        const format = prepared?.format ?? (existing?.format as Format);

        if (existing) {
          stmt.updateArtifact.run(
            newTitle,
            description ?? existing.description,
            format,
            version,
            time,
            id,
          );
        } else {
          stmt.insertArtifact.run(id, newTitle, description ?? '', format, version, time, time);
        }
        if (prepared) {
          stmt.insertVersion.run(id, version, prepared.entry, format, publishedBy, time);
          for (const f of stored) {
            stmt.insertFile.run(id, version, f.path, f.bytes.byteLength, f.contentType, f.sha256);
          }
        }
        return { id, version, title: newTitle, url: `${appOrigin}/a/${id}` };
      });
    },

    async get(id, version) {
      const artifact = findArtifact(id);
      if (!artifact) return null;
      const row = stmt.version.get(id, version ?? artifact.latest_version) as
        | VersionRow
        | undefined;
      if (!row) return null;
      const files = (stmt.files.all(id, row.version) as FileRow[]).map(toFile);
      return { artifact: toArtifact(artifact), version: toVersion(row, files) };
    },

    async readFile(id, version, path) {
      const row = stmt.file.get(id, version, path) as FileRow | undefined;
      if (!row) return null;
      return { bytes: await blobs.read(row.sha256), contentType: row.content_type };
    },

    async list(query = {}) {
      const requested = Math.trunc(Number(query.limit ?? 20));
      const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 20;
      const [after, afterId] = query.cursor ? decodeCursor(query.cursor) : [null, null];
      const format = query.format ?? null;
      const rows = stmt.list.all(format, format, after, after, afterId, limit + 1) as ArtifactRow[];
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toArtifact),
        nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
      };
    },

    async listVersions(id) {
      if (!findArtifact(id)) return null;
      const filesByVersion = new Map<number, FileInfo[]>();
      for (const row of stmt.allFiles.all(id) as FileRow[]) {
        const list = filesByVersion.get(row.version) ?? [];
        list.push(toFile(row));
        filesByVersion.set(row.version, list);
      }
      return (stmt.versions.all(id) as VersionRow[]).map((row) =>
        toVersion(row, filesByVersion.get(row.version) ?? []),
      );
    },

    async delete(id) {
      return stmt.delete.run(now(), id).changes > 0;
    },
  };
}
