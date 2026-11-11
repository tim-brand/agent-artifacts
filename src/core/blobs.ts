import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, open, readFile, rename, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from './ids.ts';

export type BlobStore = {
  /** Stores the bytes under their SHA-256 (once) and returns the hash. */
  put(bytes: Uint8Array): Promise<string>;
  read(sha256: string): Promise<Uint8Array>;
  /** Sync variants, for use inside a database transaction. */
  putSync(bytes: Uint8Array): string;
  readSync(sha256: string): Uint8Array;
};

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function createBlobStore(dir: string): BlobStore {
  const pathOf = (sha256: string) => join(dir, sha256.slice(0, 2), sha256);
  const tempOf = (target: string) => `${target}.${randomBytes(6).toString('hex')}.tmp`;

  // Writes go to a temp file that is renamed into place: rename is atomic, so readers never see a
  // half-written blob. A blob that already exists gets a fresh mtime instead, so the garbage
  // collector, which skips young blobs, can't remove it while this publish is still in flight.
  return {
    async put(bytes) {
      const sha256 = sha256Hex(bytes);
      const target = pathOf(sha256);
      const time = new Date();
      try {
        await utimes(target, time, time);
        return sha256;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      await mkdir(join(dir, sha256.slice(0, 2)), { recursive: true });
      const temp = tempOf(target);
      try {
        const handle = await open(temp, 'wx');
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
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

    putSync(bytes) {
      const sha256 = sha256Hex(bytes);
      const target = pathOf(sha256);
      const time = new Date();
      try {
        utimesSync(target, time, time);
        return sha256;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      mkdirSync(join(dir, sha256.slice(0, 2)), { recursive: true });
      const temp = tempOf(target);
      try {
        const fd = openSync(temp, 'wx');
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, target);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
      return sha256;
    },

    readSync(sha256) {
      return new Uint8Array(readFileSync(pathOf(sha256)));
    },
  };
}
