// The merger reader and its config must never reach App-credential code (merger design §5.3): follow every relative import, static or dynamic, transitively.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = ['contained-mission-bridge.ts', 'contained-mission-github-app.ts'];

export function importClosure(entry: string): { files: string[]; externals: string[] } {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(join(here, file), 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/gu)) {
      const spec = m[1] as string;
      if (spec.startsWith('.')) visit(resolve('/', spec).slice(1).replace(/\.js$/u, '.ts'));
      else externals.add(spec);
    }
  };
  visit(entry);
  return { files: [...seen].sort(), externals: [...externals].sort() };
}

describe('merger isolation: import graph', () => {
  for (const entry of ['contained-mission-merger-reader.ts', 'contained-mission-merger-config.ts', 'contained-mission-redact.ts', 'contained-mission-merger-shadow.ts', 'contained-mission-merger-report.ts']) {
    it(`${entry} never reaches the App-credential modules`, () => {
      const { files, externals } = importClosure(entry);
      for (const f of FORBIDDEN) expect(files, `${entry} -> ${f}`).not.toContain(f);
      expect(files.some((f) => /github-app|apps\.json|rulesets\.json/u.test(f))).toBe(false);
      expect(externals).not.toContain('@osstack/github');
    });
  }

  it('the closure of the reader is exactly the expected small set', () => {
    expect(importClosure('contained-mission-merger-reader.ts').files).toEqual(['contained-mission-bridge-reader.ts', 'contained-mission-marker.ts', 'contained-mission-merger-reader.ts']);
  });

  it('the service-side modules stay inside a known set: the shadow merger never reaches the bridge kit or the App token code', () => {
    expect(importClosure('contained-mission-merger-shadow.ts').files).toEqual([
      'contained-mission-bridge-reader.ts', 'contained-mission-bridge-registry.ts', 'contained-mission-bridge-shadow.ts', 'contained-mission-marker.ts',
      'contained-mission-merger-config.ts', 'contained-mission-merger-reader.ts', 'contained-mission-merger-shadow.ts', 'contained-mission-publication.ts',
    ]);
    expect(importClosure('contained-mission-merger-report.ts').files).toEqual(['contained-mission-merger-report.ts']);
  });

  it('the checker itself detects a forbidden edge (bridge.ts reaches the credential module)', () => {
    expect(importClosure('contained-mission-bridge.ts').files).toContain('contained-mission-github-app.ts');
  });

  it('the redact module has no relative imports', () => {
    expect(importClosure('contained-mission-redact.ts').files).toEqual(['contained-mission-redact.ts']);
  });
});
