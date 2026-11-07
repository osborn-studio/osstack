// Read-only production effects for restart receipt reconciliation. No App token or command writer is accepted here.
import type { RevisionPublicationDeps } from './contained-mission-revision-publication.js';
import type { GhExec, GraphqlTransport } from './contained-mission-bridge-reader.js';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function createReceiptReadAdapters(options: {
  signal: AbortSignal;
  git?: typeof import('@osstack/agents').runHardenedGit;
  inspect?: typeof import('@osstack/agents').inspectRepoConfig;
  exec?: GhExec;
  transport?: GraphqlTransport;
}): Promise<Pick<RevisionPublicationDeps, 'remoteHead' | 'localGit' | 'compare' | 'readPr' | 'remoteIsDescendant'>> {
  const [{ runHardenedGit, inspectRepoConfig }, publication, ledger, reader] = await Promise.all([
    import('@osstack/agents'), import('./contained-mission-revision-publication.js'), import('./contained-mission-bridge-ledger.js'), import('./contained-mission-bridge-reader.js'),
  ]);
  const exec: GhExec = (args, call) => (options.exec ?? reader.defaultGhExec)(args, { ...call,
    signal: call.signal ? AbortSignal.any([call.signal, options.signal]) : options.signal });
  const transport = options.transport ?? reader.ghGraphqlTransport(exec);
  const git = options.git ?? runHardenedGit;
  const run = (cwd: string, args: readonly string[], okExitCodes = [0]) => {
    if (options.signal.aborted) throw Error('receipt_recovery_aborted');
    return git(args, { cwd, signal: options.signal, timeoutMs: 30_000, maxOutputBytes: 1_048_576, okExitCodes });
  };
  const active = () => { if (options.signal.aborted) throw Error('receipt_recovery_aborted'); };
  return {
    // Recovery needs one local ancestry command, never arbitrary git arguments from a caller.
    localGit: async (cwd, args) => {
      if (args.length !== 4 || args[0] !== 'merge-base' || args[1] !== '--is-ancestor' || !SHA.test(args[2]!) || !SHA.test(args[3]!)) throw Error('receipt_git_read_refused');
      const result = await run(cwd, args, [0, 1]);
      return { stdout: result.stdout.toString('utf8'), exitCode: result.exitCode };
    },
    remoteHead: async (cwd, remote, branch, repository) => {
      if (!repository || !REPOSITORY.test(repository) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)
        || !branch || branch.startsWith('-') || /[\s\0~^:?*[\\]/.test(branch) || branch.includes('..') || branch.includes('@{')) throw Error('receipt_remote_target_invalid');
      const inspected = await (options.inspect ?? inspectRepoConfig)(cwd, { signal: options.signal, timeoutMs: 30_000 });
      if (inspected.rejections.length) throw Error('receipt_repo_config_refused');
      await run(cwd, ['check-ref-format', `refs/heads/${branch}`]);
      const urls = (await run(cwd, ['remote', 'get-url', '--push', '--all', '--', remote])).stdout.toString('utf8').trim().split('\n');
      // Pin the exact granted GitHub repository. Never execute a configured remote helper or an upload-pack override.
      if (urls.length !== 1 || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(urls[0]!)) throw Error('receipt_remote_target_invalid');
      const target = new URL(urls[0]!);
      const name = target.pathname.slice(1).replace(/\/$/, '').replace(/\.git$/, '');
      if (name.toLowerCase() !== repository.toLowerCase()) throw Error('receipt_remote_repository_mismatch');
      const output = (await run(cwd, ['ls-remote', '--refs', '--', `https://github.com/${repository}.git`, `refs/heads/${branch}`])).stdout.toString('utf8').trim();
      if (!output) return null;
      const rows = output.split('\n'); const fields = rows[0]!.split('\t');
      if (rows.length !== 1 || !SHA.test(fields[0] ?? '') || fields[1] !== `refs/heads/${branch}`) throw Error('receipt_remote_read_invalid');
      return fields[0]!;
    },
    compare: async (repository, oldHead, newHead) => { active(); const result = await ledger.compareBridgeLedgerRange(repository, oldHead, newHead, exec, options.signal); active(); return result; },
    remoteIsDescendant: async (repository, ancestor, head) => { active(); const result = await publication.readRevisionAncestry(repository, ancestor, head, exec); active(); return result; },
    readPr: async (repository, number) => { active(); const result = await publication.readRevisionPr(repository, number, transport); active(); return result; },
  };
}
