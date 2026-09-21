import { execFile } from 'node:child_process';

const queries = {
  commonDir: ['rev-parse', '--git-common-dir'],
  topLevel: ['rev-parse', '--show-toplevel'],
  worktrees: ['worktree', 'list', '--porcelain', '-z'],
} as const;

/** Bounded, read-only Git identity queries. No inherited repository/config redirection. */
export function readRepositoryGit(cwd: string, query: keyof typeof queries): Promise<string> {
  const args = queries[query];
  if (!args) return Promise.reject(new Error('unsupported repository identity query'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setImmediate> | undefined;
    let settled = false;
    let expired = false;
    const finish = (error: Error | null, stdout = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); if (expiry) clearImmediate(expiry);
      if (error) reject(error); else resolve(stdout);
    };
    const child = execFile('git', [...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024, shell: false,
      killSignal: 'SIGKILL' }, (error, stdout) => {
      finish(expired ? new Error('repository Git query timed out') : error, stdout);
    });
    // execFile's built-in timer destroys output streams even when the child has
    // exited but the host was busy. Drain queued I/O before deciding it is hung.
    timeout = setTimeout(() => {
      expiry = setImmediate(() => {
        if (settled) return;
        if (child.exitCode === null && child.signalCode === null) {
          expired = true;
          child.kill('SIGKILL');
        }
        // A descendant retaining a pipe cannot make an exited leader unbounded.
        // Allow pending close/data events to drain, then fail closed, never use
        // partial output. This does not give a live Git process more run time.
        timeout = setTimeout(() => {
          finish(new Error('repository Git output did not close after deadline'));
          child.stdout?.destroy(); child.stderr?.destroy();
        }, 250);
      });
    }, 5_000);
  });
}
