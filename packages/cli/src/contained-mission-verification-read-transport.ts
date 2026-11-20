import { execFile } from 'node:child_process';

export type VerificationRest = (path: string, options: { signal: AbortSignal; method?: string }) =>
  Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false }>;

const route = /^repos\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\/(?:pulls\/[1-9]\d*|commits\/[a-f0-9]{40}\/check-suites\?per_page=100&page=[1-9]\d*|check-suites\/[1-9]\d*\/check-runs\?filter=all&per_page=100&page=[1-9]\d*|check-runs\/[1-9]\d*)$/u;

export function createVerificationRest(deps: { readonly execFileImpl?: typeof execFile } = {}): VerificationRest {
  const exec = deps.execFileImpl ?? execFile;
  return async (path, options) => {
    try {
      const { signal } = options;
      if (signal.aborted || ('method' in options && options.method !== 'GET') || path.includes('..')) return { ok: false };
      const repository = route.exec(path)?.[1];
      if (!repository || repository.length > 200) return { ok: false };
      const stdout = await new Promise<string>((resolve, reject) => {
        exec('gh', ['api', '--hostname', 'github.com', '--method', 'GET', path],
          { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, signal },
          (error, output) => error ? reject(error) : resolve(output));
      });
      return signal.aborted ? { ok: false } : { ok: true, body: JSON.parse(stdout) as unknown };
    } catch { return { ok: false }; }
  };
}
