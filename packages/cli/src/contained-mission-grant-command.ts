// Client side of `osstack mission grant-revisions` (phase 5-A, appendix §5.1). Local operator only: it needs an interactive
// terminal, shows the exact grant the daemon previewed, requires the operator to type `GRANT <preview digest>`, and only then
// reads the host-private issuer key and signs. The daemon verifies the signature; nothing here is authority without that key.
import { z } from 'zod';
import { createInterface } from 'node:readline/promises';
import {
  GRANT_LIMITS,
  LocalFailureOptInSchema,
  RevisionGrantError,
  canonicalJson,
  parseRevisionGrantPreview,
  previewDigest,
  signRevisionGrant,
  localFailurePreviewDigest,
  parseLocalFailureGrantPreview,
  signLocalFailureRevisionGrant,
  type LocalFailureGrantPreview,
  type RevisionGrantPreview,
} from '@osstack/core';
import { generateRevisionIssuerKey, loadRevisionIssuer, readIssuerPrivateKey, type IssuerConfig } from './contained-mission-grant.js';

import { LocalFailureGrantTerms, LocalFailureRenewTerms, localFailureOptIn, mergeLocalFailureTerms, type LocalFailureOptIn } from './contained-mission-grant-terms.js';

export const GRANT_REVISIONS_HELP = `Usage: osstack mission grant-revisions (--mission ROOT_MISSION | --chain CHAIN) [--rounds 1|2] [--expires 24h]
         [--review-deadline 24h] [--max-executor-seconds N] [--max-container-seconds N] [--max-wall-clock-hours N] [--key ID] [--json]
       With --mission, add --local-failure-profile ID --profile-digest SHA256 --trusted-source-repository OWNER/NAME
         --trusted-source-commit SHA --trusted-source-artifact SHA256 --diagnostic-timeout-seconds N [--recheck-timeout-seconds N]
       osstack mission grant-keygen --key ID [--max-validity 7d]
Local operator only: needs an interactive terminal on stdin and stderr, prints the exact grant (repository, PR, head, base, scope,
principal, rounds, expiry, budget) and requires typing the confirmation phrase and the whole preview digest. There is no --yes and no way to answer
through RPC. The grant is signed with the host-private issuer key (bridge/revision-issuer-<key>.pem, mode 0600); the daemon only verifies.
Defaults: 1 round (--rounds 2 is explicit; two is the cap), valid 24h (at most 7d), review deadline 24h after every confirmed push,
budget 3600s executor, 3600s container, 48h wall clock. --chain extends a chain: rounds and budget can only grow.
With --chain, a local-failure grant renews as a local-failure grant. Give local flags individually to raise a timeout,
add the recheck, or change the pin before the first diagnosis. Unnamed terms are kept. Type RENEW LOCAL-FAILURE <digest>
to sign the renewal. The preview lists eligible diagnoses, a waiting repair candidate, and pending recheck attempts. A version 1 chain cannot be upgraded yet.
Type GRANT LOCAL-FAILURE <digest> to authorise one diagnosis per PR head after a trusted verification failure, one automatic repair
Mission for this PR, and the optional recheck on the repaired head. Pushing the exact candidate needs separate operator approval.
The daemon refuses this grant unless the local-failure switch is on.
grant-keygen creates the issuer key pair on this host (private key never leaves it) and registers the public key.\n`;

export interface GrantCommandDeps {
  home: string;
  rpc: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  readCredential: () => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Host test seams only, never CLI or RPC input. Production passes neither: the real check is `stdin` and `stderr` being TTYs. */
  interactive?: () => boolean;
  confirm?: (preview: string, phrase: string) => Promise<boolean>;
  now?: () => number;
}

const CONFIRM_TIMEOUT_MS = 45_000;
async function terminalConfirm(preview: string, phrase: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('mission_terminal_required');
  process.stderr.write(preview);
  const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try { return (await terminal.question(`Type exactly ${phrase}\n> `, { signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS) })) === phrase; }
  finally { terminal.close(); }
}

export function parseDuration(value: string): number {
  const m = /^([1-9][0-9]{0,8})(s|m|h|d)$/.exec(value);
  if (!m) throw new Error(`invalid_duration:${value.slice(0, 20)}`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const carryForwardSchema = z.object({
  eligible_diagnoses: z.array(z.object({
    request_id: z.string().regex(/^vdr_[0-9a-f-]{36}$/), head_sha: objectId,
  }).strict()).max(10),
  waiting_child: z.object({
    child_mission_id: z.string().regex(/^cm_[0-9a-f-]{36}$/), candidate_head: objectId.nullable(),
  }).strict().nullable(),
  pending_recheck: z.object({
    recheck_id: z.string().regex(/^vrc_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/), attempts: z.number().int().min(0).max(3),
  }).strict().nullable(),
}).strict();
type CarriedForward = z.infer<typeof carryForwardSchema>;

function renderCarriedForward(work: CarriedForward): string[] {
  const lines = work.eligible_diagnoses.map(r => `  eligible diagnosis ${r.request_id} on head ${r.head_sha}`);
  if (work.waiting_child) lines.push(`  repair candidate waiting for approval: child ${work.waiting_child.child_mission_id}, candidate ${work.waiting_child.candidate_head ?? 'unknown'}`);
  if (work.pending_recheck) lines.push(`  pending recheck ${work.pending_recheck.recheck_id}, attempts so far ${work.pending_recheck.attempts}`);
  return ['Work this renewal carries forward (shown for information, not signed):', ...(lines.length ? lines : ['  nothing']),
    'This renewal does not approve a candidate; the approval stays a separate step.'];
}

/** Human-readable preview. Every signed field is shown. */
export function renderGrantPreview(p: RevisionGrantPreview | LocalFailureGrantPreview, digest: string, previous?: LocalFailureOptIn, carriedForward?: CarriedForward): string {
  const iso = (ms: number) => new Date(ms).toISOString();
  const change = (label: string, old: string | number, next: string | number) =>
    `  ${label}: ${old === next ? `${next} (unchanged)` : `${old} -> ${next}`}`;
  const localAuthority = p.version === 2 ? ' AND local-failure repair' : '';
  const lines = [
    p.renews ? `Extend revision grant${localAuthority} on chain ${p.renews.chain_id} (chain revision ${p.renews.revision})`
      : `Grant same-PR revisions${localAuthority}`,
    `  repository      ${p.repository}  PR #${p.pr_number}`,
    `  branch          ${p.branch}  (base ${p.base_ref} @ ${p.base_sha})`,
    `  published head  ${p.head_sha}`,
    `  root mission    ${p.root_mission_id}`,
    `  scope           ${p.scope_id}`,
    `  granted by      ${p.principal_id} / ${p.client_session_id}`,
    `  revision rounds ${p.rounds}`,
    `  valid           ${iso(p.issued_at)} -> ${iso(p.expires_at)}`,
    `  review deadline ${Math.round(p.review_deadline_ms / 60_000)} min after each confirmed push`,
    `  budget          executor ${p.budget.max_executor_seconds}s, container ${p.budget.max_container_seconds}s, wall clock ${p.budget.max_wall_clock_hours}h`,
    `  protected set   ${p.protected_set_digest}`,
    `  signing key     ${p.key_id}`,
    `  preview sha256  ${digest}`,
    ...(p.version === 2 ? [
      `  grant           ${p.kind}, version ${p.version}, ${p.grant_id}`,
      `  nonce           ${p.nonce}`,
      ...(p.review_deadline_ms % 60_000 ? [`  exact deadline  ${p.review_deadline_ms} ms after each confirmed push`] : []),
      'This signature authorises the following actions without another signature.',
      `Diagnosis permits one host run of verification profile ${p.local_failure.profile_id} (digest ${p.local_failure.profile_digest}) per PR head, at most ${p.local_failure.diagnostic_timeout_seconds} s, after a trusted verification failure is recorded for this PR.`,
      'Repair permits one automatic repair Mission for this PR. Pushing its result needs separate operator approval of the exact candidate.',
      p.local_failure.recheck
        ? `Recheck permits one host run of the same profile on the repaired head, at most ${p.local_failure.recheck.timeout_seconds} s.`
        : 'A recheck is NOT authorised by this grant.',
      `Trusted source repository ${p.local_failure.trusted_source.repository}, commit ${p.local_failure.trusted_source.commit}, artifact digest ${p.local_failure.trusted_source.artifact_digest}.`,
    ] : []),
    ...(p.version === 2 && p.renews && previous ? [
      'Local-failure opt-in, old -> new:',
      change('profile id', previous.profile_id, p.local_failure.profile_id),
      change('profile digest', previous.profile_digest, p.local_failure.profile_digest),
      change('trusted source repository', previous.trusted_source.repository, p.local_failure.trusted_source.repository),
      change('trusted source commit', previous.trusted_source.commit, p.local_failure.trusted_source.commit),
      change('trusted source artifact digest', previous.trusted_source.artifact_digest, p.local_failure.trusted_source.artifact_digest),
      change('diagnostic timeout', previous.diagnostic_timeout_seconds, p.local_failure.diagnostic_timeout_seconds),
      change('recheck timeout', previous.recheck?.timeout_seconds ?? 'none', p.local_failure.recheck?.timeout_seconds ?? 'none'),
    ] : []),
    ...(p.version === 2 && p.renews && carriedForward ? renderCarriedForward(carriedForward) : []),
    'The daemon will, within these limits only, push fast-forward revision commits to this PR branch. It will never merge.',
  ];
  return `${lines.join('\n')}\n`;
}

const REQUIRED_LOCAL_FLAGS = ['local-failure-profile', 'profile-digest', 'trusted-source-repository', 'trusted-source-commit', 'trusted-source-artifact', 'diagnostic-timeout-seconds'];
const LOCAL_FLAGS = [...REQUIRED_LOCAL_FLAGS, 'recheck-timeout-seconds'];
const FLAGS = ['mission', 'chain', 'rounds', 'expires', 'review-deadline', 'max-executor-seconds', 'max-container-seconds', 'max-wall-clock-hours', 'key', ...LOCAL_FLAGS];

export async function handleGrantRevisionsCommand(args: string[], deps: GrantCommandDeps): Promise<number> {
  const out = deps.stdout ?? ((t: string) => { process.stdout.write(t); });
  const err = deps.stderr ?? ((t: string) => { process.stderr.write(t); });
  let credential = '';
  try {
    if (args.some(a => a === '--help' || a === '-h')) { out(GRANT_REVISIONS_HELP); return 0; }
    const flags = new Map<string, string>(); let json = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === '--json') { if (json) throw new Error('duplicate_flag:--json'); json = true; continue; }
      if (!arg.startsWith('--') || !FLAGS.includes(arg.slice(2))) throw new Error(`unknown_flag:${arg.slice(0, 40)}`);
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || value.includes('\0')) throw new Error(`missing_value:${arg}`);
      if (flags.has(arg.slice(2))) throw new Error(`duplicate_flag:${arg}`);
      flags.set(arg.slice(2), value);
    }
    const wantsLocal = LOCAL_FLAGS.some(flag => flags.has(flag));
    const chain = flags.get('chain');
    if (wantsLocal && chain === undefined && !REQUIRED_LOCAL_FLAGS.every(flag => flags.has(flag))) throw new Error('required:local_failure_flags');
    if (flags.has('mission') === flags.has('chain')) throw new Error('required:exactly_one_of_--mission_--chain');
    // Step 1: refuse before any RPC or secret when there is no interactive terminal.
    if (!(deps.interactive ?? (() => Boolean(process.stdin.isTTY && process.stderr.isTTY)))()) throw new Error('mission_terminal_required');
    const num = (key: string, max = Number.MAX_SAFE_INTEGER, error = `invalid:--${key}`): number | undefined => {
      const v = flags.get(key); if (v === undefined) return undefined;
      if (!/^[1-9][0-9]{0,8}$/.test(v) || Number(v) > max) throw new Error(error);
      return Number(v);
    };
    const rounds = flags.get('rounds');
    if (rounds !== undefined && rounds !== '1' && rounds !== '2') throw new Error('invalid:--rounds');
    const budget = {
      ...(num('max-executor-seconds', GRANT_LIMITS.max_budget.max_executor_seconds) !== undefined ? { max_executor_seconds: num('max-executor-seconds', GRANT_LIMITS.max_budget.max_executor_seconds)! } : {}),
      ...(num('max-container-seconds', GRANT_LIMITS.max_budget.max_container_seconds) !== undefined ? { max_container_seconds: num('max-container-seconds', GRANT_LIMITS.max_budget.max_container_seconds)! } : {}),
      ...(num('max-wall-clock-hours', GRANT_LIMITS.max_budget.max_wall_clock_hours) !== undefined ? { max_wall_clock_hours: num('max-wall-clock-hours', GRANT_LIMITS.max_budget.max_wall_clock_hours)! } : {}),
    };
    const localNumber = (flag: string, max?: number) => num(flag, max, chain === undefined ? undefined : 'invalid:local_failure_flags');
    const source = {
      ...(flags.has('trusted-source-repository') ? { repository: flags.get('trusted-source-repository') } : {}),
      ...(flags.has('trusted-source-commit') ? { commit: flags.get('trusted-source-commit') } : {}),
      ...(flags.has('trusted-source-artifact') ? { artifact_digest: flags.get('trusted-source-artifact') } : {}),
    };
    const named = {
      ...(flags.has('local-failure-profile') ? { profile_id: flags.get('local-failure-profile') } : {}),
      ...(flags.has('profile-digest') ? { profile_digest: flags.get('profile-digest') } : {}),
      ...(Object.keys(source).length ? { trusted_source: source } : {}),
      ...(flags.has('diagnostic-timeout-seconds') ? { diagnostic_timeout_seconds: localNumber('diagnostic-timeout-seconds', GRANT_LIMITS.max_budget.max_container_seconds) } : {}),
      ...(flags.has('recheck-timeout-seconds') ? { recheck_timeout_seconds: localNumber('recheck-timeout-seconds') } : {}),
    };
    const issuance = wantsLocal && chain === undefined ? LocalFailureGrantTerms.safeParse(named) : undefined;
    const renewal = wantsLocal && chain !== undefined ? LocalFailureRenewTerms.safeParse(named) : undefined;
    if ((issuance && !issuance.success) || (renewal && !renewal.success)) throw new Error('invalid:local_failure_flags');
    const localTerms = issuance?.data ?? renewal?.data;
    const issuer: IssuerConfig | undefined = await loadRevisionIssuer(deps.home);
    if (!issuer) throw new Error('bridge_grant_not_configured');
    const keyId = flags.get('key') ?? (issuer.keys.size === 1 ? [...issuer.keys.keys()][0]! : undefined);
    if (!keyId) throw new Error('grant_key_required');
    const key = issuer.keys.get(keyId);
    if (!key) throw new Error('grant_key_unknown');
    credential = deps.readCredential();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject bearer transport control bytes before RPC.
    if (credential.length < 32 || credential.length > 4096 || /[\u0000\r\n]/u.test(credential)) throw new Error('engineering_credential_required');
    const terms = {
      ...(localTerms ? { local_failure: localTerms } : {}),
      ...(rounds ? { rounds: Number(rounds) } : {}), ...(flags.has('expires') ? { expires_ms: parseDuration(flags.get('expires')!) } : {}),
      ...(flags.has('review-deadline') ? { review_deadline_ms: parseDuration(flags.get('review-deadline')!) } : {}),
      ...(Object.keys(budget).length ? { budget } : {}), key_id: keyId,
    };
    const call = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const response = await deps.rpc(method, { ...params, credential }, 120_000) as { ok?: boolean; result?: unknown; error?: { code?: unknown } };
      if (response?.ok !== true) throw new Error(typeof response?.error?.code === 'string' ? response.error.code : 'mission_request_failed');
      return (response.result ?? {}) as Record<string, unknown>;
    };
    // Steps 2-3: the daemon authenticates, checks the Mission/chain and the live PR, and returns the preview with a one-time nonce.
    const reply = await call(flags.has('chain') ? 'mission.revision_grant_renew_preview' : 'mission.revision_grant_preview',
      flags.has('chain') ? { chain_id: flags.get('chain'), ...terms } : { mission_id: flags.get('mission'), ...terms });
    // The daemon is trusted, but the operator signs what this process computes, not what it was told.
    const raw = reply['preview'];
    let preview: RevisionGrantPreview | LocalFailureGrantPreview;
    let carriedForward: CarriedForward | undefined;
    let previous: LocalFailureOptIn | undefined;
    if (raw && typeof raw === 'object' && 'version' in raw && raw.version === 2) {
      try { preview = parseLocalFailureGrantPreview(raw); } catch { throw new Error('grant_preview_mismatch'); }
      let expected: LocalFailureOptIn;
      if (chain !== undefined) {
        const parsed = LocalFailureOptInSchema.safeParse(reply['previous_local_failure']);
        if (!parsed.success || preview.renews?.chain_id !== chain) throw new Error('grant_preview_mismatch');
        const work = carryForwardSchema.safeParse(reply['carried_forward']);
        if (!work.success) throw new Error('grant_preview_mismatch');
        carriedForward = work.data;
        previous = parsed.data;
        expected = mergeLocalFailureTerms(previous, renewal?.data);
      } else {
        if (!issuance || preview.renews || preview.root_mission_id !== flags.get('mission')) throw new Error('grant_preview_mismatch');
        expected = localFailureOptIn(issuance.data);
      }
      if (canonicalJson(preview.local_failure) !== canonicalJson(expected)) throw new Error('grant_preview_mismatch');
    } else {
      if (wantsLocal) throw new Error('grant_preview_mismatch');
      preview = parseRevisionGrantPreview(raw);
    }
    const digest = preview.version === 2 ? localFailurePreviewDigest(preview) : previewDigest(preview);
    if (digest !== reply['preview_sha256'] || preview.nonce !== reply['nonce'] || preview.key_id !== keyId || canonicalJson(preview) !== canonicalJson(reply['preview'])) throw new Error('grant_preview_mismatch');
    // Step 4: exact typed confirmation.
    const phrase = preview.version === 2 ? `${preview.renews ? 'RENEW' : 'GRANT'} LOCAL-FAILURE ${digest}` : `GRANT ${digest}`;
    if (!(await (deps.confirm ?? terminalConfirm)(renderGrantPreview(preview, digest, previous, carriedForward), phrase))) throw new Error('grant_not_confirmed');
    // Step 5: only now is the private key read.
    const privateKey = await readIssuerPrivateKey(deps.home, key);
    const grant = preview.version === 2 ? signLocalFailureRevisionGrant(preview, privateKey) : signRevisionGrant(preview, privateKey);
    // Steps 6-7.
    const result = await call('mission.grant_revisions', { nonce: preview.nonce, preview_sha256: digest, signature: grant.signature });
    const text = JSON.stringify(result, null, 2);
    if (result['head_consumed'] === true && !json) err('Note: the current head already used its revision round; this grant only helps once a new head appears on the PR branch.\n');
    out(json ? `${text}\n` : `Revision grant recorded\n${text}\nNothing was pushed. The daemon revises this PR only within the grant, and never merges.\n`);
    return 0;
  } catch (error) {
    const message = error instanceof RevisionGrantError ? error.code : error instanceof Error ? error.message : String(error);
    err(`osstack mission: ${JSON.stringify(credential ? message.split(credential).join('[REDACTED]') : message)}\n`);
    return 1;
  }
}

export async function handleGrantKeygenCommand(args: string[], deps: Pick<GrantCommandDeps, 'home' | 'stdout' | 'stderr'>): Promise<number> {
  const out = deps.stdout ?? ((t: string) => { process.stdout.write(t); });
  const err = deps.stderr ?? ((t: string) => { process.stderr.write(t); });
  try {
    if (args.some(a => a === '--help' || a === '-h')) { out(GRANT_REVISIONS_HELP); return 0; }
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i]; const value = args[i + 1];
      if ((flag !== '--key' && flag !== '--max-validity') || value === undefined || value.startsWith('--') || flags.has(flag)) throw new Error('invalid_arguments');
      flags.set(flag, value);
    }
    const keyId = flags.get('--key'); if (!keyId) throw new Error('required:--key');
    const created = await generateRevisionIssuerKey(deps.home, keyId, flags.has('--max-validity') ? parseDuration(flags.get('--max-validity')!) : GRANT_LIMITS.max_validity_ms);
    out(`${JSON.stringify({ key_id: created.key_id, public_key_spki_b64: created.public_key_spki_b64 }, null, 2)}\nPrivate key written to bridge/revision-issuer-${created.key_id}.pem (mode 0600). Restart the daemon to load the public key.\n`);
    return 0;
  } catch (error) {
    err(`osstack mission: ${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
}
