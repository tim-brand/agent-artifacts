import { parsePasswordHash } from './core/passwords.ts';

/** An account of the built-in sign-in: a lower-case email and its password hash text. */
export type AuthUser = { email: string; hash: string };

export type Config = {
  /**
   * How people sign in. 'proxy': a sign-in proxy in front of the app sends the identity header.
   * 'password': the app signs people in itself, with the accounts in `authUsers`.
   */
  authMode: 'proxy' | 'password';
  /** The accounts, in password mode only; empty in proxy mode. Contains password hashes: never log it. */
  authUsers: AuthUser[];
  port: number;
  /**
   * How many reverse proxies sit in front of the app and append to X-Forwarded-For. The rate limits
   * take the client address that many entries from the right. Default 1.
   */
  trustedProxies: number;
  /** SQLite file and artifact files live under here. */
  dataDir: string;
  /** The public origin of the app host, e.g. https://artifacts.example.com */
  appOrigin: string;
  /** The public origin of the content host, e.g. https://artifacts-content.example.com */
  contentOrigin: string;
  signingSecret: string;
  /** Local dev only: used as the signed-in user when no sign-in proxy header is present. */
  devUser: string | null;
  /**
   * The request header in which the sign-in proxy sends the user's email. There is no default: in
   * proxy mode it is null only when `devUser` is set (local development).
   */
  authEmailHeader: string | null;
  /** The request header with the user's display name. Null when not set: the email is shown. */
  authNameHeader: string | null;
};

/** A bad or missing setting. The server prints its message on one line and exits. */
export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

function origin(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  try {
    return new URL(value).origin;
  } catch {
    throw new ConfigError(`${name} must be an origin such as https://artifacts.example.com`);
  }
}

/** A header name, or null when the setting is empty. Every proxy names these differently, so there is no default. */
function headerName(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  if (!value) return null;
  if (!/^[A-Za-z0-9-]+$/.test(value)) {
    throw new ConfigError(`${name} must be an HTTP header name (letters, digits and - only)`);
  }
  return value;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Does the origin name this computer: localhost, *.localhost, 127.0.0.1 or [::1]? */
function isLoopbackOrigin(appOrigin: string): boolean {
  const host = new URL(appOrigin).hostname;
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

/** Local development: not production, and the app origin is a loopback name. */
export function isLocalDevelopment(env: NodeJS.ProcessEnv, appOrigin: string): boolean {
  if (env.NODE_ENV === 'production') return false;
  return isLoopbackOrigin(appOrigin);
}

/** An email is safe to show in an error only when it is short and cannot be a pasted hash. */
const shown = (email: string) =>
  email.length > 0 && email.length <= 254 && !email.startsWith('scrypt.') ? `"${email}"` : null;

/**
 * AUTH_USERS: `email:hash` entries separated by commas and/or white space. Errors name the entry's
 * position (and its email, when that is safe to print), and never print a hash.
 */
function parseUsers(text: string): AuthUser[] {
  const users: AuthUser[] = [];
  const seen = new Set<string>();
  const entries = text.split(/[\s,]+/).filter((entry) => entry !== '');
  for (const [index, entry] of entries.entries()) {
    const where = `AUTH_USERS entry ${index + 1}`;
    const colon = entry.indexOf(':');
    if (colon < 0) {
      throw new ConfigError(
        `${where} has no ":". Each entry is email:hash, made with: node src/hash-password.ts you@example.com`,
      );
    }
    const email = entry.slice(0, colon).toLowerCase();
    const hash = entry.slice(colon + 1);
    const name = shown(email);
    const label = name ? `${where} (${name})` : where;
    if (!email) throw new ConfigError(`${label} has no email before the ":"`);
    if (/[\s,:]/.test(email)) throw new ConfigError(`${label}: the email must not contain spaces`);
    // The sign-in form keeps at most this many characters, so a longer one could never sign in.
    if (email.length > 254) {
      throw new ConfigError(`${where}: the email is longer than 254 characters`);
    }
    if (!parsePasswordHash(hash)) {
      throw new ConfigError(
        `${label}: the password hash is not valid. Make the entry with: node src/hash-password.ts you@example.com`,
      );
    }
    if (seen.has(email)) throw new ConfigError(`${label}: this email is listed twice`);
    seen.add(email);
    users.push({ email, hash });
  }
  return users;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const signingSecret = required(env, 'SIGNING_SECRET');
  if (signingSecret.length < 32) {
    throw new ConfigError('SIGNING_SECRET must be at least 32 characters');
  }
  // An empty value means the default, as for every other setting. Number('') would be port 0.
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError('PORT must be a port number');
  }
  const trustedProxies = Number(env.TRUSTED_PROXIES || 1);
  if (!Number.isInteger(trustedProxies) || trustedProxies < 1 || trustedProxies > 32) {
    throw new ConfigError(
      'TRUSTED_PROXIES must be a whole number from 1 to 32: the number of reverse proxies in front of the app',
    );
  }

  const mode = env.AUTH_MODE || 'proxy';
  if (mode !== 'proxy' && mode !== 'password') {
    throw new ConfigError('AUTH_MODE must be proxy or password');
  }
  const usersText = env.AUTH_USERS ?? '';

  const config: Config = {
    authMode: mode,
    authUsers: mode === 'password' ? parseUsers(usersText) : [],
    port,
    trustedProxies,
    dataDir: env.DATA_DIR || './data',
    appOrigin: origin(env, 'APP_ORIGIN'),
    contentOrigin: origin(env, 'CONTENT_ORIGIN'),
    signingSecret,
    devUser: env.DEV_USER || null,
    authEmailHeader: headerName(env, 'AUTH_EMAIL_HEADER'),
    authNameHeader: headerName(env, 'AUTH_NAME_HEADER'),
  };

  if (mode === 'proxy' && usersText.trim() !== '') {
    throw new ConfigError(
      'AUTH_USERS is set, but AUTH_MODE is not password. Set AUTH_MODE=password to use the built-in sign-in, or remove AUTH_USERS',
    );
  }
  // Without the header nobody could sign in, and every page would say so. DEV_USER stands in for
  // the proxy in local development; outside it, DEV_USER is refused below.
  if (mode === 'proxy' && !config.authEmailHeader && !config.devUser) {
    throw new ConfigError(
      "AUTH_MODE is proxy (the default), but AUTH_EMAIL_HEADER is not set. Set it to the request header in which your sign-in proxy sends the user's email (docs/deployment.md lists the names for common proxies), or set AUTH_MODE=password to use the built-in sign-in",
    );
  }
  if (mode === 'password') {
    if (config.authUsers.length === 0) {
      throw new ConfigError(
        'AUTH_MODE is password, but AUTH_USERS holds no account. Make an entry with: node src/hash-password.ts you@example.com',
      );
    }
    if (config.devUser) {
      throw new ConfigError(
        'DEV_USER is set, but AUTH_MODE is password. DEV_USER would sign everyone in without a password: unset it',
      );
    }
    // The cookie of a session must not travel over plain HTTP. Loopback is the exception, and it
    // does not depend on NODE_ENV: the Docker image sets production, and people try it on localhost.
    if (!config.appOrigin.startsWith('https:') && !isLoopbackOrigin(config.appOrigin)) {
      throw new ConfigError(
        'AUTH_MODE is password, so APP_ORIGIN must be https (plain http is only allowed on localhost). Serve the app over HTTPS and set APP_ORIGIN to the https address',
      );
    }
  }

  const local = isLocalDevelopment(env, config.appOrigin);
  if (config.devUser && !local) {
    throw new ConfigError(
      'DEV_USER is only for local development, and this is not local development (NODE_ENV is production, or APP_ORIGIN is not on localhost). ' +
        'Unset it and put a sign-in proxy in front of the app instead; see the README',
    );
  }
  if (signingSecret.startsWith('change-me') && !local) {
    throw new ConfigError(
      'SIGNING_SECRET is still the placeholder from .env.example. Make one with: openssl rand -base64 32',
    );
  }
  if (new URL(config.appOrigin).host === new URL(config.contentOrigin).host) {
    throw new ConfigError('APP_ORIGIN and CONTENT_ORIGIN must be different hosts');
  }
  return config;
}
