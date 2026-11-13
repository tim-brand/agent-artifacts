import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { parsePasswordHash, verifyAgainst } from './core/passwords.ts';

const SCRIPT = fileURLToPath(new URL('./hash-password.ts', import.meta.url));

/** Runs the command with stdin as a pipe (not a terminal). */
const run = (args: string[], input: string) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });

test('prints the whole AUTH_USERS entry on stdout, from the first line of a pipe', async () => {
  const res = run(['You@Example.com'], 'a long enough password\nsecond line\n');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^you@example\.com:scrypt\.15\.8\.3\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n$/);
  assert.equal(res.stderr, '', 'no warning for a long enough password');
  const hash = res.stdout.trim().split(':')[1] ?? '';
  const parsed = parsePasswordHash(hash);
  assert.ok(parsed);
  assert.equal(await verifyAgainst('a long enough password', parsed), true);
  assert.equal(await verifyAgainst('second line', parsed), false);
  // The entry goes straight into the settings.
  const env = {
    APP_ORIGIN: 'https://app.example.com',
    CONTENT_ORIGIN: 'https://content.example.com',
    SIGNING_SECRET: 'k3Jx9vQ2mZpL0wTn7YhB4cRd8sFa1UeGoXi6NtVb5Mc=',
    AUTH_MODE: 'password',
    AUTH_USERS: res.stdout.trim(),
  };
  assert.equal(loadConfig(env).authUsers[0]?.email, 'you@example.com');
});

test('prints only the hash without an email, and accepts a last line without a newline or with CRLF', async () => {
  for (const input of ['long enough password!', 'long enough password!\r\n']) {
    const res = run([], input);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^scrypt\.15\.8\.3\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n$/);
    const parsed = parsePasswordHash(res.stdout.trim());
    assert.ok(parsed && (await verifyAgainst('long enough password!', parsed)));
  }
});

test('leaves the line ending out of the password, also a lone \\r at the end of the input', async () => {
  for (const input of [
    'a long enough password\r\n',
    'a long enough password\r',
    'a long enough password',
  ]) {
    const res = run([], input);
    assert.equal(res.status, 0, res.stderr);
    const parsed = parsePasswordHash(res.stdout.trim());
    assert.ok(
      parsed && (await verifyAgainst('a long enough password', parsed)),
      JSON.stringify(input),
    );
  }
});

test('warns on stderr below 12 characters, but still prints', () => {
  const res = run(['a@example.com'], 'short\n');
  assert.equal(res.status, 0);
  assert.match(res.stderr, /shorter than 12/);
  assert.match(res.stdout, /^a@example\.com:scrypt\./);
  assert.doesNotMatch(res.stdout, /shorter/);
});

test('refuses an empty password, a password that is too long, and bad arguments', () => {
  for (const input of ['', '\n', '\r\n']) {
    const res = run(['a@example.com'], input);
    assert.equal(res.status, 1);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /empty/);
  }
  const long = run(['a@example.com'], `${'x'.repeat(1025)}\n`);
  assert.equal(long.status, 1);
  assert.equal(long.stdout, '');
  assert.match(long.stderr, /longer/);
  for (const args of [
    ['a b@example.com'],
    ['a:b@example.com'],
    ['a,b@example.com'],
    ['a@x', 'b@x'],
  ]) {
    const res = run(args, 'long enough password!\n');
    assert.equal(res.status, 1, args.join(' '));
    assert.equal(res.stdout, '');
  }
});

test('never takes the password from the command line', () => {
  const res = run(['a@example.com', 'long enough password!'], 'long enough password!\n');
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
});

test('imports nothing outside src/ and no dev dependency, so it runs in the Docker image', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['./hash-password.ts', './core/passwords.ts']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const [, from] of text.matchAll(/from '([^']+)'/g)) {
      assert.ok(
        from?.startsWith('node:') || /^\.\/[a-z-]+(\/[a-z-]+)?\.ts$/.test(from ?? ''),
        `${file} imports ${from}`,
      );
      assert.ok(!from?.startsWith('../') || file.includes('core/'), from);
    }
  }
});
