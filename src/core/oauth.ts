import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AuthorizeCheck,
  type OAuthClient,
  OAuthError,
  type OAuthErrorCode,
  type OAuthGrant,
  type OAuthService,
  type OAuthTokens,
} from '../contracts.ts';
import {
  cleanClientName,
  isMcpResource,
  isPkceValue,
  mcpResource,
  OAUTH_LIMITS,
  OAUTH_TTL,
  pkceMatches,
  redirectUriMatches,
  redirectUriProblem,
  safeEqual,
} from '../oauth/rules.ts';
import { transaction } from './db.ts';
import { randomId, sha256Hex } from './ids.ts';

type ClientRow = {
  id: string;
  name: string;
  redirect_uris: string;
  created_at: string;
  last_used_at: string;
};

type GrantRow = {
  id: string;
  client_id: string;
  user_email: string;
  resource: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
};

type CodeRow = {
  code_hash: string;
  client_id: string;
  user_email: string;
  redirect_uri: string | null;
  code_challenge: string;
  resource: string;
  scope: string;
  expires_at: string;
  used_at: string | null;
  grant_id: string | null;
};

type TokenRow = {
  token_hash: string;
  grant_id: string;
  kind: 'access' | 'refresh';
  expires_at: string;
  used_at: string | null;
};

const toClient = (row: ClientRow): OAuthClient => ({
  id: row.id,
  name: row.name,
  redirectUris: JSON.parse(row.redirect_uris) as string[],
  createdAt: row.created_at,
});

/** Opaque secrets with a prefix that tells them apart: code, access token, refresh token. */
const secret = (prefix: 'aac_' | 'aat_' | 'aar_') =>
  `${prefix}${randomBytes(32).toString('base64url')}`;

/** Writing last_used_at on every MCP request is pointless churn; once a minute is plenty. */
const TOUCH_INTERVAL_MS = 60_000;
/** Used codes are kept a day past their expiry, so a late replay still revokes the grant. */
const USED_CODE_KEEP_MS = 24 * 60 * 60 * 1000;

const invalidGrant = (description: string) => new OAuthError('invalid_grant', description);

export function createOAuthService(
  db: DatabaseSync,
  appOrigin: string,
  clock: () => number = Date.now,
): OAuthService & { purge(now?: number): number } {
  const iso = (offsetMs = 0) => new Date(clock() + offsetMs).toISOString();
  const resource = mcpResource(appOrigin);

  const stmt = {
    insertClient: db.prepare(
      'INSERT INTO oauth_clients (id, name, redirect_uris, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
    ),
    client: db.prepare('SELECT * FROM oauth_clients WHERE id = ?'),
    touchClient: db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?'),
    insertCode: db.prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, user_email, redirect_uri, code_challenge, resource, scope, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    code: db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?'),
    useCode: db.prepare(
      'UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
    ),
    codeGrant: db.prepare('UPDATE oauth_codes SET grant_id = ? WHERE code_hash = ?'),
    insertGrant: db.prepare(
      `INSERT INTO oauth_grants (id, client_id, user_email, resource, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    grant: db.prepare('SELECT * FROM oauth_grants WHERE id = ?'),
    liveGrantsOf: db.prepare(
      'SELECT id FROM oauth_grants WHERE client_id = ? AND user_email = ? AND revoked_at IS NULL',
    ),
    extendGrant: db.prepare('UPDATE oauth_grants SET expires_at = ? WHERE id = ?'),
    touchGrant: db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?'),
    revokeGrant: db.prepare(
      'UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    ),
    deleteTokensOf: db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?'),
    listGrants: db.prepare(
      `SELECT g.*, c.name AS client_name FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
       WHERE g.revoked_at IS NULL AND g.expires_at > ? ORDER BY g.created_at DESC, g.id DESC`,
    ),
    insertToken: db.prepare(
      'INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, ?, ?, ?)',
    ),
    token: db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = ?'),
    useToken: db.prepare(
      'UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
    ),
    access: db.prepare(
      `SELECT t.token_hash, t.expires_at, g.id AS grant_id, g.resource, g.user_email, g.last_used_at,
              g.client_id, c.name AS client_name
       FROM oauth_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id AND g.revoked_at IS NULL
       JOIN oauth_clients c ON c.id = g.client_id
       WHERE t.token_hash = ? AND t.kind = 'access'`,
    ),
    purgeCodes: db.prepare(
      'DELETE FROM oauth_codes WHERE expires_at < ? AND (used_at IS NULL OR expires_at < ?)',
    ),
    purgeTokens: db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?'),
    purgeGrants: db.prepare(
      'DELETE FROM oauth_grants WHERE revoked_at IS NOT NULL OR expires_at < ?',
    ),
    purgeClients: db.prepare(
      `DELETE FROM oauth_clients WHERE last_used_at < ?
       AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)`,
    ),
  };

  const getClient = (id: string) => {
    const row = stmt.client.get(id) as ClientRow | undefined;
    return row ? toClient(row) : null;
  };

  const revoke = (grantId: string) => {
    const changed = stmt.revokeGrant.run(iso(), grantId).changes > 0;
    stmt.deleteTokensOf.run(grantId);
    return changed;
  };

  /** A fresh access and refresh token for a grant; the grant lives as long as its refresh token. */
  const issue = (grantId: string, scope: string): OAuthTokens => {
    const accessToken = secret('aat_');
    const refreshToken = secret('aar_');
    const refreshExpires = iso(OAUTH_TTL.refreshSeconds * 1000);
    stmt.insertToken.run(
      sha256Hex(accessToken),
      grantId,
      'access',
      iso(OAUTH_TTL.accessSeconds * 1000),
    );
    stmt.insertToken.run(sha256Hex(refreshToken), grantId, 'refresh', refreshExpires);
    stmt.extendGrant.run(refreshExpires, grantId);
    return { accessToken, refreshToken, expiresIn: OAUTH_TTL.accessSeconds, scope };
  };

  /** Throws OAuthError after the transaction committed, so a burned code or a revoke sticks. */
  const settle = <T>(fn: () => T | OAuthError): T => {
    const result = transaction(db, fn);
    if (result instanceof OAuthError) throw result;
    return result;
  };

  return {
    async register({ clientName, redirectUris }) {
      if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
        throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list at least one URI');
      }
      if (redirectUris.length > OAUTH_LIMITS.redirectUris) {
        throw new OAuthError(
          'invalid_redirect_uri',
          `redirect_uris may list at most ${OAUTH_LIMITS.redirectUris} URIs`,
        );
      }
      for (const uri of redirectUris) {
        const problem = redirectUriProblem(uri);
        if (problem) throw new OAuthError('invalid_redirect_uri', problem);
      }
      const uris = [...new Set(redirectUris as string[])];
      const time = iso();
      const row: ClientRow = {
        id: randomId(24),
        name: cleanClientName(clientName),
        redirect_uris: JSON.stringify(uris),
        created_at: time,
        last_used_at: time,
      };
      stmt.insertClient.run(row.id, row.name, row.redirect_uris, row.created_at, row.last_used_at);
      return toClient(row);
    },

    async getClient(id) {
      return typeof id === 'string' && id ? getClient(id) : null;
    },

    async checkAuthorize(p): Promise<AuthorizeCheck> {
      const noRedirect = (description: string): AuthorizeCheck => ({
        ok: false,
        redirect: null,
        error: 'invalid_request',
        description,
      });
      if (!p.client_id) return noRedirect('The request has no client_id.');
      const client = getClient(p.client_id);
      if (!client) {
        return noRedirect(
          'This app is not registered here, or its registration expired. Connect it again from the app.',
        );
      }

      let redirectUri: string;
      if (p.redirect_uri) {
        const given = p.redirect_uri;
        if (
          redirectUriProblem(given) ||
          !client.redirectUris.some((r) => redirectUriMatches(r, given))
        ) {
          return noRedirect('The redirect_uri does not match the ones this app registered.');
        }
        redirectUri = given;
      } else if (client.redirectUris.length === 1 && client.redirectUris[0]) {
        redirectUri = client.redirectUris[0];
      } else {
        return noRedirect('The request has no redirect_uri.');
      }

      const stateOk = !p.state || p.state.length <= OAUTH_LIMITS.state;
      const state = p.state && stateOk ? p.state : null;
      const back = (error: OAuthErrorCode, description: string): AuthorizeCheck => ({
        ok: false,
        redirect: redirectUri,
        state,
        error,
        description,
      });
      if (!stateOk) return back('invalid_request', 'state is too long');
      if (p.response_type !== 'code') {
        return back('unsupported_response_type', 'response_type must be code');
      }
      if (!p.code_challenge) {
        return back('invalid_request', 'code_challenge is required: use PKCE with S256');
      }
      if (p.code_challenge_method !== 'S256') {
        return back('invalid_request', 'code_challenge_method must be S256');
      }
      if (!isPkceValue(p.code_challenge)) {
        return back('invalid_request', 'code_challenge is not a valid S256 challenge');
      }
      if (p.resource !== undefined && !isMcpResource(p.resource, appOrigin)) {
        return back('invalid_target', `resource must be ${resource}`);
      }
      const scope = p.scope ?? '';
      if (scope.length > OAUTH_LIMITS.scope) return back('invalid_scope', 'scope is too long');

      return {
        ok: true,
        request: {
          client,
          redirectUri,
          redirectUriGiven: Boolean(p.redirect_uri),
          codeChallenge: p.code_challenge,
          state,
          resource,
          scope,
        },
      };
    },

    async createCode(request, user) {
      const code = secret('aac_');
      const time = iso();
      stmt.insertCode.run(
        sha256Hex(code),
        request.client.id,
        user,
        request.redirectUriGiven ? request.redirectUri : null,
        request.codeChallenge,
        request.resource,
        request.scope,
        iso(OAUTH_TTL.codeSeconds * 1000),
      );
      stmt.touchClient.run(time, request.client.id);
      return code;
    },

    async exchangeCode(input) {
      if (typeof input.code !== 'string' || !input.code) {
        throw new OAuthError('invalid_request', 'code is missing');
      }
      if (typeof input.codeVerifier !== 'string' || !input.codeVerifier) {
        throw new OAuthError('invalid_request', 'code_verifier is missing: PKCE is required');
      }
      const hash = sha256Hex(input.code);
      return settle(() => {
        const row = stmt.code.get(hash) as CodeRow | undefined;
        if (!row || !safeEqual(row.code_hash, hash)) return invalidGrant('Unknown code');
        // Single use: whatever happens next, this code is spent. A second use means it leaked,
        // so the grant it made is revoked (OAuth 2.1 4.1.3).
        if (row.used_at || stmt.useCode.run(iso(), hash).changes === 0) {
          if (row.grant_id) revoke(row.grant_id);
          return invalidGrant('The code was already used');
        }
        if (row.expires_at <= iso()) return invalidGrant('The code expired');
        if (row.client_id !== input.clientId) return invalidGrant('The code is for another client');
        if (row.redirect_uri !== null && row.redirect_uri !== input.redirectUri) {
          return invalidGrant('redirect_uri does not match the authorization request');
        }
        if (input.redirectUri !== undefined && row.redirect_uri === null) {
          const client = getClient(row.client_id);
          if (!client?.redirectUris.includes(input.redirectUri)) {
            return invalidGrant('redirect_uri does not match the authorization request');
          }
        }
        if (!pkceMatches(row.code_challenge, input.codeVerifier as string)) {
          return invalidGrant('code_verifier does not match the code_challenge');
        }
        if (input.resource !== undefined && !isMcpResource(input.resource, appOrigin)) {
          return new OAuthError('invalid_target', `resource must be ${row.resource}`);
        }

        // Signing in again replaces the client's earlier sign-in by this user.
        for (const old of stmt.liveGrantsOf.all(row.client_id, row.user_email) as {
          id: string;
        }[]) {
          revoke(old.id);
        }
        const grantId = randomId(16);
        const time = iso();
        stmt.insertGrant.run(
          grantId,
          row.client_id,
          row.user_email,
          row.resource,
          row.scope,
          time,
          time,
        );
        stmt.codeGrant.run(grantId, hash);
        stmt.touchClient.run(time, row.client_id);
        return issue(grantId, row.scope);
      });
    },

    async refresh(input) {
      if (typeof input.refreshToken !== 'string' || !input.refreshToken) {
        throw new OAuthError('invalid_request', 'refresh_token is missing');
      }
      const hash = sha256Hex(input.refreshToken);
      return settle(() => {
        const row = stmt.token.get(hash, 'refresh') as TokenRow | undefined;
        if (!row || !safeEqual(row.token_hash, hash)) return invalidGrant('Unknown refresh token');
        const grant = stmt.grant.get(row.grant_id) as GrantRow | undefined;
        if (!grant || grant.revoked_at) return invalidGrant('The grant was revoked');
        if (grant.client_id !== input.clientId) {
          return invalidGrant('The refresh token is for another client');
        }
        // Rotation: a refresh token works once. Seeing a rotated one again means it leaked, and
        // either side may hold the newer one, so the whole grant goes.
        if (row.used_at || stmt.useToken.run(iso(), hash).changes === 0) {
          revoke(grant.id);
          return invalidGrant('The refresh token was already used; sign in again');
        }
        if (row.expires_at <= iso()) return invalidGrant('The refresh token expired');
        if (input.resource !== undefined && !isMcpResource(input.resource, appOrigin)) {
          return new OAuthError('invalid_target', `resource must be ${grant.resource}`);
        }
        stmt.touchClient.run(iso(), grant.client_id);
        return issue(grant.id, grant.scope);
      });
    },

    async verifyAccess(token, expected) {
      if (typeof token !== 'string' || !token.startsWith('aat_')) return null;
      const hash = sha256Hex(token);
      const row = stmt.access.get(hash) as
        | {
            token_hash: string;
            expires_at: string;
            grant_id: string;
            resource: string;
            user_email: string;
            last_used_at: string | null;
            client_id: string;
            client_name: string;
          }
        | undefined;
      // The lookup is by hash, so timing reveals nothing about the token; compare anyway.
      if (!row || !safeEqual(row.token_hash, hash)) return null;
      const time = iso();
      if (row.expires_at <= time) return null;
      // Audience (RFC 8707): only tokens issued for this resource.
      if (row.resource !== expected) return null;
      if (
        !row.last_used_at ||
        Date.parse(time) - Date.parse(row.last_used_at) >= TOUCH_INTERVAL_MS
      ) {
        stmt.touchGrant.run(time, row.grant_id);
        stmt.touchClient.run(time, row.client_id);
      }
      return { grantId: row.grant_id, clientName: row.client_name, user: row.user_email };
    },

    async listGrants() {
      const rows = stmt.listGrants.all(iso()) as (GrantRow & { client_name: string })[];
      return rows.map(
        (row): OAuthGrant => ({
          id: row.id,
          clientId: row.client_id,
          clientName: row.client_name,
          user: row.user_email,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
          expiresAt: row.expires_at,
        }),
      );
    },

    async revokeGrant(id) {
      return transaction(db, () => revoke(id));
    },

    /** Drops expired codes and tokens, ended grants and clients unused for 30 days. */
    purge(now = clock()) {
      const at = new Date(now).toISOString();
      const keepUsed = new Date(now - USED_CODE_KEEP_MS).toISOString();
      const unused = new Date(now - OAUTH_TTL.unusedClientDays * 86_400_000).toISOString();
      return transaction(db, () => {
        return [
          stmt.purgeCodes.run(at, keepUsed),
          stmt.purgeTokens.run(at),
          stmt.purgeGrants.run(at),
          stmt.purgeClients.run(unused),
        ].reduce((sum, r) => sum + Number(r.changes), 0);
      });
    },
  };
}
