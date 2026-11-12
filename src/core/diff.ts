import { isUtf8 } from 'node:buffer';
import { structuredPatch } from 'diff';
import {
  COMPARE_LIMITS,
  type Comparison,
  type DiffHunk,
  type FileChange,
  type FileInfo,
  type Format,
  type Version,
} from '../contracts.ts';
import type { BlobStore } from './blobs.ts';

/**
 * Line diffs, with the `diff` package (Myers' algorithm, as in git). Its time grows with the size
 * of the files times the number of changes, so every diff gets a time limit: past it, line counts
 * are null and a comparison shows the file as too large.
 */
const COUNT_MS = 500;
const COMPARE_MS = 2000;

export type LineCounts = { added: number; removed: number };

const TEXT_TYPES = /^(text\/|application\/json|image\/svg\+xml)/;

/** A file's text, or null when it isn't a text type or isn't UTF-8. */
export function textOf(contentType: string, bytes: Uint8Array): string | null {
  return TEXT_TYPES.test(contentType) && isUtf8(bytes) ? new TextDecoder().decode(bytes) : null;
}

/** Entries that get line counts: html, markdown, code and SVG images. */
export function isTextEntry(format: Format, contentType: string): boolean {
  if (format === 'html' || format === 'markdown' || format === 'code') return true;
  return format === 'image' && contentType.startsWith('image/svg+xml');
}

/**
 * The text of a version's entry file, for its line counts. Null when its format isn't text, or the
 * blob can't be read: counts are left out rather than failing a publish or startup.
 */
export function entryText(
  blobs: BlobStore,
  format: Format,
  file: { sha256: string; contentType: string } | undefined,
): string | null {
  if (!file || !isTextEntry(format, file.contentType)) return null;
  try {
    return textOf(file.contentType, blobs.readSync(file.sha256));
  } catch (error) {
    console.error('diff: could not read blob', file.sha256, error);
    return null;
  }
}

/** The diff's hunks, or null when it took longer than `ms`. */
function diffHunks(before: string, after: string, ms: number): DiffHunk[] | null {
  const patch = structuredPatch('a', 'b', before, after, undefined, undefined, {
    context: COMPARE_LIMITS.context,
    timeout: Math.max(1, ms),
  });
  return (
    patch?.hunks.map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    })) ?? null
  );
}

function countLines(hunks: DiffHunk[]): LineCounts {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line[0] === '+') added++;
      else if (line[0] === '-') removed++;
    }
  }
  return { added, removed };
}

/** Lines added and removed from `before` to `after`; null when the diff is too slow. */
export function lineCounts(before: string, after: string): LineCounts | null {
  const hunks = diffHunks(before, after, COUNT_MS);
  return hunks ? countLines(hunks) : null;
}

/** A hunk as unified diff text. A side with no lines starts one lower, as in diff -u. */
function hunkText(h: DiffHunk): string {
  const oldStart = h.oldLines === 0 ? h.oldStart - 1 : h.oldStart;
  const newStart = h.newLines === 0 ? h.newStart - 1 : h.newStart;
  return `@@ -${oldStart},${h.oldLines} +${newStart},${h.newLines} @@\n${h.lines.join('\n')}\n`;
}

const byteLength = (text: string) => Buffer.byteLength(text);

/**
 * Compares two versions file by file: by path, except that the entry counts as renamed when the
 * newer version opens another file and neither path is in both. `to` is the newer side, whatever
 * the version numbers. The hunks and `patch` stop once they would pass COMPARE_LIMITS.diffBytes.
 */
export function compareFiles(
  from: Version,
  to: Version,
  read: (sha256: string) => Uint8Array,
): Omit<Comparison, 'artifact' | 'from' | 'to'> {
  const deadline = Date.now() + COMPARE_MS;
  const before = new Map(from.files.map((f) => [f.path, f]));
  const after = new Map(to.files.map((f) => [f.path, f]));
  const renamed = from.entry !== to.entry && !after.has(from.entry) && !before.has(to.entry);

  const pairs: [FileInfo | undefined, FileInfo | undefined][] = [];
  if (renamed) pairs.push([before.get(from.entry), after.get(to.entry)]);
  const rank = (path: string) => (path === to.entry || path === from.entry ? 0 : 1);
  const paths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => !renamed || (path !== from.entry && path !== to.entry))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const path of paths) pairs.push([before.get(path), after.get(path)]);

  const files: FileChange[] = [];
  const patch: string[] = [];
  let unchanged = 0;
  let used = 0;
  let truncated = false;
  /** Adds text to the patch if it fits; once something doesn't, nothing more does. */
  const fits = (text: string) => {
    const size = byteLength(text);
    if (truncated || used + size > COMPARE_LIMITS.diffBytes) {
      truncated = true;
      return false;
    }
    used += size;
    patch.push(text);
    return true;
  };

  for (const [old, now] of pairs) {
    if (old && now && old.sha256 === now.sha256 && old.path === now.path) {
      unchanged++;
      continue;
    }
    const change: FileChange = {
      path: (now ?? old)?.path ?? '',
      ...(renamed && old && now && old.path !== now.path ? { oldPath: old.path } : {}),
      status: !old ? 'added' : !now ? 'removed' : old.path !== now.path ? 'renamed' : 'changed',
      diff: 'text',
      linesAdded: null,
      linesRemoved: null,
      hunks: [],
      truncated: false,
    };
    files.push(change);
    const a = old ? `a/${old.path}` : '/dev/null';
    const b = now ? `b/${now.path}` : '/dev/null';
    const oldText = old ? textOf(old.contentType, read(old.sha256)) : '';
    const newText = now ? textOf(now.contentType, read(now.sha256)) : '';
    if (oldText === null || newText === null) {
      change.diff = 'binary';
      fits(`Binary files ${a} and ${b} differ\n`);
      continue;
    }
    const hunks = diffHunks(oldText, newText, deadline - Date.now());
    if (!hunks) {
      change.diff = 'too_large';
      continue;
    }
    const counts = countLines(hunks);
    change.linesAdded = counts.added;
    change.linesRemoved = counts.removed;
    for (const [i, hunk] of hunks.entries()) {
      if (!fits(`${i === 0 ? `--- ${a}\n+++ ${b}\n` : ''}${hunkText(hunk)}`)) {
        change.truncated = true;
        break;
      }
      change.hunks.push(hunk);
    }
  }

  const sum = (key: 'linesAdded' | 'linesRemoved') =>
    files.reduce((total, f) => total + (f[key] ?? 0), 0);
  return {
    files,
    unchanged,
    linesAdded: sum('linesAdded'),
    linesRemoved: sum('linesRemoved'),
    patch: patch.join(''),
    truncated,
  };
}
