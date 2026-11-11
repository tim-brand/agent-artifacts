import { randomBytes } from 'node:crypto';
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from './ids.ts';

export type BlobStore = {
  /** Stores the bytes under their SHA-256 (once) and returns the hash. */
  put(bytes: Uint8Array): Promise<string>;
  read(sha256: string): Promise<Uint8Array>;
};

export function createBlobStore(dir: string): BlobStore {
  const pathOf = (sha256: string) => join(dir, sha256.slice(0, 2), sha256);

  return {
    async put(bytes) {
      const sha256 = sha256Hex(bytes);
      const target = pathOf(sha256);
      if (await exists(target)) return sha256;

      await mkdir(join(dir, sha256.slice(0, 2)), { recursive: true });
      const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        const handle = await open(temp, 'wx');
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Rename is atomic, so readers never see a half-written blob.
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      return sha256;
    },

    async read(sha256) {
      return new Uint8Array(await readFile(pathOf(sha256)));
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
