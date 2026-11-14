import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAddress } from './rate-limit.ts';

test('the client address is the entry trustedProxies from the right', () => {
  assert.equal(clientAddress('203.0.113.7', 1), '203.0.113.7');
  // A client-sent entry is ignored.
  assert.equal(clientAddress('1.2.3.4, 203.0.113.7', 1), '203.0.113.7');
  assert.equal(clientAddress('1.2.3.4, 203.0.113.7, 10.0.0.1', 2), '203.0.113.7');
});

test('with fewer entries than proxies, the left-most entry is used', () => {
  assert.equal(clientAddress('203.0.113.7', 2), '203.0.113.7');
  assert.equal(clientAddress('203.0.113.7, 10.0.0.1', 5), '203.0.113.7');
});

test('a missing, empty or blank chosen entry shares the unknown bucket', () => {
  assert.equal(clientAddress(undefined, 1), 'unknown');
  assert.equal(clientAddress('', 1), 'unknown');
  assert.equal(clientAddress('1.2.3.4, ', 1), 'unknown');
});

test('entries are trimmed, and IPv6 works', () => {
  assert.equal(clientAddress(' 2001:db8::1 ', 1), '2001:db8::1');
});

test('the client address is cut short: a client cannot choose the size of a key', () => {
  assert.equal(clientAddress('x'.repeat(15_000), 1).length, 64);
});
