import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { workerCanonical } from '@osstack/protocol';
import { graphProgramVersion, resolveGraphProgram, V4_GRAPH_PROGRAM } from './program-resolver.js';

// A future current compiler must not be consulted when resolving historical v4.
vi.mock('./spec-compiler.js', () => ({ compileGraphSpec: () => { throw Error('CURRENT_COMPILER_MUST_NOT_RUN'); } }));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/code-delivery-v4.json', import.meta.url), 'utf8')) as {
  cases: Array<{ spec: unknown; sourceDigest: string; specHash: string; planDigest: string; budget: {maxActionStarts: number; tokenReservationLimit: number} }>;
};

describe('historical graph program resolver', () => {
  it('pins the published implementation and original fixture bytes', () => {
    expect(fixture.cases).toHaveLength(9);
    const files = {
      'legacy/code-delivery-v4.ts': '95add8856e1a8a9c05c042caf8c6a3a8cb380fd185871d9d9ab4c89851394061',
      'legacy/code-delivery-registry-v3.ts': '64bde75484c36e71f0e972d362a1156aff61e097aff90892c9c95cf6340433f4',
      'fixtures/code-delivery-v4.json': 'd53c588f75abdaf9bc156deea718fb9be23cb64517a88b7a7407d1264fd3e7ea',
    };
    for (const [file, digest] of Object.entries(files)) {
      expect(createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')).toBe(digest);
    }
  });
  it('rejects absent digests and accessors even for a supported identity', () => {
    expect(() => resolveGraphProgram(fixture.cases[0]!.spec, V4_GRAPH_PROGRAM)).toThrow('GRAPH_PROGRAM_IDENTITY_MISMATCH');
    const touched = vi.fn();
    expect(() => resolveGraphProgram({ get input() { touched(); return {}; } }, { ...V4_GRAPH_PROGRAM, compiledProgramDigest: fixture.cases[0]!.sourceDigest })).toThrow();
    expect(touched).not.toHaveBeenCalled();
  });
  it.each(fixture.cases)('preserves frozen v4 source, spec, plan and budget $sourceDigest', example => {
    const compiled = resolveGraphProgram(example.spec, { ...V4_GRAPH_PROGRAM, compiledProgramDigest: example.sourceDigest, specHash: example.specHash });
    expect(compiled.compiledProgramDigest).toBe(example.sourceDigest);
    expect(compiled.specHash).toBe(example.specHash);
    expect(createHash('sha256').update(workerCanonical(compiled.plan)).digest('hex')).toBe(example.planDigest);
    expect(compiled.budget).toEqual(example.budget);
    expect(graphProgramVersion(compiled)).toEqual({ ...V4_GRAPH_PROGRAM, compiledProgramDigest: example.sourceDigest });
  });
  it.each(Object.keys(V4_GRAPH_PROGRAM))('rejects unsupported %s without interpreting the spec', key => {
    const touched = vi.fn();
    const spec = { get input() { touched(); return {}; } };
    expect(() => resolveGraphProgram(spec, { ...V4_GRAPH_PROGRAM, [key]: 'future', compiledProgramDigest: fixture.cases[0]!.sourceDigest })).toThrow('GRAPH_PROGRAM_UNSUPPORTED');
    expect(touched).not.toHaveBeenCalled();
  });
  it('keeps the frozen compiler independent of public forwarding modules', () => {
    const source = readFileSync(new URL('./legacy/code-delivery-v4.ts', import.meta.url), 'utf8');
    expect(source).toContain("from './code-delivery-registry-v3.js'");
    expect(source).not.toMatch(/from ['"][^'"]*\/(?:registry|spec-compiler)\.js['"]/);
  });
  it('rejects changed source or spec identity and missing historical specs', () => {
    const example = fixture.cases[0]!;
    expect(() => resolveGraphProgram(example.spec, { ...V4_GRAPH_PROGRAM, compiledProgramDigest: 'b'.repeat(64) })).toThrow('GRAPH_PROGRAM_IDENTITY_MISMATCH');
    expect(() => resolveGraphProgram(example.spec, { ...V4_GRAPH_PROGRAM, compiledProgramDigest: example.sourceDigest, specHash: 'b'.repeat(64) })).toThrow('GRAPH_PROGRAM_IDENTITY_MISMATCH');
    expect(() => resolveGraphProgram(null, { ...V4_GRAPH_PROGRAM, compiledProgramDigest: example.sourceDigest })).toThrow();
    const compiled = resolveGraphProgram(example.spec, { ...V4_GRAPH_PROGRAM, compiledProgramDigest: example.sourceDigest });
    expect(() => graphProgramVersion({ ...compiled, compilerVersion: 'future' })).toThrow('GRAPH_PROGRAM_UNSUPPORTED');
    expect(() => graphProgramVersion({ ...compiled, source: compiled.source + '\n' })).toThrow('GRAPH_PROGRAM_IDENTITY_MISMATCH');
  });
});
