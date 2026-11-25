import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { canonicalJson } from '@osstack/protocol/source';
import type { ContainedCandidateFile } from '../contained-image.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function containedGit(workspace: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: workspace, timeout: 10000, maxBuffer: 33 * 1024 * 1024,
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' } });
}

/** Resolve once and export the exact tree recorded by the installed repository's commit. */
export function exportContainedCommit(workspace: string, head: string) {
  if (!isAbsolute(workspace) || typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) throw Error('CONTAINED_COMMIT_INVALID');
  try {
    const git = containedGit(workspace);
    const replacement = 'refs/replace/' + head;
    if (git('rev-parse', '--verify', head + '^{commit}').toString().trim() !== head ||
        git('for-each-ref', '--format=%(refname)', replacement).toString().split('\n').includes(replacement))
      throw Error('CONTAINED_COMMIT_INVALID');
    const tree = git('rev-parse', '--verify', head + '^{tree}').toString().trim();
    if (!/^[0-9a-f]{40}$/.test(tree)) throw Error('CONTAINED_COMMIT_INVALID');
    return { tree, files: exportContainedCandidate(workspace, tree) };
  } catch {
    throw Error('CONTAINED_COMMIT_EXPORT_FAILED');
  }
}

/** Export immutable Git objects, not files the candidate can change during upload. */
export function exportContainedCandidate(workspace: string, revision: string): ContainedCandidateFile[] {
  const git = containedGit(workspace);
  const files: ContainedCandidateFile[] = []; let size = 0;
  const listing = git('ls-tree', '-rz', '--full-tree', revision);
  if (!Buffer.from(listing.toString()).equals(listing)) throw Error('CONTAINED_CANDIDATE_UTF8_PATH_REQUIRED');
  for (const row of listing.toString().split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
    if (!match) throw Error('CONTAINED_CANDIDATE_REGULAR_FILES_REQUIRED');
    const bytes = git('cat-file', 'blob', match[2]!); size += bytes.length;
    if (size > 32 * 1024 * 1024 || files.length >= 10000) throw Error('CONTAINED_CANDIDATE_LIMIT');
    if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== match[2]) throw Error('CONTAINED_CANDIDATE_BLOB_MISMATCH');
    files.push({ path: match[3]!, mode: match[1] as '100644' | '100755', bytes });
  }
  return files;
}

/** Grants are synchronous checks; a returned promise cannot be awaited into authority. */
export function authorizeContained(grant: () => void): void {
  const result: unknown = grant();
  if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw Error('CONTAINED_AUTHORITY_MUST_BE_SYNC'); }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: argv crosses into /bin/sh -c; control bytes and lone surrogates are rejected, not escaped.
const argvControl = /[\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** POSIX single-quote each argument into the one string the contained runner passes to /bin/sh -c. */
export function containedCommandFromArgv(argv: readonly string[]): { command: string; argv_digest: string } {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 256 || !argv[0]
    || argv.some(arg => typeof arg !== 'string' || argvControl.test(arg))) throw Error('CONTAINED_ARGV_INVALID');
  const command = argv.map(arg => `'${arg.replaceAll("'", `'\\''`)}'`).join(' ');
  if (command.length > 64000) throw Error('CONTAINED_ARGV_INVALID');
  return { command, argv_digest: sha(canonicalJson([...argv])) };
}
