import type { MissionPatchFile } from '@osstack/governance';

/** Exact application of one file from the classifier's own parse (`parseMissionPatch`), so the
 * paths written are exactly the paths classified. No fuzz, no offset search: every context
 * and removed line must match the current file. Returns the new content, or null for a deletion. */
export function applyContainedPatchFile(change: Pick<MissionPatchFile, 'kind' | 'hunks'>, current: string | null): string | null {
  if (change.kind === 'add' ? current !== null : current === null) throw Error('CONTAINED_PATCH_MISMATCH');
  const source = current ?? ''; const endsWithEol = source === '' || source.endsWith('\n');
  const old = source === '' ? [] : (endsWithEol ? source.slice(0, -1) : source).split('\n');
  const out: string[] = []; let cursor = 0; let lastNoEol = !endsWithEol;
  for (const hunk of change.hunks) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < cursor || start > old.length) throw Error('CONTAINED_PATCH_MISMATCH');
    // A copied prefix ends in a newline unless it reaches the old file's unterminated last line.
    if (start > cursor) { out.push(...old.slice(cursor, start)); lastNoEol = start === old.length && !endsWithEol; }
    cursor = start;
    for (const l of hunk.lines) {
      if (l.op !== '+') {
        // The old side must match byte for byte, including whether its last line ends in a newline.
        const last = cursor === old.length - 1;
        if (old[cursor] !== l.text || (last ? l.noEol !== !endsWithEol : l.noEol)) throw Error('CONTAINED_PATCH_MISMATCH');
        cursor++;
      }
      if (l.op !== '-') { out.push(l.text); lastNoEol = l.noEol; }
    }
  }
  // A copied tail keeps the old file's final newline; otherwise the last emitted line decides.
  if (cursor < old.length) { out.push(...old.slice(cursor)); lastNoEol = !endsWithEol; }
  if (change.kind === 'delete') { if (out.length !== 0) throw Error('CONTAINED_PATCH_MISMATCH'); return null; }
  return out.length === 0 ? '' : out.join('\n') + (lastNoEol ? '' : '\n');
}
