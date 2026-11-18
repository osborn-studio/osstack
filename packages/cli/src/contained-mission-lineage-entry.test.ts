import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const INSERT_FILES = ['packages/core/src/state/engineering-contained-store.ts'];
const ROOT_FILES = ['packages/cli/src/contained-mission-host.ts'];
const DERIVED_FILES = ['packages/cli/src/contained-mission-github-ci.ts', 'packages/cli/src/contained-mission-revision.ts', 'packages/core/src/state/engineering-local-failure-dispatch-store.ts'];
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (['dist', 'node_modules'].includes(e.name)) return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? sources(path) : path.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(path) ? [path] : [];
  });
}
it('keeps contained Mission and lineage registration behind the store and approved derived callers', () => {
  const files = readdirSync(resolve(ROOT, 'packages')).flatMap(pkg => {
    try { return sources(join(ROOT, 'packages', pkg, 'src')); } catch { return []; }
  }).map(path => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));
  const matching = (pattern: RegExp) => files.filter(f => pattern.test(f.text)).map(f => f.path).sort();
  for (const table of ['engineering_contained_missions', 'engineering_mission_lineage'])
    expect(matching(new RegExp(`(?:INSERT(?:\\s+OR\\s+\\w+)?|REPLACE)\\s+INTO\\s+${table}\\b`, "i"))).toEqual(INSERT_FILES);
  expect(matching(/UPDATE\s+engineering_mission_lineage\s+SET\s+chain_depth\s*=/i)).toEqual([]);
  expect(files.filter(f => /(?:store|missions)\.authorize\(/.test(f.text) && /\bclaim\b/.test(f.text)).map(f => f.path).sort()).toEqual(ROOT_FILES);
  for (const f of files) {
    if (/\.registerDerived\s*\(/.test(f.text)) expect(f.text, f.path).toMatch(/["']depth_limit["']/);
    if (!INSERT_FILES.includes(f.path) && /(?:[<>=!]+\s*MAX_REPAIR_CHAIN_DEPTH|MAX_REPAIR_CHAIN_DEPTH\s*[<>=!]+)/.test(f.text))
      expect(f.text, f.path).toMatch(/\.(registerDerived|resolveLineage)\(/);
  }
  for (const trigger of ['engineering_mission_lineage_depth_cap', 'engineering_mission_depth_stop'])
    expect(matching(new RegExp('CREATE TRIGGER ' + trigger))).toEqual(['packages/core/src/state/engineering-chain-depth-gate-ddl.ts']);
  expect(matching(/\.registerDerived\s*\(/)).toEqual(DERIVED_FILES);
});
