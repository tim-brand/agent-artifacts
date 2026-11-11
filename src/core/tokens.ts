import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, type TokenInfo, type TokenService } from '../contracts.ts';
import { now, randomId, sha256Hex } from './ids.ts';

type TokenRow = {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
};

const toInfo = (row: TokenRow): TokenInfo => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

/** Writing last_used_at on every MCP request is pointless churn; once a minute is plenty. */
const TOUCH_INTERVAL_MS = 60_000;

export function createTokenService(db: DatabaseSync): TokenService {
  const stmt = {
    insert: db.prepare('INSERT INTO tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)'),
    list: db.prepare('SELECT * FROM tokens WHERE revoked_at IS NULL ORDER BY created_at DESC'),
    revoke: db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    byHash: db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND revoked_at IS NULL'),
    touch: db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?'),
  };

  return {
    async create(name) {
      const clean = String(name ?? '').trim();
      if (!clean) throw new AppError('invalid_input', 'Token name must not be empty');
      const token = `aa_${randomBytes(32).toString('base64url')}`;
      const row: TokenRow = {
        id: randomId(),
        name: clean,
        token_hash: sha256Hex(token),
        created_at: now(),
        last_used_at: null,
      };
      stmt.insert.run(row.id, row.name, row.token_hash, row.created_at);
      return { token, info: toInfo(row) };
    },

    async list() {
      return (stmt.list.all() as TokenRow[]).map(toInfo);
    },

    async revoke(id) {
      return stmt.revoke.run(now(), id).changes > 0;
    },

    async verify(token) {
      if (typeof token !== 'string' || !token.startsWith('aa_')) return null;
      const hash = sha256Hex(token);
      const row = stmt.byHash.get(hash) as TokenRow | undefined;
      // The lookup is by hash, so timing reveals nothing about the token; compare anyway.
      if (!row || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) return null;

      const time = now();
      if (
        !row.last_used_at ||
        Date.parse(time) - Date.parse(row.last_used_at) >= TOUCH_INTERVAL_MS
      ) {
        stmt.touch.run(time, row.id);
        row.last_used_at = time;
      }
      return toInfo(row);
    },
  };
}
