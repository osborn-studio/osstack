import { GraphJsonValue, workerCanonical } from '@osstack/protocol';
import { compileGraphSpec, type CompiledGraphSpec } from './legacy/code-delivery-v4.js';

export const V4_GRAPH_PROGRAM = Object.freeze({
  executionModel: 'langgraph-functional-v1' as const,
  durability: 'sync' as const,
  engineVersion: '1.4.15',
  checkpointVersion: '1.1.5',
  templateVersion: '4',
  registryVersion: 'code-delivery-registry-v3',
  compilerVersion: 'code-delivery-functional-v4',
  schemaVersion: 'code-delivery-schema-v3',
});

/** Deliberately remains v4-only even if the general resolver gains new programs. */
export function resolveV4GraphProgram(spec: unknown, identity: unknown): CompiledGraphSpec {
  const parsed = GraphJsonValue.safeParse(identity);
  if (!parsed.success || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw Error('GRAPH_PROGRAM_UNSUPPORTED');
  }
  const snapshot = parsed.data;
  if (Object.entries(V4_GRAPH_PROGRAM).some(([key, value]) => snapshot[key] !== value)) {
    throw Error('GRAPH_PROGRAM_UNSUPPORTED');
  }
  const compiled = compileGraphSpec(spec);
  if (snapshot.compiledProgramDigest !== compiled.compiledProgramDigest ||
      ('specHash' in snapshot && snapshot.specHash !== compiled.specHash)) {
    throw Error('GRAPH_PROGRAM_IDENTITY_MISMATCH');
  }
  return compiled;
}

/** Resolve persisted identities before interpreting their specs. Unknown tuples fail closed. */
export function resolveGraphProgram(spec: unknown, identity: unknown): CompiledGraphSpec {
  return resolveV4GraphProgram(spec, identity);
}

export function graphProgramVersion(compiled: CompiledGraphSpec) {
  const version = { ...V4_GRAPH_PROGRAM, compilerVersion: compiled.compilerVersion,
    registryVersion: compiled.registryVersion, schemaVersion: compiled.schemaVersion,
    compiledProgramDigest: compiled.compiledProgramDigest };
  const historical = resolveGraphProgram(compiled.spec, { ...version, specHash: compiled.specHash });
  if (historical.source !== compiled.source || workerCanonical(historical.plan) !== workerCanonical(compiled.plan) ||
      workerCanonical(historical.budget) !== workerCanonical(compiled.budget)) {
    throw Error('GRAPH_PROGRAM_IDENTITY_MISMATCH');
  }
  return version;
}
