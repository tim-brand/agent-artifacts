export type Config = {
  port: number;
  /** SQLite file and artifact files live under here. */
  dataDir: string;
  /** e.g. https://artifacts.stinosa.com */
  appOrigin: string;
  /** e.g. https://artifacts-content.stinosa.com */
  contentOrigin: string;
  signingSecret: string;
  /** Local dev only: used as the signed-in user when no forward-auth header is present. */
  devUser: string | null;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function origin(env: NodeJS.ProcessEnv, name: string): string {
  const url = new URL(required(env, name));
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const signingSecret = required(env, 'SIGNING_SECRET');
  if (signingSecret.length < 32) throw new Error('SIGNING_SECRET must be at least 32 characters');

  const config: Config = {
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? './data',
    appOrigin: origin(env, 'APP_ORIGIN'),
    contentOrigin: origin(env, 'CONTENT_ORIGIN'),
    signingSecret,
    devUser: env.DEV_USER || null,
  };

  if (config.devUser && env.NODE_ENV === 'production') {
    throw new Error('DEV_USER must not be set in production');
  }
  if (new URL(config.appOrigin).host === new URL(config.contentOrigin).host) {
    throw new Error('APP_ORIGIN and CONTENT_ORIGIN must be different hosts');
  }
  return config;
}
