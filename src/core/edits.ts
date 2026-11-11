import { AppError, type Edit, type PublishInput } from '../contracts.ts';

/** Rejects an edits publish that also sends something only a full publish uses. */
export function checkEditsInput(input: PublishInput): Edit[] {
  const edits: unknown = input.edits;
  if (input.id === undefined) {
    throw new AppError('invalid_input', 'edits need the id of an existing artifact');
  }
  for (const key of ['content', 'files', 'format', 'entry', 'language'] as const) {
    if (input[key] !== undefined) {
      throw new AppError('invalid_input', `Give either edits or ${key}, not both`);
    }
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new AppError('invalid_input', 'edits must be a non-empty list of { old, new }');
  }
  for (const [index, edit] of edits.entries()) {
    if (typeof edit?.old !== 'string' || typeof edit?.new !== 'string') {
      throw new AppError('invalid_input', `edits[${index}] must be { old: string, new: string }`);
    }
    if (edit.old === '') throw new AppError('invalid_input', `edits[${index}].old is empty`);
  }
  return edits as Edit[];
}

/** Counts overlapping matches too, so "exactly once" can't hide a second, overlapping one. */
function occurrences(text: string, search: string): number {
  let count = 0;
  for (let at = text.indexOf(search); at !== -1; at = text.indexOf(search, at + 1)) count++;
  return count;
}

export function applyEdits(text: string, edits: Edit[]): string {
  let result = text;
  for (const [index, edit] of edits.entries()) {
    const found = occurrences(result, edit.old);
    if (found !== 1) {
      throw new AppError(
        'edit_failed',
        `edits[${index}].old occurs ${found} times in the entry file; it must occur exactly once`,
        { index, occurrences: found },
      );
    }
    // Sliced rather than String.replace, which would treat $& and $1 in `new` as patterns.
    const at = result.indexOf(edit.old);
    result = result.slice(0, at) + edit.new + result.slice(at + edit.old.length);
  }
  return result;
}
