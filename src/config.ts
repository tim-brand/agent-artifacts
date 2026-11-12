export type Config = {
  port: number;
  /** SQLite file and artifact files live under here. */
  dataDir: string;
  /** The public origin of the app host, e.g. https://artifacts.example.com */
  appOrigin: string;
  /** The public origin of the content host, e.g. https://artifacts-content.example.com */
  contentOrigin: string;
  signingSecret: string;
  /** Local dev only: used as the signed-in user when no sign-in proxy header is present. */
  devUser: string | null;
  /** The request header in which the sign-in proxy sends the user's email. */
  authEmailHeader: string;
  /** The request header in which the sign-in proxy sends the user's display name. */
  authNameHeader: string;
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

function headerName(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name] || fallback;
  if (!/^[A-Za-z0-9-]+$/.test(value)) {
    throw new ConfigError(`${name} must be an HTTP header name (letters, digits and - only)`);
  }
  return value;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Local development: not production, and the app origin is a loopback name. */
export function isLocalDevelopment(env: NodeJS.ProcessEnv, appOrigin: string): boolean {
  if (env.NODE_ENV === 'production') return false;
  const host = new URL(appOrigin).hostname;
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
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

  const config: Config = {
    port,
    dataDir: env.DATA_DIR || './data',
    appOrigin: origin(env, 'APP_ORIGIN'),
    contentOrigin: origin(env, 'CONTENT_ORIGIN'),
    signingSecret,
    devUser: env.DEV_USER || null,
    authEmailHeader: headerName(env, 'AUTH_EMAIL_HEADER', 'X-authentik-email'),
    authNameHeader: headerName(env, 'AUTH_NAME_HEADER', 'X-authentik-name'),
  };

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
