import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SESSION_TOUCH_MS, SESSION_TTL_MS, type SessionService } from '../contracts.ts';
import { sha256Hex } from './ids.ts';

type Row = {
  token_hash: string;
  user_email: string;
  credential: string;
  last_used_at: string;
  expires_at: string;
};

/** A token is 32 random bytes in base64url: 43 characters. Anything else is not looked up. */
const TOKEN_LENGTH = 43;

const iso = (time: number) => new Date(time).toISOString();

export function createSessionService(
  db: DatabaseSync,
): SessionService & { purge(now?: number): number } {
  const stmt = {
    insert: db.prepare(
      'INSERT INTO sessions (token_hash, user_email, credential, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    byHash: db.prepare(
      'SELECT token_hash, user_email, credential, last_used_at, expires_at FROM sessions WHERE token_hash = ?',
    ),
    touch: db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?'),
    delete: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  };

  return {
    async create(email, credential, now = Date.now()) {
      // Always a new token: signing in never reuses or adopts an existing one.
      const token = randomBytes(32).toString('base64url');
      stmt.insert.run(
        sha256Hex(token),
        email,
        credential,
        iso(now),
        iso(now),
        iso(now + SESSION_TTL_MS),
      );
      return { token, maxAgeSeconds: SESSION_TTL_MS / 1000 };
    },

    async verify(token, credentialOf, now = Date.now()) {
      if (typeof token !== 'string' || token.length !== TOKEN_LENGTH) return null;
      const hash = sha256Hex(token);
      const row = stmt.byHash.get(hash) as Row | undefined;
      // The lookup is by hash, so timing reveals nothing about the token; compare anyway.
      if (!row || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) return null;

      const current = credentialOf(row.user_email);
      if (row.expires_at <= iso(now) || current === null || current !== row.credential) {
        // Expired, or the account is gone, or its password changed: the row is of no use.
        stmt.delete.run(hash);
        return null;
      }

      // Slide the expiry, but write at most once an hour.
      if (now - Date.parse(row.last_used_at) > SESSION_TOUCH_MS) {
        stmt.touch.run(iso(now), iso(now + SESSION_TTL_MS), hash);
        return { email: row.user_email, renewed: true, maxAgeSeconds: SESSION_TTL_MS / 1000 };
      }
      return { email: row.user_email, renewed: false, maxAgeSeconds: SESSION_TTL_MS / 1000 };
    },

    async destroy(token) {
      if (typeof token !== 'string' || token.length !== TOKEN_LENGTH) return;
      stmt.delete.run(sha256Hex(token));
    },

    purge(now = Date.now()) {
      return Number(stmt.purge.run(iso(now)).changes);
    },
  };
}
