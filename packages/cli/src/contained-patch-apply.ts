/** Exact unified-diff application for a patch the Mission classifier already accepted.
 * No fuzz, no offset search: every context and removed line must match the current file. */
export interface ContainedPatchFileChange { path: string; kind: 'add' | 'modify' | 'delete'; hunks: Hunk[] }
interface Hunk { oldStart: number; oldCount: number; lines: Array<{ op: ' ' | '-' | '+'; text: string; noEol: boolean }> }

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const strip = (raw: string, side: 'a/' | 'b/') => raw === '/dev/null' ? null : raw.startsWith(side) ? raw.slice(2) : raw;

export function parseContainedPatch(text: string): ContainedPatchFileChange[] {
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
  const files: ContainedPatchFileChange[] = []; let current: ContainedPatchFileChange | undefined; let hunk: Hunk | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const oldPath = strip(line.slice(4).split('\t')[0]!, 'a/'); const newPath = strip(lines[i + 1]!.slice(4).split('\t')[0]!, 'b/'); i++;
      const path = newPath ?? oldPath; if (!path) throw Error('CONTAINED_PATCH_PATH');
      current = { path, kind: oldPath === null ? 'add' : newPath === null ? 'delete' : 'modify', hunks: [] }; files.push(current); hunk = undefined; continue;
    }
    const header = HEADER.exec(line);
    if (header) { if (!current) throw Error('CONTAINED_PATCH_HUNK_ORPHAN'); hunk = { oldStart: Number(header[1]), oldCount: header[2] === undefined ? 1 : Number(header[2]), lines: [] }; current.hunks.push(hunk); continue; }
    if (hunk && (line[0] === ' ' || line[0] === '-' || line[0] === '+')) { hunk.lines.push({ op: line[0], text: line.slice(1), noEol: false }); continue; }
    if (hunk && line.startsWith('\\ ')) { const last = hunk.lines.at(-1); if (!last) throw Error('CONTAINED_PATCH_EOL_MARKER'); last.noEol = true; }
    // git headers (diff --git, index, new file mode) carry nothing the classifier has not checked.
  }
  return files;
}

/** Returns the new file content, or null for a deletion. Throws CONTAINED_PATCH_MISMATCH on any drift. */
export function applyContainedPatchFile(change: ContainedPatchFileChange, current: string | null): string | null {
  if (change.kind === 'add' ? current !== null : current === null) throw Error('CONTAINED_PATCH_MISMATCH');
  const source = current ?? ''; const endsWithEol = source === '' || source.endsWith('\n');
  const old = source === '' ? [] : (endsWithEol ? source.slice(0, -1) : source).split('\n');
  const out: string[] = []; let cursor = 0; let lastNoEol = !endsWithEol;
  for (const hunk of change.hunks) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < cursor || start > old.length) throw Error('CONTAINED_PATCH_MISMATCH');
    out.push(...old.slice(cursor, start)); cursor = start;
    for (const l of hunk.lines) {
      if (l.op !== '+') { if (old[cursor] !== l.text) throw Error('CONTAINED_PATCH_MISMATCH'); cursor++; }
      if (l.op !== '-') { out.push(l.text); lastNoEol = l.noEol; }
    }
  }
  // A copied tail keeps the old file's final newline; otherwise the last emitted line decides.
  if (cursor < old.length) { out.push(...old.slice(cursor)); lastNoEol = !endsWithEol; }
  if (change.kind === 'delete') { if (out.length !== 0) throw Error('CONTAINED_PATCH_MISMATCH'); return null; }
  return out.length === 0 ? '' : out.join('\n') + (lastNoEol ? '' : '\n');
}
