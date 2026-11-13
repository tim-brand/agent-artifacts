import { join } from 'node:path';
import type { Config } from '../config.ts';
import type {
  ArtifactService,
  CommentService,
  ContentSigner,
  DataService,
  OAuthService,
  SessionService,
  ShareLinkService,
  TokenService,
} from '../contracts.ts';
import { createArtifactService } from './artifacts.ts';
import { createBlobStore } from './blobs.ts';
import { createCommentService } from './comments.ts';
import { createDataService } from './data.ts';
import { openDb } from './db.ts';
import { createOAuthService } from './oauth.ts';
import { createPurge, type PurgeResult } from './purge.ts';
import { createSessionService } from './sessions.ts';
import { createShareLinkService } from './share-links.ts';
import { createSigner } from './signer.ts';
import { createTokenService } from './tokens.ts';

export function createCore(config: Config): {
  artifacts: ArtifactService;
  comments: CommentService;
  data: DataService;
  tokens: TokenService;
  oauth: OAuthService;
  shareLinks: ShareLinkService;
  signer: ContentSigner;
  sessions: SessionService;
  /**
   * Empties the trash of artifacts deleted over 30 days ago and removes unused blobs, expired OAuth
   * codes and tokens, ended grants and clients unused for 30 days, and expired sessions.
   */
  purge(now?: number): Promise<PurgeResult>;
  close(): void;
} {
  const blobsDir = join(config.dataDir, 'blobs');
  const blobs = createBlobStore(blobsDir);
  const db = openDb(config.dataDir, blobs);
  const oauth = createOAuthService(db, config.appOrigin);
  const purge = createPurge(db, blobsDir);
  const sessions = createSessionService(db);
  return {
    sessions,
    artifacts: createArtifactService(db, blobs, config.appOrigin),
    comments: createCommentService(db),
    data: createDataService(db),
    tokens: createTokenService(db),
    oauth,
    shareLinks: createShareLinkService(db),
    signer: createSigner(config.contentOrigin, config.signingSecret),
    purge: async (now) => {
      oauth.purge(now);
      sessions.purge(now);
      return purge(now);
    },
    close: () => db.close(),
  };
}
