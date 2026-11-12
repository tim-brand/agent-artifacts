import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from './config.ts';

const SECRET = 'k3Jx9vQ2mZpL0wTn7YhB4cRd8sFa1UeGoXi6NtVb5Mc=';
const LOCAL = {
  APP_ORIGIN: 'http://localhost:3000',
  CONTENT_ORIGIN: 'http://content.localhost:3000',
  SIGNING_SECRET: SECRET,
};
const PUBLIC = {
  APP_ORIGIN: 'https://artifacts.example.com',
  CONTENT_ORIGIN: 'https://artifacts-content.example.com',
  SIGNING_SECRET: SECRET,
};
const PLACEHOLDER = 'change-me-change-me-change-me-change-me';

const refused = (env: NodeJS.ProcessEnv, pattern: RegExp) =>
  assert.throws(
    () => loadConfig(env),
    (error: unknown) => error instanceof ConfigError && pattern.test(error.message),
  );

test('the identity headers default to the Authentik names', () => {
  const config = loadConfig(PUBLIC);
  assert.equal(config.authEmailHeader, 'X-authentik-email');
  assert.equal(config.authNameHeader, 'X-authentik-name');
});

test('the identity headers can be set, and must be header names', () => {
  const config = loadConfig({
    ...PUBLIC,
    AUTH_EMAIL_HEADER: 'X-Auth-Request-Email',
    AUTH_NAME_HEADER: 'Remote-Name',
  });
  assert.equal(config.authEmailHeader, 'X-Auth-Request-Email');
  assert.equal(config.authNameHeader, 'Remote-Name');
  refused({ ...PUBLIC, AUTH_EMAIL_HEADER: 'X Email' }, /AUTH_EMAIL_HEADER must be an HTTP header/);
  refused({ ...PUBLIC, AUTH_NAME_HEADER: 'a:b' }, /AUTH_NAME_HEADER must be an HTTP header/);
  refused({ ...PUBLIC, AUTH_EMAIL_HEADER: 'X_Email' }, /AUTH_EMAIL_HEADER/);
});

test('DEV_USER and the placeholder secret work in local development', () => {
  const config = loadConfig({ ...LOCAL, SIGNING_SECRET: PLACEHOLDER, DEV_USER: 'dev@example.com' });
  assert.equal(config.devUser, 'dev@example.com');
  for (const app of ['http://127.0.0.1:3000', 'http://[::1]:3000', 'http://app.localhost:3000']) {
    assert.ok(loadConfig({ ...LOCAL, APP_ORIGIN: app, DEV_USER: 'dev@example.com' }));
  }
});

test('DEV_USER is refused outside local development', () => {
  refused({ ...PUBLIC, DEV_USER: 'dev@example.com' }, /DEV_USER.*sign-in proxy.*README/);
  refused({ ...LOCAL, NODE_ENV: 'production', DEV_USER: 'dev@example.com' }, /DEV_USER/);
  refused({ ...LOCAL, APP_ORIGIN: 'http://app.test', DEV_USER: 'x@example.com' }, /DEV_USER/);
  // Looks like localhost, but is not.
  refused(
    { ...LOCAL, APP_ORIGIN: 'http://localhost.example.com:3000', DEV_USER: 'x@example.com' },
    /DEV_USER/,
  );
});

test('the placeholder secret is refused outside local development', () => {
  refused({ ...PUBLIC, SIGNING_SECRET: PLACEHOLDER }, /placeholder.*openssl rand -base64 32/);
  refused({ ...LOCAL, NODE_ENV: 'production', SIGNING_SECRET: PLACEHOLDER }, /placeholder/);
  assert.ok(loadConfig(PUBLIC));
});

test('missing and invalid settings are config errors', () => {
  refused({ ...PUBLIC, SIGNING_SECRET: undefined }, /SIGNING_SECRET is not set/);
  refused({ ...PUBLIC, SIGNING_SECRET: 'short' }, /at least 32/);
  refused({ ...PUBLIC, APP_ORIGIN: undefined }, /APP_ORIGIN is not set/);
  refused({ ...PUBLIC, APP_ORIGIN: 'nonsense' }, /APP_ORIGIN must be an origin/);
  refused({ ...PUBLIC, CONTENT_ORIGIN: PUBLIC.APP_ORIGIN }, /different hosts/);
});

test('an empty PORT or DATA_DIR means the default', () => {
  const config = loadConfig({ ...PUBLIC, PORT: '', DATA_DIR: '' });
  assert.equal(config.port, 3000);
  assert.equal(config.dataDir, './data');
  refused({ ...PUBLIC, PORT: 'http' }, /PORT must be a port number/);
});
