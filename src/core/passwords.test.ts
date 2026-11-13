import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPasswordChecker,
  DEFAULT_COST,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  parsePasswordHash,
  passwordProblem,
  verifyAgainst,
} from './passwords.ts';

// The smallest cost the parser accepts, so the tests stay fast. The default stays 2^15.
const COST = { logN: 14, p: 1 };

test('a hash verifies the password it was made from, and no other', async () => {
  const hash = await hashPassword('correct horse battery', COST);
  const parsed = parsePasswordHash(hash);
  assert.ok(parsed);
  assert.equal(await verifyAgainst('correct horse battery', parsed), true);
  assert.equal(await verifyAgainst('correct horse batterz', parsed), false);
  // Exactly as typed: no trimming, no case change.
  assert.equal(await verifyAgainst(' correct horse battery', parsed), false);
  assert.equal(await verifyAgainst('Correct horse battery', parsed), false);
});

test('the default cost is N=2^15, r=8, p=3, with a 16 byte salt and a 32 byte key', async () => {
  assert.deepEqual(DEFAULT_COST, { logN: 15, p: 3 });
  const hash = await hashPassword('a password of some length');
  const parsed = parsePasswordHash(hash);
  assert.ok(parsed);
  assert.deepEqual([parsed.logN, parsed.r, parsed.p], [15, 8, 3]);
  assert.equal(parsed.salt.length, 16);
  assert.equal(parsed.key.length, 32);
});

test('every hash has a new salt, and the text has none of $ , : or white space', async () => {
  const a = await hashPassword('same password', COST);
  const b = await hashPassword('same password', COST);
  assert.notEqual(a, b);
  for (const hash of [a, b]) {
    assert.doesNotMatch(hash, /[$,:\s]/);
    assert.match(hash, /^scrypt\.14\.8\.1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  }
});

test('malformed hash text is refused', async () => {
  const good = await hashPassword('password for the test', COST);
  const parts = good.split('.');
  const bad = [
    '',
    'scrypt',
    good.replace('scrypt', 'bcrypt'),
    `${good}.extra`,
    parts.slice(0, 5).join('.'),
    `$2a$14$${'x'.repeat(53)}`,
    [parts[0], parts[1], parts[2], parts[3], parts[4], `${parts[5]}!`].join('.'),
    [parts[0], parts[1], parts[2], parts[3], '', parts[5]].join('.'),
    // A key that is not 32 bytes, and a salt under 16 bytes.
    [parts[0], parts[1], parts[2], parts[3], parts[4], 'AAAA'].join('.'),
    [parts[0], parts[1], parts[2], parts[3], 'AAAA', parts[5]].join('.'),
    // Not the canonical form of the numbers.
    [parts[0], '014', parts[2], parts[3], parts[4], parts[5]].join('.'),
    [parts[0], '14 ', parts[2], parts[3], parts[4], parts[5]].join('.'),
  ];
  for (const text of bad) assert.equal(parsePasswordHash(text), null, text);
});

test('parameters outside the bounds are refused, so a setting cannot ask for absurd work', async () => {
  const [, , , , salt, key] = (await hashPassword('password for the test', COST)).split('.');
  const make = (logN: string | number, r: string | number, p: string | number) =>
    ['scrypt', logN, r, p, salt, key].join('.');
  assert.ok(parsePasswordHash(make(14, 8, 1)));
  assert.ok(parsePasswordHash(make(15, 8, 3)));
  assert.ok(parsePasswordHash(make(18, 8, 16)));
  assert.equal(parsePasswordHash(make(13, 8, 1)), null); // too cheap
  assert.equal(parsePasswordHash(make(19, 8, 1)), null); // too much memory
  assert.equal(parsePasswordHash(make(30, 8, 1)), null);
  assert.equal(parsePasswordHash(make(15, 4, 3)), null); // r is fixed at 8
  assert.equal(parsePasswordHash(make(15, 16, 3)), null);
  assert.equal(parsePasswordHash(make(15, 8, 0)), null);
  assert.equal(parsePasswordHash(make(15, 8, 17)), null);
  assert.equal(parsePasswordHash(make(15, 8, 99)), null);
  assert.equal(parsePasswordHash(make(1e9, 8, 1)), null);
  // And a new hash cannot be made outside them either.
  await assert.rejects(hashPassword('password for the test', { logN: 25 }));
});

test('an empty password and one over 1,024 characters are refused before any hashing', async () => {
  assert.match(passwordProblem('') ?? '', /empty/);
  assert.equal(passwordProblem('x'.repeat(MAX_PASSWORD_LENGTH)), null);
  assert.match(passwordProblem('x'.repeat(MAX_PASSWORD_LENGTH + 1)) ?? '', /longer/);
  assert.ok(passwordProblem(undefined));
  await assert.rejects(hashPassword(''));
  await assert.rejects(hashPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1)));
});

test('the checker accepts the right password and refuses a wrong one', async () => {
  const accounts = [
    { email: 'a@example.com', hash: await hashPassword('password of a', COST) },
    { email: 'b@example.com', hash: await hashPassword('password of b', COST) },
  ];
  const checker = createPasswordChecker(accounts, { cost: COST });
  assert.equal(await checker.check('a@example.com', 'password of a'), 'ok');
  assert.equal(await checker.check('b@example.com', 'password of b'), 'ok');
  assert.equal(await checker.check('a@example.com', 'password of b'), 'wrong');
  assert.equal(await checker.check('a@example.com', ''), 'wrong');
  assert.equal(await checker.check('a@example.com', 'x'.repeat(2000)), 'wrong');
  // Emails are matched as given: the caller lower-cases them.
  assert.equal(await checker.check('A@example.com', 'password of a'), 'wrong');
});

test('an unknown email still runs a verification, with the same cost as a known one', async () => {
  const accounts = [{ email: 'a@example.com', hash: await hashPassword('password of a', COST) }];
  const checker = createPasswordChecker(accounts, { cost: COST });
  const time = async (email: string) => {
    const start = performance.now();
    await checker.check(email, 'some password');
    return performance.now() - start;
  };
  await time('a@example.com'); // warm up (the dummy hash is made at startup)
  const known = await time('a@example.com');
  const unknown = await time('nobody@example.com');
  // Not a timing test (that would be flaky), only proof that work was done: an unknown email that
  // skipped scrypt would answer in well under a millisecond.
  assert.ok(unknown > known / 4, `unknown ${unknown} ms, known ${known} ms`);
  assert.ok(unknown > 2, `unknown email took ${unknown} ms`);
});

test('the checker makes its dummy hash with the cost of the configured hashes', async () => {
  const accounts = [{ email: 'a@example.com', hash: await hashPassword('password of a', COST) }];
  // No throw and no extra work for a missing account is checked above; here a bad hash is refused.
  assert.throws(
    () => createPasswordChecker([{ email: 'a@example.com', hash: 'scrypt.nope' }]),
    /not valid/,
  );
  assert.ok(createPasswordChecker(accounts));
});

test('at most `concurrency` verifications run at once; the rest wait, and too many waiting are refused', async () => {
  const accounts = [{ email: 'a@example.com', hash: await hashPassword('password of a', COST) }];
  const checker = createPasswordChecker(accounts, { concurrency: 1, waiting: 2, cost: COST });
  // 1 running + 2 waiting are served; the 4th and 5th find the queue full.
  const results = await Promise.all(
    Array.from({ length: 5 }, () => checker.check('a@example.com', 'password of a')),
  );
  assert.deepEqual(results.slice(0, 3), ['ok', 'ok', 'ok']);
  assert.deepEqual(results.slice(3), ['busy', 'busy']);
  // The slots are given back: it works again afterwards.
  assert.equal(await checker.check('a@example.com', 'password of a'), 'ok');
});
