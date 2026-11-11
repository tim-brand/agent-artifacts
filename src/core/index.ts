import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { ArtifactService, ContentSigner, TokenService } from '../contracts.ts';
import { createArtifactService } from './artifacts.ts';
import { createBlobStore } from './blobs.ts';
import { openDb } from './db.ts';
import { createSigner } from './signer.ts';
import { createTokenService } from './tokens.ts';

export function createCore(config: Config): {
  artifacts: ArtifactService;
  tokens: TokenService;
  signer: ContentSigner;
  close(): void;
} {
  const blobs = createBlobStore(join(config.dataDir, 'blobs'));
  const db = openDb(config.dataDir, blobs);
  return {
    artifacts: createArtifactService(db, blobs, config.appOrigin),
    tokens: createTokenService(db),
    signer: createSigner(config.contentOrigin, config.signingSecret),
    close: () => db.close(),
  };
}
