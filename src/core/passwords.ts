import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashes for the built-in sign-in. scrypt from node:crypto, the async form: the sync one
 * would block the whole server for the 50 to 100 ms a hash takes.
 *
 * Text format, with no `$`, `,`, `:` or white space, so it needs no quoting in a .env file and
 * cannot clash with the separators of AUTH_USERS:
 *
 *   scrypt.<log2 N>.<r>.<p>.<salt, base64url>.<key, base64url>
 */

const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** The cost of a new hash: 32 MiB of memory and about 100 ms of CPU. */
export const DEFAULT_COST = { logN: 15, p: 3 } as const;
const R = 8;

/**
 * What a hash in the settings may ask for. A hash outside this can never make a request use absurd
 * memory or time: 2^18 * 8 * 128 bytes is 256 MiB.
 */
const BOUNDS = { logN: [14, 18], p: [1, 16] } as const;

/** The longest password accepted. Longer ones are refused before any hashing. */
export const MAX_PASSWORD_LENGTH = 1024;

export type ScryptParams = { logN: number; r: number; p: number };
export type ParsedHash = ScryptParams & { salt: Buffer; key: Buffer };

/** A cost for hashing; only tests pass one (the default is DEFAULT_COST). */
export type Cost = { logN?: number; p?: number };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.logN;
  return new Promise((resolve, reject) => {
    scrypt(
      password, // exactly as typed: no trimming, no normalization, no case change
      salt,
      KEY_BYTES,
      // maxmem: scrypt needs about 128 * r * (N + p + 2) bytes; double it for headroom.
      { N, r: params.r, p: params.p, maxmem: 256 * params.r * (N + params.p + 2) },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** A new hash of the password, in the text format above. */
export async function hashPassword(password: string, cost: Cost = {}): Promise<string> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const params = { logN: cost.logN ?? DEFAULT_COST.logN, r: R, p: cost.p ?? DEFAULT_COST.p };
  if (!checkParams(params)) throw new Error('The scrypt cost is outside the allowed bounds');
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `scrypt.${params.logN}.${params.r}.${params.p}.${salt.toString('base64url')}.${key.toString('base64url')}`;
}

function checkParams(params: ScryptParams): boolean {
  return (
    Number.isInteger(params.logN) &&
    params.logN >= BOUNDS.logN[0] &&
    params.logN <= BOUNDS.logN[1] &&
    params.r === R &&
    Number.isInteger(params.p) &&
    params.p >= BOUNDS.p[0] &&
    params.p <= BOUNDS.p[1]
  );
}

/**
 * The parts of a hash, or null when the text is not a hash this module made or when its
 * parameters are outside the bounds.
 */
export function parsePasswordHash(text: string): ParsedHash | null {
  const parts = text.split('.');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, logN, r, p, salt, key] = parts as [string, string, string, string, string, string];
  // Plain decimal numbers of one or two digits, no leading zero.
  if (![logN, r, p].every((n) => /^[1-9]\d?$/.test(n))) return null;
  if (!BASE64URL.test(salt) || !BASE64URL.test(key)) return null;
  const params = { logN: Number(logN), r: Number(r), p: Number(p) };
  if (!checkParams(params)) return null;
  const saltBytes = Buffer.from(salt, 'base64url');
  const keyBytes = Buffer.from(key, 'base64url');
  // Reject text that is not the canonical encoding of the bytes (stray bits, bad length).
  if (saltBytes.toString('base64url') !== salt || keyBytes.toString('base64url') !== key) {
    return null;
  }
  if (saltBytes.length < SALT_BYTES || saltBytes.length > 64 || keyBytes.length !== KEY_BYTES) {
    return null;
  }
  return { ...params, salt: saltBytes, key: keyBytes };
}

/** Why a password is not acceptable, or null. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length === 0) return 'The password is empty';
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `The password is longer than ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

/** Does the password match the parsed hash? Constant-time comparison of the derived keys. */
export async function verifyAgainst(password: string, hash: ParsedHash): Promise<boolean> {
  const key = await derive(password, hash.salt, hash);
  return timingSafeEqual(key, hash.key);
}

export type PasswordChecker = {
  /**
   * 'ok' when the email is an account and the password is its password. 'wrong' for every other
   * case, an unknown email included: that one verifies against a dummy hash first, so it takes as
   * long. 'busy' when too many checks are already waiting; the password was not checked.
   */
  check(email: string, password: string): Promise<'ok' | 'wrong' | 'busy'>;
};

/** The hash that takes the longest to check: scrypt's time grows with N times p. */
export const mostExpensive = <T extends { logN: number; p: number }>(
  hashes: readonly T[],
): T | null =>
  hashes.reduce<T | null>(
    (most, hash) => (!most || 2 ** hash.logN * hash.p > 2 ** most.logN * most.p ? hash : most),
    null,
  );

/**
 * Checks passwords against the accounts, with at most `concurrency` scrypt runs at once (each uses
 * tens of MiB) and at most `waiting` more queued.
 */
export function createPasswordChecker(
  accounts: readonly { email: string; hash: string }[],
  opts: { concurrency?: number; waiting?: number; cost?: Cost } = {},
): PasswordChecker {
  const concurrency = opts.concurrency ?? 4;
  const maxWaiting = opts.waiting ?? 16;
  const parsed = new Map<string, ParsedHash>();
  for (const account of accounts) {
    const hash = parsePasswordHash(account.hash);
    if (!hash) throw new Error(`The password hash of account ${account.email} is not valid`);
    parsed.set(account.email, hash);
  }
  // Made once, with the cost of the most expensive configured hash, so an unknown email is never
  // quicker than a real account. (Accounts whose hashes differ in cost differ in time themselves;
  // the command always writes the same cost.)
  const costliest = mostExpensive([...parsed.values()]);
  const dummy = (async () => {
    const text = await hashPassword(randomBytes(16).toString('hex'), {
      logN: costliest?.logN ?? opts.cost?.logN,
      p: costliest?.p ?? opts.cost?.p,
    });
    return parsePasswordHash(text) as ParsedHash;
  })();
  // Don't let an unhandled rejection kill the process if the dummy fails; check() rethrows.
  dummy.catch(() => {});

  let running = 0;
  const queue: (() => void)[] = [];
  const acquire = async (): Promise<boolean> => {
    if (running < concurrency) {
      running++;
      return true;
    }
    if (queue.length >= maxWaiting) return false;
    await new Promise<void>((resolve) => queue.push(resolve));
    return true; // the releasing run handed its slot over
  };
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else running--;
  };

  return {
    async check(email, password) {
      if (passwordProblem(password)) return 'wrong';
      if (!(await acquire())) return 'busy';
      try {
        const account = parsed.get(email);
        const ok = await verifyAgainst(password, account ?? (await dummy));
        return account && ok ? 'ok' : 'wrong';
      } finally {
        release();
      }
    },
  };
}
