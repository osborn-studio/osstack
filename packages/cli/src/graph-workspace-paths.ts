import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_PATHS = 100000;
const invalid = (reason: string): never => { throw Error(`GRAPH_CONTRACT_RAW_${reason}`); };
function records(bytes: Buffer): string[] {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || (text && !text.endsWith('\0'))) invalid('PATH_ENCODING');
  return text.split('\0').filter(Boolean);
}
function safeParts(name: string): string[] {
  const parts = name.split('/');
  if (name.includes('\\') || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) invalid('PATH');
  return parts;
}
function stat(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Read-only raw comparison with the original immutable base. Git's stat cache,
 * attributes, filters, ignore rules and core.filemode never decide membership.
 * This is a pre-freeze gate, not a filesystem snapshot; immutable candidate
 * verification still runs after capture. Bounds match the artifact store. */
export function graphWorkspaceChangedPaths(workspace: string, baseRevision: string): string[] {
  if (!/^[a-f0-9]{40}$/.test(baseRevision)) invalid('BASE');
  const root = realpathSync(workspace);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  });
  if (git('rev-parse', '--verify', `${baseRevision}^{commit}`).toString().trim() !== baseRevision) invalid('BASE');
  const base = new Map<string, { mode: string; oid: string }>();
  for (const entry of records(git('ls-tree', '-r', '-z', '--full-tree', baseRevision))) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) invalid('BASE_ENTRY');
    const [, mode, oid, name] = match!; safeParts(name!);
    if (base.has(name!)) invalid('DUPLICATE_PATH');
    base.set(name!, { mode: mode!, oid: oid! });
    if (base.size > MAX_PATHS) invalid('PATH_LIMIT');
  }
  for (const entry of records(git('ls-files', '--stage', '-z'))) {
    if (!/^(100644|100755|120000) [a-f0-9]{40} 0\t/.test(entry)) invalid('INDEX_ENTRY');
  }
  // No --exclude-standard: ignored files are also candidate side effects.
  const names = new Set([...base.keys(), ...records(git('ls-files', '--cached', '--others', '-z'))]);
  if (names.size > MAX_PATHS) invalid('PATH_LIMIT');
  const changed: string[] = []; let totalBytes = 0;
  for (const name of [...names].sort()) {
    const parts = safeParts(name); let ancestor = root; let missingParent = false;
    for (const part of parts.slice(0, -1)) {
      ancestor = join(ancestor, part); const info = stat(ancestor);
      if (!info) { missingParent = true; break; }
      if (info.isSymbolicLink()) invalid('SYMLINK_ANCESTOR');
      if (!info.isDirectory()) {
        if (!info.isFile()) invalid('SPECIAL_FILE');
        missingParent = true; break;
      }
    }
    const path = resolve(root, name);
    if (!path.startsWith(root + sep)) invalid('PATH');
    const before = missingParent ? undefined : stat(path); const previous = base.get(name);
    if (!before || before.isDirectory()) {
      if (before?.isDirectory() && stat(join(path, '.git'))) invalid('NESTED_REPOSITORY');
      if (previous) changed.push(name);
      continue;
    }
    if (!before.isFile() && !before.isSymbolicLink()) invalid('SPECIAL_FILE');
    let mode: string; let oid: string;
    if (before.isSymbolicLink()) {
      const bytes = readlinkSync(path, { encoding: 'buffer' }); totalBytes += bytes.length;
      if (totalBytes > MAX_BYTES) invalid('BYTE_LIMIT');
      mode = '120000'; oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      const after = stat(path);
      if (!after || !sameFile(before, after) || !bytes.equals(readlinkSync(path, { encoding: 'buffer' }))) invalid('CHANGED_DURING_READ');
    } else {
      if (before.size > MAX_BYTES - totalBytes) invalid('BYTE_LIMIT');
      // O_NONBLOCK avoids hanging if a concurrent writer replaces a file with a FIFO.
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || !sameFile(before, opened)) invalid('CHANGED_DURING_READ');
        const hash = createHash('sha1').update(`blob ${opened.size}\0`); const buffer = Buffer.alloc(64 * 1024);
        let bytes = 0;
        for (;;) {
          const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break;
          bytes += count; totalBytes += count;
          if (totalBytes > MAX_BYTES || bytes > opened.size) invalid('BYTE_LIMIT');
          hash.update(buffer.subarray(0, count));
        }
        const after = stat(path);
        if (bytes !== opened.size || !sameFile(opened, fstatSync(fd)) || !after || !sameFile(opened, after)) invalid('CHANGED_DURING_READ');
        oid = hash.digest('hex');
        // Same raw mode mapping as captureArtifactTree's writer capture.
        mode = (opened.mode & 0o111) !== 0 ? '100755' : '100644';
      } finally { closeSync(fd); }
    }
    if (!previous || previous.mode !== mode || previous.oid !== oid) changed.push(name);
  }
  return changed;
}
