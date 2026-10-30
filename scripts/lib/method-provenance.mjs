import { createHash } from 'node:crypto';

const sha = b => createHash('sha256').update(b).digest('hex');
const hex = (v, n) => typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const fail = (reason, detail = '') => { throw Error(`provenance_${reason}${detail ? ': ' + detail : ''}`); };
function object(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail('shape');
}
function text(value, max) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && Buffer.byteLength(value) <= max && ![...value].some(c => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));
}
function path(value) {
  return text(value, 512) && value.split('/').length <= 64 && !/[\\:]/.test(value)
    && value.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git' && !/[. ]$/.test(p));
}
function list(value, max) { if (!Array.isArray(value) || value.length < 1 || value.length > max) fail('shape'); }

/** Checks a declared source label and the exact adapted material bytes.
 * Does not fetch upstream or authenticate the adoption report named by its digest.
 * JSON duplicate object keys follow JSON.parse's last-value semantics.
 */
export function inspectMethodProvenance(sources) {
  const bytes = sources.get('provenance.json');
  if (bytes === undefined) return undefined;
  if (bytes.length > 65536) fail('limit');
  let d;
  try { d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('json'); }
  object(d, ['kind', 'schema_version', 'upstream', 'adoption_candidate_digest', 'bindings']);
  if (d.kind !== 'declared_method_provenance' || d.schema_version !== 1 || !hex(d.adoption_candidate_digest, 64)) fail('shape');
  object(d.upstream, ['repository', 'commit', 'subdir', 'package_version']);
  let url;
  try { url = new URL(d.upstream.repository); } catch { fail('repository'); }
  if (!text(d.upstream.repository, 512) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname) fail('repository');
  if (!(hex(d.upstream.commit, 40) || hex(d.upstream.commit, 64)) || !path(d.upstream.subdir) || !text(d.upstream.package_version, 128)) fail('source');
  list(d.bindings, 32);
  const bound = new Set(), sourceHashes = new Map();
  for (const b of d.bindings) {
    object(b, ['material', 'sha256', 'source_refs']);
    if (!path(b.material) || !b.material.startsWith('references/') || !b.material.endsWith('.md') || bound.has(b.material) || !hex(b.sha256, 64)) fail('binding');
    bound.add(b.material);
    const material = sources.get(b.material);
    if (material === undefined) fail('material_missing', b.material);
    if (sha(material) !== b.sha256) fail('material_drift', b.material);
    list(b.source_refs, 32);
    const seen = new Set();
    for (const ref of b.source_refs) {
      object(ref, ['path', 'sha256', 'role']);
      if (!['adopted_guidance', 'context_only', 'identity_license'].includes(ref.role)) fail('source_role');
      if (!path(ref.path) || !ref.path.startsWith(`${d.upstream.subdir}/`) || seen.has(ref.path) || !hex(ref.sha256, 64)) fail('source_reference');
      seen.add(ref.path);
      if (sourceHashes.has(ref.path) && sourceHashes.get(ref.path) !== ref.sha256) fail('source_conflict', ref.path);
      sourceHashes.set(ref.path, ref.sha256);
    }
  }
  return {
    status: 'declared_material_hashes_checked', file: 'provenance.json', sha256: sha(bytes),
    upstream: d.upstream, adoption_candidate_digest: d.adoption_candidate_digest,
    bound_materials: [...bound].sort(),
    unbound_materials: [...sources.keys()].filter(p => p.startsWith('references/') && !bound.has(p)).sort(),
    authenticated: false, upstream_content_verified: false, host_delivery_verified: false,
    limitation: 'Declared upstream references and adoption digest are not re-read or authenticated by export; only listed adapted material bytes are checked. Unbound files retain their documented source. Source-reference roles distinguish adapted guidance, consulted context and identity/license. JSON duplicate keys use last-value semantics; consumers must use the same rule.',
  };
}
