// The seams between the parts of the app. core/ implements these; mcp/, ui/ and content/ only
// use them, so each part can be built and tested on its own (with a fake where needed).

export type Format = 'html' | 'markdown' | 'code' | 'pdf';

/** One file to publish: UTF-8 text, or binary as base64. */
export type FileInput = string | { base64: string };

export type FileInfo = {
  path: string;
  size: number;
  contentType: string;
  sha256: string;
};

export type Artifact = {
  id: string;
  title: string;
  description: string;
  format: Format;
  latestVersion: number;
  createdAt: string; // ISO 8601
  updatedAt: string;
};

export type Version = {
  artifactId: string;
  version: number; // 1, 2, 3, ... per artifact
  entry: string; // path of the file the artifact opens with, e.g. index.html
  format: Format;
  files: FileInfo[];
  createdAt: string;
  /** Who published it: the token's name, or the signed-in user's email. */
  publishedBy: string;
};

export type PublishInput = {
  /** Omit for a new artifact; give it for a new version of an existing one. */
  id?: string;
  /** Required for a new artifact. On an existing one, changes the title. */
  title?: string;
  description?: string;
  /** One file: `content` with `format`. The entry is then index.html, README.md, main.<ext> or document.pdf. */
  content?: string;
  format?: Format;
  /** Or several files, with `entry` naming the one to open. */
  files?: Record<string, FileInput>;
  entry?: string;
  /** For code: the language, used for the file extension and highlighting (e.g. "ts", "python"). */
  language?: string;
  /** Refuse with version_conflict when the latest version is no longer this one. */
  expectedVersion?: number;
};

export type PublishResult = {
  id: string;
  version: number;
  title: string;
  /** App URL of the artifact page: `${APP_ORIGIN}/a/${id}`. */
  url: string;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export type ListQuery = {
  format?: Format;
  limit?: number; // default 20, max 100
  cursor?: string;
};

export interface ArtifactService {
  /** Settings-only changes (title/description, no content or files) update in place and make no version. */
  publish(input: PublishInput, publishedBy: string): Promise<PublishResult>;
  /** Latest version when `version` is omitted. Null when the artifact or version doesn't exist (or is deleted). */
  get(id: string, version?: number): Promise<{ artifact: Artifact; version: Version } | null>;
  /** Null when not found. `path` is relative to the version's root, without a leading slash. */
  readFile(
    id: string,
    version: number,
    path: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Newest updatedAt first; deleted artifacts are left out. */
  list(query?: ListQuery): Promise<Page<Artifact>>;
  /** Newest first. Null when the artifact doesn't exist. */
  listVersions(id: string): Promise<Version[] | null>;
  /** Soft delete: hidden everywhere, files kept. False when not found. */
  delete(id: string): Promise<boolean>;
}

export type TokenInfo = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export interface TokenService {
  /** The plain token is only ever returned here; only its SHA-256 is stored. Format: `aa_<base64url>`. */
  create(name: string): Promise<{ token: string; info: TokenInfo }>;
  list(): Promise<TokenInfo[]>;
  revoke(id: string): Promise<boolean>;
  /** Constant-time check; updates lastUsedAt. Null when unknown or revoked. */
  verify(token: string): Promise<TokenInfo | null>;
}

/**
 * Short-lived URLs on the content host. The signature sits in the path, not the query, so relative
 * links inside a multi-file HTML artifact keep working:
 *   `${CONTENT_ORIGIN}/s/<exp>.<sig>/<id>/<version>/<path>`
 * where exp is unix seconds and sig = base64url(HMAC-SHA256(SIGNING_SECRET, `${id}/${version}/${exp}`)).
 */
export interface ContentSigner {
  /** Default ttl: 1 hour. */
  url(id: string, version: number, path: string, ttlSeconds?: number): string;
  /** True when the signature matches and exp is in the future. Constant-time. */
  verify(id: string, version: number, exp: number, sig: string): boolean;
}

/** Thrown by services; the HTTP and MCP layers map `code` to a status or tool error. */
export class AppError extends Error {
  readonly code:
    | 'not_found'
    | 'invalid_input'
    | 'version_conflict'
    | 'too_large'
    | 'unsupported_format';
  readonly details?: Record<string, unknown>;

  constructor(code: AppError['code'], message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export const LIMITS = {
  /** Total decoded bytes of one publish. */
  publishBytes: 25 * 1024 * 1024,
  fileBytes: 10 * 1024 * 1024,
  files: 200,
} as const;

export type Deps = {
  config: import('./config.ts').Config;
  artifacts: ArtifactService;
  tokens: TokenService;
  signer: ContentSigner;
};
