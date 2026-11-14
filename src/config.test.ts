import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from './config.ts';
import { hashPassword } from './core/passwords.ts';

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
  // Proxy mode, the default, does not start without it.
  AUTH_EMAIL_HEADER: 'X-Forwarded-Email',
};
const PLACEHOLDER = 'change-me-change-me-change-me-change-me';

const refused = (env: NodeJS.ProcessEnv, pattern: RegExp) =>
  assert.throws(
    () => loadConfig(env),
    (error: unknown) => error instanceof ConfigError && pattern.test(error.message),
  );

test('proxy mode needs AUTH_EMAIL_HEADER: there is no default', () => {
  const missing = /AUTH_MODE is proxy.*AUTH_EMAIL_HEADER is not set.*AUTH_MODE=password/;
  refused({ ...PUBLIC, AUTH_EMAIL_HEADER: undefined }, missing);
  refused({ ...PUBLIC, AUTH_EMAIL_HEADER: '' }, missing);
  refused({ ...PUBLIC, AUTH_MODE: 'proxy', AUTH_EMAIL_HEADER: undefined }, missing);
  // The name header alone does not say who is signed in.
  refused({ ...PUBLIC, AUTH_EMAIL_HEADER: undefined, AUTH_NAME_HEADER: 'Remote-Name' }, missing);
  // Not on localhost either, when nothing stands in for the proxy.
  refused(LOCAL, missing);
});

test('the name header is optional and has no default', () => {
  const config = loadConfig(PUBLIC);
  assert.equal(config.authEmailHeader, 'X-Forwarded-Email');
  assert.equal(config.authNameHeader, null);
  assert.equal(loadConfig({ ...PUBLIC, AUTH_NAME_HEADER: '' }).authNameHeader, null);
});

test('DEV_USER stands in for the email header in local development', () => {
  const config = loadConfig({ ...LOCAL, DEV_USER: 'dev@example.com' });
  assert.equal(config.authEmailHeader, null);
  assert.equal(config.authNameHeader, null);
  const both = loadConfig({ ...LOCAL, DEV_USER: 'dev@example.com', AUTH_EMAIL_HEADER: 'X-Email' });
  assert.equal(both.authEmailHeader, 'X-Email');
  // Outside local development DEV_USER is refused, so it cannot replace the header there.
  refused({ ...PUBLIC, AUTH_EMAIL_HEADER: undefined, DEV_USER: 'dev@example.com' }, /DEV_USER/);
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
  refused(
    {
      ...LOCAL,
      NODE_ENV: 'production',
      SIGNING_SECRET: PLACEHOLDER,
      AUTH_EMAIL_HEADER: 'X-Forwarded-Email',
    },
    /placeholder/,
  );
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

test('TRUSTED_PROXIES is the number of proxies, from 1 to 32, default 1', () => {
  assert.equal(loadConfig(PUBLIC).trustedProxies, 1);
  assert.equal(loadConfig({ ...PUBLIC, TRUSTED_PROXIES: '' }).trustedProxies, 1);
  assert.equal(loadConfig({ ...PUBLIC, TRUSTED_PROXIES: '2' }).trustedProxies, 2);
  for (const bad of ['0', '-1', '1.5', 'abc', '33']) {
    refused(
      { ...PUBLIC, TRUSTED_PROXIES: bad },
      /TRUSTED_PROXIES must be a whole number from 1 to 32: the number of reverse proxies in front of the app/,
    );
  }
});

// ---- The built-in sign-in ----

const HASH_A = await hashPassword('password of a', { logN: 14, p: 1 });
const HASH_B = await hashPassword('password of b', { logN: 14, p: 1 });
const PASSWORD = { ...PUBLIC, AUTH_MODE: 'password', AUTH_USERS: `a@example.com:${HASH_A}` };

/** Refused, and the message names no hash. */
const refusedWithoutHash = (env: NodeJS.ProcessEnv, pattern: RegExp) => {
  assert.throws(
    () => loadConfig(env),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, pattern);
      for (const hash of [HASH_A, HASH_B]) {
        assert.ok(!error.message.includes(hash), 'the message contains a hash');
        assert.ok(!error.message.includes(hash.slice(10)), 'the message contains part of a hash');
      }
      assert.doesNotMatch(error.message, /scrypt\./);
      return true;
    },
  );
};

test('AUTH_MODE defaults to proxy, and an empty value means the default', () => {
  assert.equal(loadConfig(PUBLIC).authMode, 'proxy');
  assert.equal(loadConfig({ ...PUBLIC, AUTH_MODE: '' }).authMode, 'proxy');
  assert.equal(loadConfig({ ...PUBLIC, AUTH_MODE: 'proxy' }).authMode, 'proxy');
  assert.deepEqual(loadConfig(PUBLIC).authUsers, []);
  assert.equal(loadConfig(PASSWORD).authMode, 'password');
});

test('any other AUTH_MODE is refused', () => {
  refused({ ...PUBLIC, AUTH_MODE: 'basic' }, /AUTH_MODE must be proxy or password/);
  refused({ ...PUBLIC, AUTH_MODE: 'Password' }, /AUTH_MODE must be proxy or password/);
  refused({ ...PUBLIC, AUTH_MODE: ' ' }, /AUTH_MODE/);
});

test('AUTH_USERS: entries are email:hash, separated by commas and white space, emails lower-cased', () => {
  const config = loadConfig({
    ...PASSWORD,
    AUTH_USERS: `A@Example.com:${HASH_A},\n  b@example.com:${HASH_B}\n`,
  });
  assert.deepEqual(config.authUsers, [
    { email: 'a@example.com', hash: HASH_A },
    { email: 'b@example.com', hash: HASH_B },
  ]);
  const spaced = loadConfig({
    ...PASSWORD,
    AUTH_USERS: `a@example.com:${HASH_A} b@example.com:${HASH_B}`,
  });
  assert.equal(spaced.authUsers.length, 2);
});

test('AUTH_USERS: the email is everything before the first colon', () => {
  const config = loadConfig({ ...PASSWORD, AUTH_USERS: `weird+tag@example.com:${HASH_A}` });
  assert.equal(config.authUsers[0]?.email, 'weird+tag@example.com');
});

test('AUTH_USERS: a malformed entry, an invalid hash and a duplicate are refused, naming the entry but no hash', () => {
  const ok = `a@example.com:${HASH_A}`;
  // No colon: it may be a bare hash, so the entry itself is never printed.
  refusedWithoutHash({ ...PASSWORD, AUTH_USERS: HASH_A }, /entry 1 has no ":"/);
  // The sign-in form keeps 254 characters of an email, so a longer one could never sign in.
  refusedWithoutHash(
    { ...PASSWORD, AUTH_USERS: `${'a'.repeat(250)}@x.yz:${HASH_A}` },
    /entry 1: the email is longer than 254 characters/,
  );
  assert.ok(loadConfig({ ...PASSWORD, AUTH_USERS: `${'a'.repeat(249)}@x.yz:${HASH_A}` }));
  refusedWithoutHash({ ...PASSWORD, AUTH_USERS: `${ok} ${HASH_B}` }, /entry 2 has no ":"/);
  refusedWithoutHash({ ...PASSWORD, AUTH_USERS: `:${HASH_A}` }, /entry 1 has no email/);
  refusedWithoutHash(
    { ...PASSWORD, AUTH_USERS: 'a@example.com:scrypt.14.8.1.AAAA.BBBB' },
    /entry 1 \("a@example.com"\).*not valid/,
  );
  refusedWithoutHash({ ...PASSWORD, AUTH_USERS: 'a@example.com:' }, /entry 1.*not valid/);
  refusedWithoutHash(
    { ...PASSWORD, AUTH_USERS: `a@example.com:$2a$14$${'x'.repeat(53)}` },
    /not valid/,
  );
  // The hash cannot contain a colon.
  refusedWithoutHash({ ...PASSWORD, AUTH_USERS: `a@example.com:${HASH_A}:more` }, /not valid/);
  // The same email twice, also when only the case differs.
  refusedWithoutHash(
    { ...PASSWORD, AUTH_USERS: `${ok} A@EXAMPLE.com:${HASH_B}` },
    /entry 2 \("a@example.com"\).*twice/,
  );
  // The hash first and the email second: the "email" is a hash, so it is not printed.
  refusedWithoutHash({ ...PASSWORD, AUTH_USERS: `${HASH_A}:a@example.com` }, /entry 1/);
  // A hash with an out-of-bounds cost is not valid.
  const [, , , , salt, key] = HASH_A.split('.');
  refusedWithoutHash(
    { ...PASSWORD, AUTH_USERS: `a@example.com:scrypt.30.8.1.${salt}.${key}` },
    /not valid/,
  );
});

test('AUTH_MODE=password needs at least one account', () => {
  refused({ ...PUBLIC, AUTH_MODE: 'password' }, /AUTH_USERS holds no account/);
  refused({ ...PUBLIC, AUTH_MODE: 'password', AUTH_USERS: '' }, /AUTH_USERS holds no account/);
  refused({ ...PUBLIC, AUTH_MODE: 'password', AUTH_USERS: ' \n ,' }, /AUTH_USERS holds no account/);
});

test('AUTH_MODE=password refuses DEV_USER, also on localhost', () => {
  refused({ ...PASSWORD, DEV_USER: 'dev@example.com' }, /DEV_USER.*password/);
  refused(
    {
      ...LOCAL,
      AUTH_MODE: 'password',
      AUTH_USERS: PASSWORD.AUTH_USERS,
      DEV_USER: 'dev@example.com',
    },
    /DEV_USER/,
  );
});

test('AUTH_MODE=password needs an https APP_ORIGIN, except on localhost', () => {
  refused({ ...PASSWORD, APP_ORIGIN: 'http://artifacts.example.com' }, /APP_ORIGIN must be https/);
  refused(
    { ...PASSWORD, APP_ORIGIN: 'http://localhost.example.com:3000' },
    /APP_ORIGIN must be https/,
  );
  for (const app of [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://app.localhost:3000',
    'https://artifacts.example.com',
  ]) {
    assert.ok(
      loadConfig({
        ...PASSWORD,
        APP_ORIGIN: app,
        CONTENT_ORIGIN: 'https://artifacts-content.example.com',
      }),
      app,
    );
  }
  // The exception does not depend on NODE_ENV: the Docker image sets production.
  const local = { ...LOCAL, AUTH_MODE: 'password', AUTH_USERS: PASSWORD.AUTH_USERS };
  assert.equal(loadConfig({ ...local, NODE_ENV: 'production' }).authMode, 'password');
});

test('AUTH_USERS without AUTH_MODE=password is refused, so a typo cannot leave the wrong mode on', () => {
  const users = `a@example.com:${HASH_A}`;
  refusedWithoutHash(
    { ...PUBLIC, AUTH_USERS: users },
    /AUTH_USERS is set, but AUTH_MODE is not password/,
  );
  refusedWithoutHash(
    { ...PUBLIC, AUTH_MODE: 'proxy', AUTH_USERS: users },
    /AUTH_USERS is set, but AUTH_MODE is not password/,
  );
  refused({ ...PUBLIC, AUTH_MODE: '', AUTH_USERS: users }, /AUTH_USERS is set/);
  // A blank value is not set.
  assert.equal(loadConfig({ ...PUBLIC, AUTH_USERS: '' }).authMode, 'proxy');
  assert.equal(loadConfig({ ...PUBLIC, AUTH_USERS: '  ' }).authMode, 'proxy');
});

test('password mode does not need the identity headers', () => {
  const config = loadConfig({ ...PASSWORD, AUTH_EMAIL_HEADER: undefined });
  assert.equal(config.authMode, 'password');
  assert.equal(config.authEmailHeader, null);
  assert.equal(config.authNameHeader, null);
});

test('in password mode the identity header settings are still validated, and DEV_USER stays refused in proxy mode as before', () => {
  refused(
    { ...PASSWORD, AUTH_EMAIL_HEADER: 'X Email' },
    /AUTH_EMAIL_HEADER must be an HTTP header/,
  );
  assert.ok(loadConfig({ ...PASSWORD, AUTH_EMAIL_HEADER: 'X-Email' }));
  refused({ ...PUBLIC, DEV_USER: 'dev@example.com' }, /DEV_USER/);
});
