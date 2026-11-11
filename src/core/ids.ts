import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Random base62 id. Bytes >= 248 are skipped so every character is equally likely. */
export function randomId(length = 12): string {
  let id = '';
  while (id.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 248) continue;
      id += ALPHABET.charAt(byte % 62);
      if (id.length === length) break;
    }
  }
  return id;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function now(): string {
  return new Date().toISOString();
}
