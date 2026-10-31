/** Explicit candidate assembly over retained inspection facts. No source discovery or activation. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { SourcePin, SourceSnapshot, canonicalJson, sourceDigest } from '@osstack/protocol/source';

const FILE_LIMIT = 512;
const BYTE_LIMIT = 8 * 1024 * 1024;
const Hex = z.string().regex(/^[a-f0-9]{64}$/);
const GitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
function pathSafe(path: string, root = false): boolean {
  if (root && path === '.') return true;
  return path.length > 0 && Buffer.byteLength(path) <= 512 && path.split('/').length <= 64
    && !/[\\:]/.test(path) && ![...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    && !path.startsWith('/') && path.split('/').every(p => p !== '' && p !== '.' && p !== '..' && !/[. ]$/.test(p) && p.toLowerCase() !== '.git');
}
const Repository = z.string().min(1).max(512).refine(s => ![...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  && !/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(s));
const Component = z.object({ id: Id, subdir: z.string().refine(s => pathSafe(s, true)), expectedContentSha256: Hex,
  requires: z.array(Id).max(32), external_requires: z.array(Id).max(32) }).strict();
const Declaration = z.object({ schema_version: z.literal(1), repository: Repository, commit: GitId,
  package_version: z.string().min(1).refine(s => s.trim() === s && Buffer.byteLength(s) <= 128
    && ![...s].some(c => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159))),
  roots: z.array(Id).min(1).max(32), components: z.array(Component).min(1).max(32),
  external_requirements: z.array(z.object({ id: Id, description: z.string().min(1).max(4096) }).strict()).max(32),
}).strict();
const File = z.object({ path: z.string().refine(s => pathSafe(s)), mode: z.enum(['100644', '100755']), blob: GitId,
  bytes: z.number().int().min(0).max(512 * 1024), sha256: Hex, role: z.enum(['source', 'license']) }).strict();
const Inspection = z.object({ kind: z.literal('source_inspection'), schema_version: z.literal(1),
  dependency_resolution: z.literal('not_performed'), repository_identity: z.literal('caller_asserted'),
  expected_digest_checked: z.boolean(), pin: SourcePin, files: z.array(File).min(1).max(FILE_LIMIT), inspection_digest: Hex }).strict();
export type DeclaredAdoptionInput = z.infer<typeof Declaration>;
export type SourceAdoptionErrorCode = 'INVALID_DECLARATION' | 'INVALID_INSPECTION' | 'DIGEST_MISMATCH' | 'SOURCE_MISMATCH'
  | 'DEPENDENCY_MISSING' | 'DEPENDENCY_CYCLE' | 'UNDECLARED_COMPONENT' | 'FILE_CONFLICT' | 'RESOURCE_LIMIT';
export class SourceAdoptionError extends Error {
  constructor(readonly code: SourceAdoptionErrorCode) { super(code); this.name = 'SourceAdoptionError'; }
}
function requireFact(ok: unknown, code: SourceAdoptionErrorCode): asserts ok { if (!ok) throw new SourceAdoptionError(code); }
const unique = (values: string[]) => new Set(values).size === values.length;
const pathOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
type AggregateFile = Omit<z.infer<typeof File>, 'role'> & { component_ids: string[]; roles: { component_id: string; role: 'source' | 'license' }[] };

/** Rechecks declared closure and retained hashes, not the origin of supplied facts.
 * Git object verification belongs to inspectGitSource. This function cannot authenticate
 * a caller who consistently invents facts and hashes, and never emits SourceSnapshot.
 */
export function assembleDeclaredAdoption(declaration: unknown, inspections: unknown) {
  const parsed = Declaration.safeParse(declaration);
  requireFact(parsed.success, 'INVALID_DECLARATION');
  const d = parsed.data;
  try { canonicalJson(d); } catch { throw new SourceAdoptionError('INVALID_DECLARATION'); }
  requireFact(unique(d.roots) && unique(d.components.map(c => c.id)) && unique(d.components.map(c => c.subdir))
    && unique(d.external_requirements.map(e => e.id)) && d.components.every(c => unique(c.requires) && unique(c.external_requires)), 'INVALID_DECLARATION');
  const components = new Map(d.components.map(c => [c.id, c]));
  const external = new Set(d.external_requirements.map(e => e.id)), usedExternal = new Set<string>();
  const active = new Set<string>(), visited = new Set<string>(), order: string[] = [];
  function visit(id: string): void {
    const c = components.get(id); requireFact(c, 'DEPENDENCY_MISSING');
    requireFact(!active.has(id), 'DEPENDENCY_CYCLE'); if (visited.has(id)) return;
    active.add(id);
    for (const dependency of [...c.requires].sort()) visit(dependency);
    for (const dependency of c.external_requires) { requireFact(external.has(dependency), 'DEPENDENCY_MISSING'); usedExternal.add(dependency); }
    active.delete(id); visited.add(id); order.push(id);
  }
  for (const root of [...d.roots].sort()) visit(root);
  requireFact(visited.size === d.components.length && usedExternal.size === external.size, 'UNDECLARED_COMPONENT');
  requireFact(Array.isArray(inspections) && inspections.length === d.components.length, 'INVALID_INSPECTION');
  const facts = new Map<string, z.infer<typeof Inspection>>();
  for (const raw of inspections) {
    const result = Inspection.safeParse(raw); requireFact(result.success, 'INVALID_INSPECTION'); const i = result.data;
    requireFact(i.pin.repository === d.repository && i.pin.commit === d.commit, 'SOURCE_MISMATCH');
    requireFact(pathSafe(i.pin.subdir, true) && !facts.has(i.pin.subdir), 'INVALID_INSPECTION');
    requireFact(d.components.some(c => c.subdir === i.pin.subdir), 'UNDECLARED_COMPONENT');
    requireFact(i.files.every((f,n) => f.blob.length === d.commit.length && (n === 0 || pathOrder(i.files[n-1]!.path, f.path) < 0)), 'INVALID_INSPECTION');
    requireFact(i.files.reduce((sum,f) => sum + f.bytes, 0) <= BYTE_LIMIT, 'RESOURCE_LIMIT');
    requireFact(SourceSnapshot.safeParse({kind:'source_snapshot',schema_version:1,pin:i.pin,
      files:i.files.map(({path,mode,blob})=>({path,mode,blob})),dependencies:[]}).success, 'INVALID_INSPECTION');
    const source = i.files.filter(f => f.role === 'source'), licenses = i.files.filter(f => f.role === 'license');
    requireFact(source.length > 0 && licenses.length > 0 && source.every(f => i.pin.subdir === '.' || f.path.startsWith(`${i.pin.subdir}/`)), 'INVALID_INSPECTION');
    requireFact(same(i.pin.license_refs, [...new Set(licenses.map(f => `sha256:${f.sha256}`))].sort()), 'INVALID_INSPECTION');
    try {
      const content = {schema_version:1,repository:i.pin.repository,commit:i.pin.commit,subdir:i.pin.subdir,files:i.files};
      const {inspection_digest, ...body} = i;
      requireFact(sourceDigest('osstack.joint.source-content.v1',content) === i.pin.content_sha256
        && sourceDigest('osstack.joint.source-inspection.v1',body) === inspection_digest, 'DIGEST_MISMATCH');
    } catch (error) { if (error instanceof SourceAdoptionError) throw error; throw new SourceAdoptionError('INVALID_INSPECTION'); }
    facts.set(i.pin.subdir,i);
  }
  const files = new Map<string, AggregateFile>(), blobs = new Map<string, {bytes:number;sha256:string}>();
  let totalBytes = 0;
  const resultComponents = [...d.components].sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(c => {
    const i = facts.get(c.subdir); requireFact(i, 'INVALID_INSPECTION');
    requireFact(c.expectedContentSha256 === i.pin.content_sha256, 'DIGEST_MISMATCH');
    for (const f of i.files) {
      const {role, ...identity} = f, previous = files.get(f.path), blob = blobs.get(f.blob);
      requireFact(!blob || (blob.bytes === f.bytes && blob.sha256 === f.sha256), 'FILE_CONFLICT');
      blobs.set(f.blob,{bytes:f.bytes,sha256:f.sha256});
      if (previous) {
        requireFact(previous.mode === f.mode && previous.blob === f.blob && previous.bytes === f.bytes && previous.sha256 === f.sha256, 'FILE_CONFLICT');
        previous.component_ids.push(c.id); previous.roles.push({component_id:c.id,role});
      } else {
        files.set(f.path,{...identity,component_ids:[c.id],roles:[{component_id:c.id,role}]});totalBytes += f.bytes;
        requireFact(files.size <= FILE_LIMIT && totalBytes <= BYTE_LIMIT,'RESOURCE_LIMIT');
      }
    }
    return {id:c.id,subdir:c.subdir,requires:[...c.requires].sort(),external_requires:[...c.external_requires].sort(),pin:i.pin,inspection_digest:i.inspection_digest};
  });
  const resultFiles = [...files.values()].sort((a,b)=>pathOrder(a.path,b.path));
  // Apply existing collision/prefix rules also across otherwise separate component trees.
  requireFact(SourceSnapshot.safeParse({kind:'source_snapshot',schema_version:1,pin:resultComponents[0]!.pin,
    files:resultFiles.map(({path,mode,blob})=>({path,mode,blob})),dependencies:[]}).success,'FILE_CONFLICT');
  const result = {kind:'declared_adoption_candidate' as const,schema_version:1 as const,repository:d.repository,commit:d.commit,package_version:d.package_version,
    declared_closure:'verified' as const,semantic_completeness:'not_assessed' as const,repository_identity:'caller_asserted' as const,
    package_version_identity:'caller_asserted' as const,
    activation:false as const,installation:'not_performed' as const,formal_snapshot:false as const,roots:[...d.roots].sort(),dependency_order:order,
    components:resultComponents,files:resultFiles,total_bytes:totalBytes,
    external_requirements:[...d.external_requirements].sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(e=>({...e,status:'not_checked' as const})),
    limitations:['Declared dependencies only; semantic completeness and source discovery are not assessed.',
      'Digest consistency is not authenticated provenance; original Git blob bytes are not re-read.',
      'Package version is caller-asserted; package metadata is not read or authenticated.',
      'No fetch, installation, execution, registry mutation, permission grant or activation.']};
  // Candidate-only domain: do not register it as a formal joint contract.
  let canonicalResult: string;
  try { canonicalResult = canonicalJson(result); }
  catch { throw new SourceAdoptionError('RESOURCE_LIMIT'); }
  const candidate_digest = createHash('sha256').update('osstack.joint.declared-adoption.v1\n' + canonicalResult, 'utf8').digest('hex');
  return {...result,candidate_digest};
}
export type DeclaredAdoption = ReturnType<typeof assembleDeclaredAdoption>;
