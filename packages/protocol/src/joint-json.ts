// Joint names over the neutral canonical JSON. Keeps the joint error code and domain registry.
import { canonicalJson, domainDigest, parseCanonicalJson, parseCanonicalJsonBytes, type CanonicalJson } from './canonical-json.js';
import { joint } from './joint-errors.js';

export type JointJson = CanonicalJson;
export const JOINT_DIGEST_DOMAINS = Object.freeze([
  'method-binding.v1', 'method-proposal.v1', 'support-profile.v2', 'source-snapshot.v1',
  'artifact-requirements.v1', 'role-artifact-requirements.v1', 'check-binding.v1', 'intent.v1',
  'method-recipe.v1', 'method-input.v1', 'environment.v1', 'scenario.v1', 'check-registry.v1',
  'schema-spec.v1', 'recovery-subject.v1', 'trial-root.v1',
  'recovery-request-input.v1', 'trial-consumption-input.v1',
  'source-content.v1', 'source-inspection.v1',
].map(name => `osstack.joint.${name}`));
const domains = new Set(JOINT_DIGEST_DOMAINS);

/** Parse raw wire text before duplicate keys or -0 can be lost by JSON.parse. */
export const parseJointJson = (raw: string): JointJson => joint(() => parseCanonicalJson(raw));
/** Fatal UTF-8 decoding prevents replacement characters from hiding invalid wire bytes. */
export const parseJointJsonBytes = (raw: Uint8Array): JointJson => joint(() => parseCanonicalJsonBytes(raw));
/** Canonicalize JSON values only. Schema validation and authority checks are separate. */
export const canonicalJointJson = (value: unknown): string => joint(() => canonicalJson(value));

export function jointDigest(domain: string, value: unknown): string {
  if (!domains.has(domain)) throw new Error('UNKNOWN_JOINT_DIGEST_DOMAIN');
  return joint(() => domainDigest(domain, value));
}
