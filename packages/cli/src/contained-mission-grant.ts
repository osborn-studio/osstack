// Revision grants for the Grok bridge (phase 5-A, appendix §5.1). Daemon side: issuer key configuration, the grant/re-grant
// service behind `mission.revision_grant_preview`, `mission.revision_grant_renew_preview`, `mission.grant_revisions` and
// `mission.chain_decide`, and `assertGrantLive`, the synchronous re-validation later PRs run before each dispatch and remote
// write. Lazy-imported only.
//
// Why a signature and not only a TTY check: `mission.*` RPC authenticates with a bearer credential, so a client-side TTY test
// cannot stop another process that holds it. The grant is therefore signed with a host-private Ed25519 issuer key that the
// daemon never holds; the daemon only verifies. A same-UID process that can read the key file is outside this boundary, exactly
// as for `follow-up-delivery issue-grant`.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { recordChildCancelFailure } from './contained-mission-bridge-cancel-failure.js';
import {
  GRANT_LIMITS,
  RENEWABLE_STOP_REASONS,
  RevisionGrantError,
  assembleGrant,
  canonicalJson,
  grantBindsChain,
  parseRevisionGrantPreview,
  parseStoredGrant,
  previewDigest,
  publicKeyFromSpkiB64,
  resolveGrantTerms,
  sameProducer,
  verifyRevisionGrantSignature,
  type ContainedMissionStore,
  type EngineeringPrincipal,
  type GrantBudget,
  type GrantTerms,
  type ProducerIdentity,
  type RevisionChain,
  type RevisionChainStore,
  type RevisionGrant,
  type RevisionGrantPreview,
} from '@osstack/core';
import type { EngineeringAccess } from './engineering-access.js';
import { readPrivateDeliveryFile } from './follow-up-delivery-host.js';
import { reviewerOf, type PullRequestRead, type PullRequestRef } from './contained-mission-bridge-reader.js';
import type { ShadowMissionPublication } from './contained-mission-bridge-shadow.js';

// ------------------------------------------------------------------ issuer configuration

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const issuerSchema = z.object({
  version: z.literal(1),
  keys: z.array(z.object({
    key_id: z.string().regex(KEY_ID),
    public_key_spki_b64: z.string().min(40).max(200),
    max_validity_ms: z.number().int().min(1000).max(GRANT_LIMITS.max_validity_ms),
  }).strict()).min(1).max(8),
}).strict();

export interface IssuerKey { readonly key_id: string; readonly public_key: KeyObject; readonly max_validity_ms: number }
export interface IssuerConfig { readonly keys: ReadonlyMap<string, IssuerKey> }
const invalid = (reason: string): Error => new Error(`BRIDGE_CONFIG_INVALID:revision-issuer.json:${reason}`);
export const issuerConfigPath = (home: string): string => join(home, 'bridge', 'revision-issuer.json');
export const issuerKeyPath = (home: string, keyId: string): string => join(home, 'bridge', `revision-issuer-${keyId}.pem`);

/** `$OSSTACK_HOME/bridge/revision-issuer.json`. Missing -> undefined. Present but unreadable, insecure or invalid -> `BRIDGE_CONFIG_INVALID`.
 * Only public keys live here; the private key is read by the client at signing time and never by the daemon. */
export async function loadRevisionIssuer(home: string): Promise<IssuerConfig | undefined> {
  let raw: Buffer;
  try { raw = await readPrivateDeliveryFile(issuerConfigPath(home), 65_536); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw invalid('unreadable');
  }
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw invalid('json'); }
  const parsed = issuerSchema.safeParse(json);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.path.join('.') || 'root');
  const keys = new Map<string, IssuerKey>();
  for (const k of parsed.data.keys) {
    if (keys.has(k.key_id)) throw invalid('duplicate_key_id');
    let publicKey: KeyObject;
    try { publicKey = publicKeyFromSpkiB64(k.public_key_spki_b64); } catch { throw invalid('public_key'); }
    keys.set(k.key_id, { key_id: k.key_id, public_key: publicKey, max_validity_ms: k.max_validity_ms });
  }
  return { keys };
}

/** Client side: the private half. The file must be a 0600 regular file in a 0700 directory owned by the caller, opened without
 * following links, and its public key must equal the one the daemon trusts. */
export async function readIssuerPrivateKey(home: string, key: IssuerKey): Promise<KeyObject> {
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey(await readPrivateDeliveryFile(issuerKeyPath(home, key.key_id), 8192)); } catch { throw new Error('grant_key_unreadable'); }
  const same = privateKey.asymmetricKeyType === 'ed25519'
    && createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(key.public_key.export({ type: 'spki', format: 'der' }));
  if (!same) throw new Error('grant_key_mismatch');
  return privateKey;
}

/** Generates a fresh issuer key pair on this host: the private key to `revision-issuer-<id>.pem` (0600, exclusive create) and the
 * public half appended to `revision-issuer.json`. Refuses to overwrite an existing key id. Returns the public key. */
export async function generateRevisionIssuerKey(home: string, keyId: string, maxValidityMs: number = GRANT_LIMITS.max_validity_ms): Promise<{ key_id: string; public_key_spki_b64: string }> {
  if (!KEY_ID.test(keyId) || !Number.isSafeInteger(maxValidityMs) || maxValidityMs < 1000 || maxValidityMs > GRANT_LIMITS.max_validity_ms) throw new Error('grant_key_invalid');
  const dir = join(home, 'bridge');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await stat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('grant_key_invalid');
  const existing = await loadRevisionIssuer(home);
  if (existing?.keys.has(keyId)) throw new Error('grant_key_exists');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const pem = await open(issuerKeyPath(home, keyId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await pem.writeFile(privateKey.export({ type: 'pkcs8', format: 'pem' })); await pem.sync(); } finally { await pem.close(); }
  const keys = [...(existing?.keys.values() ?? [])].map(k => ({ key_id: k.key_id, public_key_spki_b64: k.public_key.export({ type: 'spki', format: 'der' }).toString('base64'), max_validity_ms: k.max_validity_ms }));
  keys.push({ key_id: keyId, public_key_spki_b64: spki, max_validity_ms: maxValidityMs });
  const tmp = `${issuerConfigPath(home)}.${randomUUID()}.tmp`;
  const file = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(`${JSON.stringify({ version: 1, keys })}\n`); await file.sync(); } finally { await file.close(); }
  await rename(tmp, issuerConfigPath(home));
  const parent = await open(dirname(issuerConfigPath(home)), constants.O_RDONLY);
  try { await parent.sync(); } finally { await parent.close(); }
  return { key_id: keyId, public_key_spki_b64: spki };
}

// ------------------------------------------------------------------ re-validation (before every dispatch and remote write)

export interface GrantLiveContext {
  /** Re-reads the authority file on every call (`EngineeringAccess.refresh`). */
  readonly access: Pick<EngineeringAccess, 'refresh'>;
  readonly keys: ReadonlyMap<string, IssuerKey>;
  readonly now: number;
}

/** Synchronous check that a live chain's grant still authorises work now. Throws `RevisionGrantError`:
 * `grant_invalid` (unparsable, wrong binding, bad or unknown-key signature, principal or write scope gone),
 * `grant_expired` (`now >= expires_at`), `budget_exhausted` (the chain's wall-clock allowance since its budget origin is spent).
 * It checks the signature every time, so a grant rewritten in the database fails here even if the triggers let the row through. */
export function assertGrantLive(chain: RevisionChain, ctx: GrantLiveContext): RevisionGrant {
  if (chain.mode !== 'live') throw new RevisionGrantError('grant_invalid');
  let grant: RevisionGrant;
  try { grant = parseStoredGrant(chain.grant_json); } catch { throw new RevisionGrantError('grant_invalid'); }
  const key = ctx.keys.get(grant.key_id);
  if (!key || !grantBindsChain(grant, chain) || !verifyRevisionGrantSignature(grant, key.public_key)) throw new RevisionGrantError('grant_invalid');
  if (grant.expires_at - grant.issued_at > key.max_validity_ms) throw new RevisionGrantError('grant_invalid');
  if (ctx.now >= grant.expires_at) throw new RevisionGrantError('grant_expired');
  const origin = budgetOrigin(chain, grant);
  if (ctx.now >= origin + grant.budget.max_wall_clock_hours * 3_600_000) throw new RevisionGrantError('budget_exhausted');
  let principal: EngineeringPrincipal;
  try { principal = ctx.access.refresh(grant.principal_id, grant.client_session_id); } catch { throw new RevisionGrantError('grant_invalid'); }
  if (!principal.write_scopes.includes(grant.scope_id)) throw new RevisionGrantError('grant_invalid');
  return grant;
}
function budgetOrigin(chain: RevisionChain, grant: RevisionGrant): number {
  if (chain.budget_json === null) return grant.issued_at;
  try {
    const origin = (JSON.parse(chain.budget_json) as { origin?: unknown }).origin;
    if (typeof origin === 'number' && Number.isSafeInteger(origin) && origin >= 0) return origin;
  } catch { /* fall through */ }
  throw new RevisionGrantError('grant_invalid');
}

/** `assertGrantLive`, and on failure stop the chain for a human (`grant_expired` / `grant_invalid` / `budget_exhausted`) before rethrowing.
 * Callers that already hold a newer chain row get `version_conflict` from the store and should re-read. */
export function enforceGrantLive(chains: Pick<RevisionChainStore, 'stopLive'>, chain: RevisionChain, ctx: GrantLiveContext): RevisionGrant {
  try { return assertGrantLive(chain, ctx); }
  catch (error) {
    if (error instanceof RevisionGrantError && chain.state !== 'closed' && chain.state !== 'awaiting_decision') {
      chains.stopLive(chain.chain_id, chain.revision, error.code === 'grant_signature_invalid' ? 'grant_invalid' : error.code, ctx.now);
    }
    throw error;
  }
}

// ------------------------------------------------------------------ service

const MissionId = z.string().regex(/^cm_[0-9a-f-]{36}$/);
const ChainId = z.string().regex(/^rc_[0-9a-f-]{36}$/);
const Terms = {
  rounds: z.union([z.literal(1), z.literal(2)]).optional(),
  expires_ms: z.number().int().min(1).max(GRANT_LIMITS.max_validity_ms).optional(),
  review_deadline_ms: z.number().int().min(GRANT_LIMITS.min_review_deadline_ms).max(GRANT_LIMITS.max_review_deadline_ms).optional(),
  budget: z.object({
    max_executor_seconds: z.number().int().min(1).max(GRANT_LIMITS.max_budget.max_executor_seconds).optional(),
    max_container_seconds: z.number().int().min(1).max(GRANT_LIMITS.max_budget.max_container_seconds).optional(),
    max_wall_clock_hours: z.number().int().min(1).max(GRANT_LIMITS.max_budget.max_wall_clock_hours).optional(),
  }).strict().optional(),
  key_id: z.string().regex(KEY_ID).optional(),
};
export const RevisionGrantRpc = {
  'mission.revision_grant_preview': z.object({ mission_id: MissionId, ...Terms }).strict(),
  'mission.revision_grant_renew_preview': z.object({ chain_id: ChainId, ...Terms }).strict(),
  'mission.grant_revisions': z.object({
    nonce: z.string().regex(/^[0-9a-f]{32}$/), preview_sha256: z.string().regex(/^[0-9a-f]{64}$/), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  }).strict(),
  'mission.chain_decide': z.object({ chain_id: ChainId, decision: z.enum(['abandon', 'takeover', 'reconcile']) }).strict(),
} as const;
type TermsInput = { rounds?: 1 | 2 | undefined; expires_ms?: number | undefined; review_deadline_ms?: number | undefined; budget?: Partial<GrantBudget> | undefined; key_id?: string | undefined };

export interface GrantMissionView {
  /** Throws when the actor cannot read the Mission. */
  readable(actor: EngineeringPrincipal, missionId: string): { scope_id: string };
  /** Null unless the Mission is `pr_opened` with an opened publication. */
  publication(missionId: string): ShadowMissionPublication | null;
  state(missionId: string): string;
}
export interface RevisionGrantServiceOptions {
  readonly chains: RevisionChainStore;
  readonly missions: GrantMissionView;
  readonly access: Pick<EngineeringAccess, 'refresh'>;
  /** The only repository grants may be issued for, and the identities allowed to author the PR (`bridge/producers.json`). */
  readonly registry: { readonly repository: string; readonly publisher: readonly ProducerIdentity[] };
  /** Read-only PR read with the host's own credentials. */
  readonly readPr: (ref: PullRequestRef) => Promise<PullRequestRead>;
  readonly loadIssuer: () => Promise<IssuerConfig | undefined>;
  readonly protectedSetDigest: () => string;
  readonly now: () => number;
  /** `OSSTACK_BRIDGE=1` (live). Grants are refused with `bridge_live_disabled` otherwise. */
  readonly enabled: () => boolean;
  /** Requests cancellation of a child Mission after a chain is closed. */
  readonly cancelChild?: (actor: EngineeringPrincipal, missionId: string) => Promise<void>;
  /** Read-only receipt reconciliation of an uncertain push (5-E). Absent in 5-A: `chain-decide reconcile` is then `reconcile_unavailable`. */
  readonly reconcileReceipt?: (chain: RevisionChain) => Promise<{ settled: boolean }>;
}
interface Pending { principal_id: string; client_session_id: string; preview: RevisionGrantPreview; request: { mission_id: string } | { chain_id: string }; terms: TermsInput; created_at: number }

const REPOSITORY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;
const MAX_PENDING = 32;
const TERMINAL = new Set(['pr_opened', 'cancelled', 'abandoned', 'failed']);
const refused = (): never => { throw new Error('grant_refused'); };
const err = (code: string): never => { throw new Error(code); };

export class RevisionGrantService {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly options: RevisionGrantServiceOptions) {}

  async preview(actor: EngineeringPrincipal, input: { mission_id: string } & TermsInput): Promise<{ preview: RevisionGrantPreview; preview_sha256: string; nonce: string; valid_for_ms: number }> {
    this.live();
    const now = this.options.now();
    const { mission_id: _mission, ...terms } = input;
    const preview = await this.buildFirst(actor, input.mission_id, terms, { grant_id: `rg_${randomUUID()}`, issued_at: now, nonce: randomBytes(16).toString('hex') });
    return this.remember(actor, preview, { mission_id: input.mission_id }, terms, now);
  }

  async renewPreview(actor: EngineeringPrincipal, input: { chain_id: string } & TermsInput): Promise<{ preview: RevisionGrantPreview; preview_sha256: string; nonce: string; valid_for_ms: number }> {
    this.live();
    const now = this.options.now();
    const { chain_id: _chain, ...terms } = input;
    const preview = await this.buildRenew(actor, input.chain_id, terms, { grant_id: `rg_${randomUUID()}`, issued_at: now, nonce: randomBytes(16).toString('hex') });
    return this.remember(actor, preview, { chain_id: input.chain_id }, terms, now);
  }

  /** Verifies the signed grant against the pending preview, recomputes every live fact, then writes the chain (or the re-grant) in one transaction. */
  async grant(actor: EngineeringPrincipal, input: { nonce: string; preview_sha256: string; signature: string }): Promise<{ chain_id: string; state: string; rounds: number; expires_at: number; renewed: boolean; head_consumed?: boolean }> {
    this.live();
    const now = this.options.now();
    this.purge(now);
    const record = this.pending.get(input.nonce);
    // Another principal's nonce is neither consumed nor revealed.
    if (!record || record.principal_id !== actor.principal_id || record.client_session_id !== actor.client_session_id) return refused();
    this.pending.delete(input.nonce);
    const { preview } = record;
    if (now > record.created_at + GRANT_LIMITS.nonce_ttl_ms || input.preview_sha256 !== previewDigest(preview)) return refused();
    let grant: RevisionGrant;
    const issuer = await this.options.loadIssuer();
    const key = issuer?.keys.get(preview.key_id);
    if (!key) return refused();
    try { grant = assembleGrant(preview, input.signature); } catch { return refused(); }
    if (!verifyRevisionGrantSignature(grant, key.public_key) || grant.expires_at - grant.issued_at > key.max_validity_ms) return refused();
    // The signer authorised exactly this preview; the facts it described must still hold.
    const fixed = { grant_id: preview.grant_id, issued_at: preview.issued_at, nonce: preview.nonce };
    let fresh: RevisionGrantPreview;
    try {
      fresh = 'mission_id' in record.request ? await this.buildFirst(actor, record.request.mission_id, record.terms, fixed) : await this.buildRenew(actor, record.request.chain_id, record.terms, fixed);
    } catch { return refused(); }
    if (canonicalJson(fresh) !== canonicalJson(preview)) return refused();
    // Everything above awaited; authority and time are judged again here, right before the write, and the write uses this clock.
    const at = this.options.now();
    // The issuer file is read again by the rebuild above; the signature must hold under what is trusted now, not at the first read.
    const finalKey = (await this.options.loadIssuer())?.keys.get(preview.key_id);
    if (!finalKey || !verifyRevisionGrantSignature(grant, finalKey.public_key)) return refused();
    if (at > record.created_at + GRANT_LIMITS.nonce_ttl_ms || at < preview.issued_at || at >= preview.expires_at) return refused();
    let current: EngineeringPrincipal;
    try { current = this.options.access.refresh(actor.principal_id, actor.client_session_id); } catch { return err('permission_denied'); }
    this.assertWrite(current, preview.scope_id);
    const { chains } = this.options;
    if (preview.renews) {
      const { chain, head_consumed } = chains.replaceGrant(preview.renews.chain_id, preview.renews.revision, grant, at);
      // A head that already has a reservation is never revised again; only a new head from this chain's own push can be.
      return { chain_id: chain.chain_id, state: chain.state, rounds: grant.rounds, expires_at: grant.expires_at, renewed: true, head_consumed };
    }
    try {
      const chain = chains.transaction(() => {
        const created = chains.createLiveChain({
          root_mission_id: grant.root_mission_id, repository: grant.repository, pr_number: grant.pr_number, branch: grant.branch, base_ref: grant.base_ref,
          published_head: grant.head_sha, published_base: grant.base_sha, trace_id: `bridge-live:${grant.root_mission_id}`,
          review_deadline: grant.issued_at + grant.review_deadline_ms, budget_origin: grant.issued_at, grant,
        }, at);
        chains.appendEvent(created.chain_id, 'grant_issued', { grant_id: grant.grant_id, rounds: grant.rounds, expires_at: grant.expires_at, key_id: grant.key_id }, at);
        return created;
      });
      return { chain_id: chain.chain_id, state: chain.state, rounds: grant.rounds, expires_at: grant.expires_at, renewed: false };
    } catch (error) {
      if (/UNIQUE|constraint/i.test(error instanceof Error ? error.message : '')) return err('chain_exists');
      throw error;
    }
  }

  async chainDecide(actor: EngineeringPrincipal, input: { chain_id: string; decision: 'abandon' | 'takeover' | 'reconcile' }): Promise<Record<string, unknown>> {
    this.live();
    const { chains, missions } = this.options;
    const chain = chains.get(input.chain_id);
    if (chain.mode !== 'live') return err('chain_not_live');
    this.assertWrite(actor, missions.readable(actor, chain.root_mission_id).scope_id);
    const now = this.options.now();
    if (input.decision === 'reconcile') {
      const uncertain = chains.intents(chain.chain_id).some(i => i.kind === 'push' && i.state === 'uncertain');
      if (!uncertain) return err('nothing_to_reconcile');
      if (!this.options.reconcileReceipt) return err('reconcile_unavailable');
      return { chain_id: chain.chain_id, decision: 'reconcile', ...(await this.options.reconcileReceipt(chain)) };
    }
    const closed = chains.closeLive(chain.chain_id, chain.revision, input.decision, now);
    let cancel: 'not_needed' | 'requested' | 'failed' = 'not_needed';
    const child = chain.current_mission_id;
    if (child !== null && !TERMINAL.has(missions.state(child))) {
      cancel = 'failed';
      try { await this.options.cancelChild?.(actor, child); cancel = this.options.cancelChild ? 'requested' : 'failed'; }
      catch (error) { recordChildCancelFailure(chains, chain.chain_id, child, error, this.options.now(), actor.principal_id); }
    }
    return { chain_id: closed.chain_id, state: closed.state, decision: input.decision, child_cancel: cancel };
  }

  // -------------------------------------------------------------- previews

  private async buildFirst(actor: EngineeringPrincipal, missionId: string, terms: TermsInput, fixed: Fixed): Promise<RevisionGrantPreview> {
    const { missions, chains, registry } = this.options;
    const mission = missions.readable(actor, missionId);
    this.assertWrite(actor, mission.scope_id);
    const issuer = await this.issuer();
    const key = this.pickKey(issuer, terms.key_id);
    const resolved = this.resolve(terms, key);
    const publication = missions.publication(missionId);
    if (!publication) return err('grant_mission_not_opened');
    if (publication.repository !== registry.repository) return err('grant_repository_not_registered');
    if (publication.base_head === null) return err('grant_base_missing');
    if (chains.chainForMission(missionId, 'live') || chains.chainForPr(publication.repository, publication.pr_number, 'live')) return err('chain_exists');
    await this.assertLivePr(publication.repository, publication.pr_number, { branch: publication.branch, base_ref: publication.base_ref, head: publication.pushed_commit, base_sha: publication.base_head });
    return this.compose(actor, fixed, key, resolved, {
      scope_id: mission.scope_id, root_mission_id: missionId, repository: publication.repository, pr_number: publication.pr_number, branch: publication.branch,
      base_ref: publication.base_ref, base_sha: publication.base_head, head_sha: publication.pushed_commit, protected_set_digest: this.options.protectedSetDigest(),
    });
  }

  private async buildRenew(actor: EngineeringPrincipal, chainId: string, terms: TermsInput, fixed: Fixed): Promise<RevisionGrantPreview> {
    const { chains } = this.options;
    const chain = chains.get(chainId);
    if (chain.mode !== 'live') return err('chain_not_live');
    if (chain.repository !== this.options.registry.repository) return err('grant_repository_not_registered');
    const renewable = chain.state === 'awaiting_review' || chain.state === 'ready_for_human'
      || (chain.state === 'awaiting_decision' && RENEWABLE_STOP_REASONS.has(chain.stop_reason ?? ''));
    if (!renewable) return err('chain_not_renewable');
    let old: RevisionGrant;
    try { old = parseStoredGrant(chain.grant_json); } catch { return err('chain_grant_unreadable'); }
    this.assertWrite(actor, old.scope_id);
    if (chains.intents(chainId).some(i => i.kind === 'push' && (i.state === 'pending' || i.state === 'uncertain'))) return err('intent_unsettled');
    const issuer = await this.issuer();
    const key = this.pickKey(issuer, terms.key_id);
    // A re-grant that names nothing keeps what the chain already had: terms may be raised, never silently lowered.
    const resolved = this.resolve({
      rounds: terms.rounds ?? old.rounds, review_deadline_ms: terms.review_deadline_ms ?? old.review_deadline_ms, budget: { ...old.budget, ...terms.budget },
      ...(terms.expires_ms !== undefined ? { expires_ms: terms.expires_ms } : {}), ...(terms.key_id !== undefined ? { key_id: terms.key_id } : {}),
    }, key);
    if (resolved.rounds < old.rounds || resolved.budget.max_executor_seconds < old.budget.max_executor_seconds
      || resolved.budget.max_container_seconds < old.budget.max_container_seconds || resolved.budget.max_wall_clock_hours < old.budget.max_wall_clock_hours) return err('grant_terms_invalid');
    await this.assertLivePr(chain.repository, chain.pr_number, { branch: chain.branch, base_ref: chain.base_ref, head: chain.published_head, base_sha: chain.published_base });
    return this.compose(actor, fixed, key, resolved, {
      scope_id: old.scope_id, root_mission_id: chain.root_mission_id, repository: chain.repository, pr_number: chain.pr_number, branch: chain.branch, base_ref: chain.base_ref,
      base_sha: chain.published_base, head_sha: chain.published_head, protected_set_digest: old.protected_set_digest,
    }, { chain_id: chainId, revision: chain.revision });
  }

  private compose(actor: EngineeringPrincipal, fixed: Fixed, key: IssuerKey, terms: GrantTerms,
    bound: Pick<RevisionGrantPreview, 'scope_id' | 'root_mission_id' | 'repository' | 'pr_number' | 'branch' | 'base_ref' | 'base_sha' | 'head_sha' | 'protected_set_digest'>,
    renews?: { chain_id: string; revision: number }): RevisionGrantPreview {
    try {
      return parseRevisionGrantPreview({
        kind: 'live', version: 1, grant_id: fixed.grant_id, rounds: terms.rounds, principal_id: actor.principal_id, client_session_id: actor.client_session_id, ...bound,
        issued_at: fixed.issued_at, expires_at: fixed.issued_at + terms.validity_ms, review_deadline_ms: terms.review_deadline_ms, budget: terms.budget,
        nonce: fixed.nonce, key_id: key.key_id, ...(renews ? { renews } : {}),
      });
    } catch { return err('grant_terms_invalid'); }
  }

  private resolve(terms: TermsInput, key: IssuerKey): GrantTerms {
    try {
      return resolveGrantTerms({
        ...(terms.rounds !== undefined ? { rounds: terms.rounds } : {}), ...(terms.expires_ms !== undefined ? { expires_ms: terms.expires_ms } : {}),
        ...(terms.review_deadline_ms !== undefined ? { review_deadline_ms: terms.review_deadline_ms } : {}), ...(terms.budget ? { budget: terms.budget } : {}),
      }, key.max_validity_ms);
    } catch { return err('grant_terms_invalid'); }
  }

  /** The PR on GitHub right now: open, authored by the registered publisher, on the expected head repository and branch, at exactly the
   * published head and base. Anything else means the grant would authorise work on something other than what the human reviewed. */
  private async assertLivePr(repository: string, number: number, expect: { branch: string; base_ref: string; head: string; base_sha: string }): Promise<void> {
    const ref = REPOSITORY.exec(repository);
    if (!ref) return err('grant_repository_invalid');
    const read = await this.options.readPr({ owner: ref[1]!, name: ref[2]!, number });
    if (!read.complete) return err('grant_pr_read_failed');
    const pr = read.pr;
    if (pr.state !== 'OPEN' || pr.merged || pr.closed) return err('grant_pr_not_open');
    const author = reviewerOf(pr.author ?? undefined, { publisher: this.options.registry.publisher, reviewers: [] });
    if (author.actor_id === 0 || !this.options.registry.publisher.some(p => sameProducer(p, author))) return err('grant_pr_author_mismatch');
    if (pr.headRepository?.toLowerCase() !== repository.toLowerCase() || pr.headRefName !== expect.branch || pr.headRefOid !== expect.head
      || pr.baseRefName !== expect.base_ref || pr.baseRefOid !== expect.base_sha) return err('grant_pr_mismatch');
  }

  // -------------------------------------------------------------- helpers

  private live(): void { if (!this.options.enabled()) err('bridge_live_disabled'); }
  private assertWrite(actor: EngineeringPrincipal, scopeId: string): void { if (!actor.write_scopes.includes(scopeId)) err('permission_denied'); }
  private async issuer(): Promise<IssuerConfig> {
    const issuer = await this.options.loadIssuer();
    if (!issuer) return err('bridge_grant_not_configured');
    return issuer;
  }
  private pickKey(issuer: IssuerConfig, keyId: string | undefined): IssuerKey {
    if (keyId !== undefined) return issuer.keys.get(keyId) ?? err('grant_key_unknown');
    if (issuer.keys.size !== 1) return err('grant_key_required');
    return [...issuer.keys.values()][0]!;
  }
  private remember(actor: EngineeringPrincipal, preview: RevisionGrantPreview, request: Pending['request'], terms: TermsInput, now: number) {
    this.purge(now);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
    this.pending.set(preview.nonce, { principal_id: actor.principal_id, client_session_id: actor.client_session_id, preview, request, terms, created_at: now });
    return { preview, preview_sha256: previewDigest(preview), nonce: preview.nonce, valid_for_ms: GRANT_LIMITS.nonce_ttl_ms };
  }
  private purge(now: number): void {
    for (const [nonce, p] of this.pending) if (now > p.created_at + GRANT_LIMITS.nonce_ttl_ms) this.pending.delete(nonce);
  }
}
type Fixed = { grant_id: string; issued_at: number; nonce: string };

/** Production Mission view over the contained-Mission store: read rights come from the store, the PR from the Mission's ledger events. */
export async function createGrantMissionView(store: ContainedMissionStore): Promise<GrantMissionView> {
  const { createShadowMissionView } = await import('./contained-mission-bridge-shadow.js');
  const view = createShadowMissionView(store);
  return { readable: (actor, id) => store.readable(actor, id), publication: id => view.publication(id), state: id => store.get(id).state };
}
