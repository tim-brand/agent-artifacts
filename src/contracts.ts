// The seams between the parts of the app. core/ implements these; mcp/, ui/ and content/ only
// use them, so each part can be built and tested on its own (with a fake where needed).

export type Format = 'html' | 'markdown' | 'code' | 'pdf' | 'image';

/** One file to publish: UTF-8 text, or binary as base64. */
export type FileInput = string | { base64: string };

export type FileInfo = {
  path: string;
  size: number;
  contentType: string;
  sha256: string;
};

/**
 * What an HTML artifact's page may use through `window.openArtifacts` when it is opened in the app:
 * `db` its own documents (see DataService), `viewer` the signed-in user's email and name. Stored on
 * the artifact, not a version; the server refuses what isn't declared.
 */
export type Capabilities = { db: boolean; viewer: boolean };

export type Artifact = {
  id: string;
  title: string;
  description: string;
  format: Format;
  latestVersion: number;
  capabilities: Capabilities;
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

export type DeletedArtifact = Artifact & { deletedAt: string };

/** Replace `old`, which must occur exactly once, with `new`. */
export type Edit = { old: string; new: string };

export type PublishInput = {
  /** Omit for a new artifact; give it for a new version of an existing one. */
  id?: string;
  /** Required for a new artifact. On an existing one, changes the title. */
  title?: string;
  description?: string;
  /**
   * One file: `content` with `format`. The entry is then index.html, README.md, main.<ext> or
   * document.pdf. An image is base64 (an SVG may also be its text) and is named by `entry`, or by
   * `language` set to its extension (image.<ext>).
   */
  content?: string;
  format?: Format;
  /** Or several files, with `entry` naming the one to open. */
  files?: Record<string, FileInput>;
  entry?: string;
  /**
   * Or, with `id`: edits applied in order to the latest version's entry file (html, markdown or
   * code); the other files are reused. Fails with edit_failed when an `old` doesn't occur exactly once.
   */
  edits?: Edit[];
  /** For code: the language, used for the file extension and highlighting (e.g. "ts", "python"). For an image: its extension. */
  language?: string;
  /** Refuse with version_conflict when the latest version is no longer this one. */
  expectedVersion?: number;
  /**
   * Replaces the artifact's capabilities (a missing key is false). Omit to keep them; a new
   * artifact starts with none. Works in a settings-only publish too.
   */
  capabilities?: Partial<Capabilities>;
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

export type SearchQuery = {
  /** Plain words; FTS syntax in it is matched as text. The last word also matches as a prefix. */
  query: string;
  limit?: number; // default 20, max 100
  cursor?: string;
};

export type SearchHit = {
  artifact: Artifact;
  /** Plain text around the match, matched terms between « and ». Not HTML: escape it. */
  snippet: string;
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
  /** Full-text search over title, description and the latest version's text, best match first. */
  search(query: SearchQuery): Promise<Page<SearchHit>>;
  /** Newest first. Null when the artifact doesn't exist. */
  listVersions(id: string): Promise<Version[] | null>;
  /** Soft delete: hidden everywhere, files kept until purged. False when not found. */
  delete(id: string): Promise<boolean>;
  /** Brings a deleted artifact back. False when it isn't in the trash. */
  undelete(id: string): Promise<boolean>;
  /** The trash: deleted artifacts, most recently deleted first. */
  listDeleted(): Promise<DeletedArtifact[]>;
  /**
   * Publishes a copy of an old version as the new latest, reusing its stored files.
   * `publishedBy` gets " (restored v<n>)" appended. not_found when the artifact or version doesn't exist.
   */
  restoreVersion(id: string, version: number, publishedBy: string): Promise<PublishResult>;
}

/**
 * What a comment thread is about: the whole artifact, or a passage of it as a W3C TextQuoteSelector
 * (whitespace collapsed, `exact` trimmed, at most 32 characters of context on each side).
 */
export type Anchor =
  | { kind: 'note' }
  | { kind: 'text'; exact: string; prefix: string; suffix: string };

export type AnchorInput =
  | { kind: 'note' }
  | { kind: 'text'; exact: string; prefix?: string; suffix?: string };

export type Comment = {
  id: string;
  /** The signed-in user's email for typed comments, the token's name for agent comments. */
  author: string;
  /** True only for comments typed in the web UI: the owner's own words. */
  typed: boolean;
  body: string;
  createdAt: string;
};

export type Thread = {
  id: string;
  artifactId: string;
  anchor: Anchor;
  /** The version the thread was started on. */
  version: number;
  resolvedAt: string | null;
  createdAt: string;
  /** Time of the last comment or resolve/reopen. */
  updatedAt: string;
  /** Oldest first. */
  comments: Comment[];
};

export type CommentStatus = 'open' | 'resolved' | 'all';

export type CommentInput = {
  artifactId: string;
  /** 1 to 2,000 characters after trimming. */
  body: string;
  /** Reply to this thread; omit to start one. */
  threadId?: string;
  /** For a new thread only. Default: a note on the whole artifact. */
  anchor?: AnchorInput;
  /** For a new thread only: the version it is about. Default: the latest. */
  version?: number;
};

/**
 * Who wrote a comment. The route that received the comment builds it (`typed` is true only in the
 * web UI's route); it never comes from request input.
 */
export type CommentAuthor = { name: string; typed: boolean };

export interface CommentService {
  /** Newest activity first, at most 200 threads. Null when the artifact doesn't exist (or is deleted). */
  list(artifactId: string, status?: CommentStatus): Promise<Thread[] | null>;
  /** Starts a thread or replies to one; returns the thread. not_found for a deleted artifact. */
  add(input: CommentInput, author: CommentAuthor): Promise<Thread>;
  /**
   * Resolves or reopens a thread. Null when not found, deleted, or (with `artifactId`) on another
   * artifact.
   */
  resolve(threadId: string, resolved: boolean, artifactId?: string): Promise<Thread | null>;
  /** Open threads per artifact id; artifacts without any are left out. */
  openCounts(artifactIds: string[]): Promise<Record<string, number>>;
}

export const COMMENT_LIMITS = {
  body: 2000,
  exact: 2000,
  /** Characters of prefix and of suffix around a text anchor. */
  context: 32,
  threads: 200,
} as const;

/** A JSON object; the top level of a stored document. */
export type JsonObject = { [key: string]: unknown };

/** One document of an artifact's data. It belongs to the artifact, so every version sees it. */
export type DataDoc = {
  id: string;
  data: JsonObject;
  updatedAt: string;
  /** The signed-in user's email for a write from the page, the token's name for an agent's. */
  updatedBy: string;
};

/** A document set, updated or (with `data: null`) deleted after a revision. */
export type DataChange = Omit<DataDoc, 'data'> & { data: JsonObject | null };

export type DataChanges = {
  /** Oldest change first. */
  items: DataChange[];
  /** Pass as `since` next time. */
  rev: number;
  /** More changes are waiting: ask again with `rev`. */
  more: boolean;
  /**
   * For since 0, or a `since` too old to list the deletes after it: `items` is empty, and the
   * reader should drop what it had, read everything with list() and go on from `rev`.
   */
  reset: boolean;
};

/** Equality on top-level fields only; values are strings, numbers, booleans or null. */
export type DataWhere = Record<string, string | number | boolean | null>;

export type DataQuery = {
  where?: DataWhere;
  /** A top-level field. Default (and ties): the document id. */
  orderBy?: string;
  order?: 'asc' | 'desc';
  limit?: number; // default and max DATA_LIMITS.page
};

/**
 * Documents of an artifact, for its page (through the app's /api) and for agents (MCP). Every call
 * fails with not_found for a missing or deleted artifact and with forbidden when the artifact
 * doesn't declare the `db` capability.
 */
export interface DataService {
  /** Null when there is no such document. */
  get(artifactId: string, docId: string): Promise<DataDoc | null>;
  /** Creates or replaces the document. */
  set(artifactId: string, docId: string, data: JsonObject, by: string): Promise<DataDoc>;
  /** Merges `fields` into the document's top level, creating it when missing. */
  update(artifactId: string, docId: string, fields: JsonObject, by: string): Promise<DataDoc>;
  /** False when there was no such document. */
  delete(artifactId: string, docId: string, by: string): Promise<boolean>;
  /** By document id. */
  list(artifactId: string, query?: { cursor?: string; limit?: number }): Promise<Page<DataDoc>>;
  query(artifactId: string, query?: DataQuery): Promise<DataDoc[]>;
  /** What changed after revision `since`, for polling. Start with since 0: see `reset`. */
  changes(artifactId: string, since: number): Promise<DataChanges>;
}

export const DATA_LIMITS = {
  /** Bytes of a document's JSON. */
  docBytes: 256 * 1024,
  /** Live documents per artifact. */
  docs: 10_000,
  /** Document ids and field names: this many characters of [A-Za-z0-9_-]. */
  docId: 128,
  field: 64,
  /** Documents per list, query or changes call. */
  page: 100,
  /** Fields in a query's `where`. */
  where: 10,
} as const;

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

export type ShareLink = {
  id: string;
  artifactId: string;
  /** The pinned version, or null when the link always shows the latest. */
  version: number | null;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};

export type ShareLinkInput = {
  /** Pin the link to this version; omit to always show the latest. */
  version?: number;
  label?: string;
  /** ISO 8601, in the future. Omit for a link that never expires. */
  expiresAt?: string;
};

/**
 * Public links on the content host that need no sign-in:
 *   `${CONTENT_ORIGIN}/p/<token>/<path>`
 * Making something public is the owner's decision, so only the web UI may create or revoke them;
 * MCP gets `list` only.
 */
export interface ShareLinkService {
  /** The plain token is only ever returned here; only its SHA-256 is stored. Format: `sl_<base64url>`. */
  create(artifactId: string, input?: ShareLinkInput): Promise<{ token: string; link: ShareLink }>;
  /**
   * Links that aren't revoked, expired ones included, newest first: of one artifact (null when it
   * doesn't exist or is deleted), or of every live artifact when `artifactId` is omitted.
   */
  list(artifactId?: string): Promise<ShareLink[] | null>;
  revoke(artifactId: string, id: string): Promise<boolean>;
  /**
   * The version a token shows right now. Null when the token is unknown, revoked or expired, or its
   * artifact is deleted. Constant-time; updates lastUsedAt.
   */
  resolve(token: string): Promise<{ link: ShareLink; version: number } | null>;
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
    | 'unsupported_format'
    | 'edit_failed'
    | 'forbidden';
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

/** Deleted artifacts are purged for good after this many days in the trash. */
export const TRASH_DAYS = 30;

export type Deps = {
  config: import('./config.ts').Config;
  artifacts: ArtifactService;
  comments: CommentService;
  data: DataService;
  tokens: TokenService;
  shareLinks: ShareLinkService;
  signer: ContentSigner;
};
