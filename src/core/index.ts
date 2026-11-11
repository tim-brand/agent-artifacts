import type { Config } from '../config.ts';
import type { ArtifactService, ContentSigner, TokenService } from '../contracts.ts';

// STUB: replaced by the core agent.
export function createCore(_config: Config): {
  artifacts: ArtifactService;
  tokens: TokenService;
  signer: ContentSigner;
  close(): void;
} {
  throw new Error('not implemented');
}
