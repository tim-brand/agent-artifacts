import { join } from 'node:path';
import type { Config } from '../config.ts';
import type {
  ArtifactService,
  ContentSigner,
  ShareLinkService,
  TokenService,
} from '../contracts.ts';
import { createArtifactService } from './artifacts.ts';
import { createBlobStore } from './blobs.ts';
import { openDb } from './db.ts';
import { createPurge, type PurgeResult } from './purge.ts';
import { createShareLinkService } from './share-links.ts';
import { createSigner } from './signer.ts';
import { createTokenService } from './tokens.ts';

export function createCore(config: Config): {
  artifacts: ArtifactService;
  tokens: TokenService;
  shareLinks: ShareLinkService;
  signer: ContentSigner;
  /** Empties the trash of artifacts deleted over 30 days ago and removes unused blobs. */
  purge(now?: number): Promise<PurgeResult>;
  close(): void;
} {
  const blobsDir = join(config.dataDir, 'blobs');
  const blobs = createBlobStore(blobsDir);
  const db = openDb(config.dataDir, blobs);
  return {
    artifacts: createArtifactService(db, blobs, config.appOrigin),
    tokens: createTokenService(db),
    shareLinks: createShareLinkService(db),
    signer: createSigner(config.contentOrigin, config.signingSecret),
    purge: createPurge(db, blobsDir),
    close: () => db.close(),
  };
}
