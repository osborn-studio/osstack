import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Observe real Node resolution, outside Vitest's module transform/cache.
it('loads the public descriptor without loading any runtime dependencies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'graph-entry-'));
  try {
    const trace = join(directory, 'modules.jsonl');
    const hook = `
      import { appendFileSync } from 'node:fs';
      export async function resolve(specifier, context, nextResolve) {
        const result = await nextResolve(specifier, context);
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify(result.url) + '\\n');
        return result;
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { register } from 'node:module';
      register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});
      const { GRAPH_KERNEL } = await import('@osstack/graph');
      console.log(JSON.stringify(GRAPH_KERNEL));
    `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    const descriptor = JSON.parse(result.stdout);
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(descriptor).toEqual({
      engine: 'langgraph',
      version: manifest.dependencies['@langchain/langgraph'],
      coreVersion: manifest.dependencies['@langchain/core'],
      checkpointVersion: manifest.dependencies['@langchain/langgraph-checkpoint'],
      workerEntry: '@osstack/graph/worker',
    });
    const modules = readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string);
    expect(modules.filter((url) => url.startsWith('file:'))).toEqual([
      new URL('../dist/index.js', import.meta.url).href,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
