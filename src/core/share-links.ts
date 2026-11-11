import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, type ShareLink, type ShareLinkService } from '../contracts.ts';
import { now, randomId, sha256Hex } from './ids.ts';

type ShareLinkRow = {
  id: string;
  artifact_id: string;
  version: number | null;
  token_hash: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
};

const toLink = (row: ShareLinkRow): ShareLink => ({
  id: row.id,
  artifactId: row.artifact_id,
  version: row.version,
  label: row.label,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
});

const MAX_LABEL = 100;
/** Every file of a shared page resolves the token; recording each use would be pointless churn. */
const TOUCH_INTERVAL_MS = 60_000;

export function createShareLinkService(db: DatabaseSync): ShareLinkService {
  const stmt = {
    artifact: db.prepare('SELECT 1 FROM artifacts WHERE id = ? AND deleted_at IS NULL'),
    version: db.prepare('SELECT 1 FROM versions WHERE artifact_id = ? AND version = ?'),
    insert: db.prepare(
      `INSERT INTO share_links (id, artifact_id, version, token_hash, label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    list: db.prepare(
      `SELECT * FROM share_links WHERE artifact_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC, rowid DESC`,
    ),
    listAll: db.prepare(
      `SELECT s.* FROM share_links s JOIN artifacts a ON a.id = s.artifact_id
       WHERE s.revoked_at IS NULL AND a.deleted_at IS NULL
       ORDER BY s.created_at DESC, s.rowid DESC`,
    ),
    revoke: db.prepare(
      `UPDATE share_links SET revoked_at = ?
       WHERE id = ? AND artifact_id = ? AND revoked_at IS NULL`,
    ),
    // Deleted is checked here, not stored on the link, so undeleting an artifact brings its links back.
    byHash: db.prepare(
      `SELECT s.*, a.latest_version FROM share_links s JOIN artifacts a ON a.id = s.artifact_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND a.deleted_at IS NULL`,
    ),
    touch: db.prepare('UPDATE share_links SET last_used_at = ? WHERE id = ?'),
  };

  return {
    async create(artifactId, input = {}) {
      if (!stmt.artifact.get(artifactId)) {
        throw new AppError('not_found', `Artifact ${artifactId} not found`);
      }
      const version = input.version ?? null;
      if (version !== null && !stmt.version.get(artifactId, version)) {
        throw new AppError('not_found', `Version ${version} of artifact ${artifactId} not found`);
      }
      const label = String(input.label ?? '').trim();
      if (label.length > MAX_LABEL) {
        throw new AppError('invalid_input', `The label can be at most ${MAX_LABEL} characters`);
      }
      const time = now();
      let expiresAt: string | null = null;
      if (input.expiresAt !== undefined) {
        const ms = Date.parse(input.expiresAt);
        if (Number.isNaN(ms) || ms <= Date.parse(time)) {
          throw new AppError('invalid_input', 'expiresAt must be a time in the future');
        }
        expiresAt = new Date(ms).toISOString();
      }

      const token = `sl_${randomBytes(32).toString('base64url')}`;
      const row: ShareLinkRow = {
        id: randomId(),
        artifact_id: artifactId,
        version,
        token_hash: sha256Hex(token),
        label,
        created_at: time,
        expires_at: expiresAt,
        last_used_at: null,
      };
      stmt.insert.run(row.id, artifactId, version, row.token_hash, label, time, expiresAt);
      return { token, link: toLink(row) };
    },

    async list(artifactId) {
      if (artifactId === undefined) return (stmt.listAll.all() as ShareLinkRow[]).map(toLink);
      if (!stmt.artifact.get(artifactId)) return null;
      return (stmt.list.all(artifactId) as ShareLinkRow[]).map(toLink);
    },

    async revoke(artifactId, id) {
      return stmt.revoke.run(now(), id, artifactId).changes > 0;
    },

    async resolve(token) {
      if (typeof token !== 'string' || !token.startsWith('sl_')) return null;
      const hash = sha256Hex(token);
      const row = stmt.byHash.get(hash) as (ShareLinkRow & { latest_version: number }) | undefined;
      // The lookup is by hash, so timing reveals nothing about the token; compare anyway.
      if (!row || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) return null;

      const time = now();
      if (row.expires_at && Date.parse(row.expires_at) <= Date.parse(time)) return null;
      if (
        !row.last_used_at ||
        Date.parse(time) - Date.parse(row.last_used_at) >= TOUCH_INTERVAL_MS
      ) {
        stmt.touch.run(time, row.id);
        row.last_used_at = time;
      }
      return { link: toLink(row), version: row.version ?? row.latest_version };
    },
  };
}
