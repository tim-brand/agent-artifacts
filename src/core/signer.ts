import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ContentSigner } from '../contracts.ts';

export function createSigner(contentOrigin: string, signingSecret: string): ContentSigner {
  const sign = (id: string, version: number, exp: number) =>
    createHmac('sha256', signingSecret).update(`${id}/${version}/${exp}`).digest('base64url');

  return {
    url(id, version, path, ttlSeconds = 3600) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      return `${contentOrigin}/s/${exp}.${sign(id, version, exp)}/${encodeURIComponent(id)}/${version}/${encodedPath}`;
    },

    verify(id, version, exp, sig) {
      if (!Number.isSafeInteger(exp) || exp <= Date.now() / 1000) return false;
      const expected = Buffer.from(sign(id, version, exp));
      const given = Buffer.from(String(sig));
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
