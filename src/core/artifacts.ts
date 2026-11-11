import { isUtf8 } from 'node:buffer';
import type { DatabaseSync } from 'node:sqlite';
import {
  AppError,
  type Artifact,
  type ArtifactService,
  type Capabilities,
  type Edit,
  type FileInfo,
  type Format,
  LIMITS,
  type PublishInput,
  type Version,
} from '../contracts.ts';
import type { BlobStore } from './blobs.ts';
import { transaction } from './db.ts';
import { applyEdits, checkEditsInput } from './edits.ts';
import { hasContent, prepareVersion } from './files.ts';
import { now, randomId } from './ids.ts';
import { createSearchIndex } from './search.ts';

const EDITABLE: readonly Format[] = ['html', 'markdown', 'code'];

type NewVersion = { entry: string; format: Format; files: FileInfo[] };

export type ArtifactRow = {
  id: string;
  title: string;
  description: string;
  format: string;
  latest_version: number;
  capabilities: string;
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
  capabilities: parseCapabilities(row.capabilities),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function parseCapabilities(json: string): Capabilities {
  const value = JSON.parse(json) as Partial<Capabilities>;
  return { db: value.db === true, viewer: value.viewer === true };
}

function cleanCapabilities(input: unknown): Capabilities | undefined {
  if (input === undefined) return undefined;
  const valid =
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.entries(input).every(
      ([key, value]) => (key === 'db' || key === 'viewer') && typeof value === 'boolean',
    );
  if (!valid) {
    throw new AppError('invalid_input', 'capabilities is { db?: boolean, viewer?: boolean }');
  }
  const given = input as Partial<Capabilities>;
  return { db: given.db === true, viewer: given.viewer === true };
}

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

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset)).toString('base64url');
}

function decodeOffset(cursor: string): number {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (/^\d{1,9}$/.test(text)) return Number(text);
  throw new AppError('invalid_input', 'Invalid cursor');
}

function pageLimit(limit: number | undefined): number {
  const requested = Math.trunc(Number(limit ?? 20));
  return Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 20;
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
      `INSERT INTO artifacts (id, title, description, format, latest_version, capabilities, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateArtifact: db.prepare(
      `UPDATE artifacts SET title = ?, description = ?, format = ?, latest_version = ?, capabilities = ?,
       updated_at = ? WHERE id = ?`,
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
    undelete: db.prepare(
      'UPDATE artifacts SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL',
    ),
    deleted: db.prepare(
      'SELECT * FROM artifacts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC',
    ),
    copyFiles: db.prepare(
      `INSERT INTO version_files (artifact_id, version, path, size, content_type, sha256)
       SELECT artifact_id, ?, path, size, content_type, sha256 FROM version_files
       WHERE artifact_id = ? AND version = ?`,
    ),
  };

  const index = createSearchIndex(db, blobs);
  const findArtifact = (id: string) => stmt.artifact.get(id) as ArtifactRow | undefined;

  const insertVersion = (id: string, version: number, v: NewVersion, by: string, time: string) => {
    stmt.insertVersion.run(id, version, v.entry, v.format, by, time);
    for (const f of v.files) {
      stmt.insertFile.run(id, version, f.path, f.size, f.contentType, f.sha256);
    }
  };

  /** Runs inside the publish transaction, so the edits apply to the version that is latest now. */
  const editLatest = (artifact: ArtifactRow, edits: Edit[]): NewVersion => {
    const latest = stmt.version.get(artifact.id, artifact.latest_version) as VersionRow;
    const format = latest.format as Format;
    if (!EDITABLE.includes(format)) {
      throw new AppError(
        'invalid_input',
        `edits only work on html, markdown and code, not ${format}`,
      );
    }
    const files = (stmt.files.all(artifact.id, latest.version) as FileRow[]).map(toFile);
    const entry = files.find((f) => f.path === latest.entry);
    if (!entry) throw new Error(`Entry ${latest.entry} of ${artifact.id} has no file`);
    const bytes = blobs.readSync(entry.sha256);
    if (!isUtf8(bytes)) {
      throw new AppError('invalid_input', `edits need a UTF-8 text entry file`);
    }
    const edited = new TextEncoder().encode(applyEdits(new TextDecoder().decode(bytes), edits));
    if (edited.byteLength > LIMITS.fileBytes) {
      throw new AppError('too_large', `${entry.path} is larger than ${LIMITS.fileBytes} bytes`);
    }
    const replaced = { ...entry, size: edited.byteLength, sha256: blobs.putSync(edited) };
    return {
      entry: latest.entry,
      format,
      files: files.map((f) => (f.path === entry.path ? replaced : f)),
    };
  };

  return {
    async publish(input: PublishInput, publishedBy: string) {
      const title = cleanTitle(input.title);
      const description = input.description === undefined ? undefined : String(input.description);
      const capabilities = cleanCapabilities(input.capabilities);
      const edits = input.edits === undefined ? undefined : checkEditsInput(input);
      const prepared = !edits && hasContent(input) ? prepareVersion(input) : null;

      if (input.id === undefined) {
        if (!title) throw new AppError('invalid_input', 'title is required for a new artifact');
        if (!prepared) {
          throw new AppError('invalid_input', 'Give content (with format) or files');
        }
      } else if (!findArtifact(input.id)) {
        // Checked before writing blobs so a bad id leaves nothing behind; checked again below.
        throw new AppError('not_found', `Artifact ${input.id} not found`);
      }

      const stored: NewVersion | null = prepared
        ? {
            entry: prepared.entry,
            format: prepared.format,
            files: await Promise.all(
              prepared.files.map(async (f) => ({
                path: f.path,
                size: f.bytes.byteLength,
                contentType: f.contentType,
                sha256: await blobs.put(f.bytes),
              })),
            ),
          }
        : null;

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
        const next = edits && existing ? editLatest(existing, edits) : stored;
        const version = next
          ? (existing?.latest_version ?? 0) + 1
          : (existing?.latest_version ?? 0);
        const newTitle = title ?? existing?.title ?? '';
        const format = next?.format ?? (existing?.format as Format);
        const caps = JSON.stringify(
          capabilities ?? parseCapabilities(existing?.capabilities ?? '{}'),
        );

        if (existing) {
          stmt.updateArtifact.run(
            newTitle,
            description ?? existing.description,
            format,
            version,
            caps,
            time,
            id,
          );
        } else {
          stmt.insertArtifact.run(
            id,
            newTitle,
            description ?? '',
            format,
            version,
            caps,
            time,
            time,
          );
        }
        if (next) insertVersion(id, version, next, publishedBy, time);
        index.reindexArtifact(id);
        return { id, version, title: newTitle, url: `${appOrigin}/a/${id}` };
      });
    },

    async restoreVersion(id, version, publishedBy) {
      return transaction(db, () => {
        const existing = findArtifact(id);
        const old = existing && (stmt.version.get(id, version) as VersionRow | undefined);
        if (!existing || !old) {
          throw new AppError('not_found', `Version ${version} of artifact ${id} not found`, {
            id,
            version,
          });
        }
        const time = now();
        const next = existing.latest_version + 1;
        stmt.updateArtifact.run(
          existing.title,
          existing.description,
          old.format,
          next,
          existing.capabilities,
          time,
          id,
        );
        // Only rows are copied: the new version points at the same blobs.
        stmt.insertVersion.run(
          id,
          next,
          old.entry,
          old.format,
          `${publishedBy} (restored v${version})`,
          time,
        );
        stmt.copyFiles.run(next, id, version);
        index.reindexArtifact(id);
        return { id, version: next, title: existing.title, url: `${appOrigin}/a/${id}` };
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
      const limit = pageLimit(query.limit);
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

    async search(query) {
      const limit = pageLimit(query.limit);
      const offset = query.cursor ? decodeOffset(query.cursor) : 0;
      const rows = index.search(String(query.query ?? ''), limit + 1, offset);
      return {
        items: rows
          .slice(0, limit)
          .map((row) => ({ artifact: toArtifact(row), snippet: row.snippet })),
        nextCursor: rows.length > limit ? encodeOffset(offset + limit) : null,
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
      return transaction(db, () => {
        const deleted = stmt.delete.run(now(), id).changes > 0;
        if (deleted) index.reindexArtifact(id);
        return deleted;
      });
    },

    async undelete(id) {
      return transaction(db, () => {
        const undeleted = stmt.undelete.run(id).changes > 0;
        if (undeleted) index.reindexArtifact(id);
        return undeleted;
      });
    },

    async listDeleted() {
      return (stmt.deleted.all() as (ArtifactRow & { deleted_at: string })[]).map((row) => ({
        ...toArtifact(row),
        deletedAt: row.deleted_at,
      }));
    },
  };
}
