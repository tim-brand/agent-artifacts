import { isUtf8 } from 'node:buffer';
import { AppError, type FileInput, type Format, LIMITS, type PublishInput } from '../contracts.ts';

export type PreparedFile = { path: string; bytes: Uint8Array; contentType: string };
export type PreparedVersion = { entry: string; format: Format; files: PreparedFile[] };

const FORMATS: readonly Format[] = ['html', 'markdown', 'code', 'pdf'];

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  pdf: 'application/pdf',
};

const TEXT_PLAIN = 'text/plain; charset=utf-8';

/** Extensions shown as code (and served as text/plain unless listed above). */
const CODE_EXTENSIONS = new Set(
  (
    'txt ts tsx js jsx mjs cjs mts cts json jsonc css scss sass less py rb go rs java kt kts scala ' +
    'swift c h cc cpp hpp cs fs php pl lua r dart ex exs erl hs ml clj sql sh bash zsh fish ps1 ' +
    'yaml yml toml ini conf cfg env xml csv tsv diff patch vue svelte astro graphql gql proto tf hcl ' +
    'dockerfile makefile gradle nix zig elm jl log'
  ).split(' '),
);

/** Language names that don't match their usual extension. */
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  golang: 'go',
  kotlin: 'kt',
  csharp: 'cs',
  'c#': 'cs',
  'c++': 'cpp',
  shell: 'sh',
  bash: 'sh',
  powershell: 'ps1',
  markdown: 'md',
  text: 'txt',
  plaintext: 'txt',
  haskell: 'hs',
  elixir: 'ex',
  erlang: 'erl',
  perl: 'pl',
  terraform: 'tf',
  yml: 'yaml',
};

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function contentTypeFor(path: string, bytes: Uint8Array): string {
  const ext = extensionOf(path);
  const known = CONTENT_TYPES[ext];
  if (known) return known;
  if (CODE_EXTENSIONS.has(ext)) return TEXT_PLAIN;
  return isUtf8(bytes) ? TEXT_PLAIN : 'application/octet-stream';
}

function inferFormat(path: string, bytes: Uint8Array): Format {
  const ext = extensionOf(path);
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (CODE_EXTENSIONS.has(ext) || isUtf8(bytes)) return 'code';
  throw new AppError('unsupported_format', `Can't show an entry file like ${path}`);
}

export function codeExtension(language: string | undefined): string {
  const lang = language?.trim().toLowerCase();
  if (!lang) return 'txt';
  const mapped = LANGUAGE_EXTENSIONS[lang];
  if (mapped) return mapped;
  return /^[a-z0-9]{1,12}$/.test(lang) ? lang : 'txt';
}

/** Rejects instead of normalizing, so the stored path is exactly what was sent. */
export function validatePath(path: string): void {
  const fail = (why: string) => {
    throw new AppError('invalid_input', `Invalid file path ${JSON.stringify(path)}: ${why}`);
  };
  if (path.length === 0) fail('empty');
  if (path.length > 512) fail('longer than 512 characters');
  if (path.includes('\0')) fail('contains NUL');
  if (path.includes('\\')) fail('use forward slashes');
  if (path.startsWith('/')) fail('must be relative');
  for (const segment of path.split('/')) {
    if (segment === '') fail('empty segment');
    if (segment === '.' || segment === '..') fail(`"${segment}" segment`);
  }
}

function decodeBase64(value: string, path: string): Uint8Array {
  const clean = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) {
    throw new AppError('invalid_input', `${path} is not valid base64`);
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

function decode(input: FileInput, path: string): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input && typeof input === 'object' && typeof input.base64 === 'string') {
    return decodeBase64(input.base64, path);
  }
  throw new AppError('invalid_input', `${path} must be a string or { base64 }`);
}

function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 4)).toString('latin1') === '%PDF';
}

export function hasContent(input: PublishInput): boolean {
  return input.content !== undefined || input.files !== undefined;
}

/** Validates and decodes the content or files of a publish. */
export function prepareVersion(input: PublishInput): PreparedVersion {
  if (input.content !== undefined && input.files !== undefined) {
    throw new AppError('invalid_input', 'Give either content or files, not both');
  }
  if (input.format !== undefined && !FORMATS.includes(input.format)) {
    throw new AppError('unsupported_format', `Unknown format ${String(input.format)}`);
  }

  let entry: string;
  let format: Format;
  let raw: [string, Uint8Array][];

  if (input.content !== undefined) {
    if (typeof input.content !== 'string') {
      throw new AppError('invalid_input', 'content must be a string');
    }
    if (!input.format) throw new AppError('invalid_input', 'format is required with content');
    format = input.format;
    entry = {
      html: 'index.html',
      markdown: 'README.md',
      pdf: 'document.pdf',
      code: `main.${codeExtension(input.language)}`,
    }[format];
    const bytes =
      format === 'pdf'
        ? decodeBase64(input.content, entry)
        : new TextEncoder().encode(input.content);
    raw = [[entry, bytes]];
  } else {
    const files = input.files;
    if (!files || typeof files !== 'object') {
      throw new AppError('invalid_input', 'Give content (with format) or files');
    }
    const paths = Object.keys(files);
    if (paths.length === 0) throw new AppError('invalid_input', 'files is empty');
    if (paths.length > LIMITS.files) {
      throw new AppError('too_large', `At most ${LIMITS.files} files per publish`);
    }
    for (const path of paths) validatePath(path);

    const chosen = input.entry ?? (paths.length === 1 ? paths[0] : undefined);
    if (chosen === undefined) throw new AppError('invalid_input', 'entry is required with files');
    if (!Object.hasOwn(files, chosen)) {
      throw new AppError('invalid_input', `entry ${chosen} is not one of the files`);
    }
    entry = chosen;
    raw = paths.map((path) => [path, decode(files[path] as FileInput, path)]);
    const entryBytes = raw.find(([path]) => path === entry)?.[1] ?? new Uint8Array();
    format = inferFormat(entry, entryBytes);
    if (input.format !== undefined && input.format !== format) {
      throw new AppError(
        'invalid_input',
        `format ${input.format} doesn't match entry ${entry}, which is ${format}`,
      );
    }
  }

  let total = 0;
  for (const [path, bytes] of raw) {
    if (bytes.byteLength > LIMITS.fileBytes) {
      throw new AppError('too_large', `${path} is larger than ${LIMITS.fileBytes} bytes`);
    }
    total += bytes.byteLength;
  }
  if (total > LIMITS.publishBytes) {
    throw new AppError('too_large', `Publish is larger than ${LIMITS.publishBytes} bytes`);
  }

  const files = raw.map(([path, bytes]) => ({
    path,
    bytes,
    contentType: contentTypeFor(path, bytes),
  }));
  if (format === 'pdf' && !isPdf(files.find((f) => f.path === entry)?.bytes ?? new Uint8Array())) {
    throw new AppError('invalid_input', `${entry} is not a PDF (it should start with %PDF)`);
  }
  return { entry, format, files };
}
