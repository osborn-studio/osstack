import { randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { link, mkdir, open, readdir, realpath, stat, lstat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { UpgradeDigest, UpgradeId, freezeUpgradePlan, upgradeCanonical, upgradeDigest, type FrozenUpgradePlan } from './upgrade-plan.js';

export const UpgradePhaseSchema = z.enum(['planned', 'qualification_pending', 'preflight', 'draining', 'quiescent', 'snapshotting',
  'installing', 'installed', 'restarting', 'verifying', 'verified', 'aborted_before_install', 'restart_failed', 'version_mismatch', 'recovery_required']);
export type UpgradePhase = z.infer<typeof UpgradePhaseSchema>;
const RecordSchema = z.object({ schema_version: z.literal(1), plan_digest: UpgradeDigest, group_id: UpgradeId,
  sequence: z.number().int().min(0).max(2048), previous: UpgradeDigest.nullable(), at_ms: z.number().int().nonnegative().safe(),
  phase: UpgradePhaseSchema, status: z.enum(['started', 'confirmed', 'failed']),
  home_id: z.string().regex(/^home_[a-f0-9]{32}$/).nullable(), evidence_digest: UpgradeDigest.nullable(), evidence_ref: z.string().min(1).max(512).nullable(),
  reason: z.string().regex(/^[a-z0-9_]{1,128}$/).nullable(),
}).strict();
export type UpgradeJournalRecord = z.infer<typeof RecordSchema>;
export interface UpgradeJournalStatus { plan: FrozenUpgradePlan; group_id: string; records: UpgradeJournalRecord[];
  phase: UpgradePhase; completed: boolean; resume_allowed: false;
  recovery: { claim_cleanup_pending: boolean; claims_held: number; claims_expected: number; partial_claim: boolean; historically_stopped_home_ids: string[]; last_started_phase: UpgradePhase | null; last_started_home_id: string | null } }

async function directory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  const info = await stat(path);
  if (await realpath(path) !== resolve(path) || !info.isDirectory() || (info.mode & 0o077) !== 0
    || process.getuid && info.uid !== process.getuid()) throw Error('upgrade_journal_unsafe_directory');
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readJson(path: string, maxBytes = 262144): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.nlink !== 1 && info.nlink !== 2) || (info.mode & 0o077) !== 0 || info.size > maxBytes || process.getuid && info.uid !== process.getuid()) throw Error('upgrade_journal_unsafe_file');
    if (info.nlink === 2) {
      // A process can die after publishing its link but before removing its private temporary.
      // Accept only that exact second inode link inside the same private directory; never unlink while reading.
      const parent = dirname(path); await directory(parent); const names = await readdir(parent);
      if (names.length > 2200) throw Error('upgrade_journal_record_limit'); let matches = 0;
      for (const name of names.filter(name => /^\.tmp-[a-f0-9]{32}$/.test(name))) {
        const other = await lstat(join(parent, name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null; });
        if (other?.isFile() && other.ino === info.ino && other.dev === info.dev) matches += 1;
      }
      const links = (await file.stat()).nlink;
      if (links !== 1 && (links !== 2 || matches !== 1)) throw Error('upgrade_journal_unsafe_file');
    }
    const buffer = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < buffer.length) { const chunk = await file.read(buffer, length, buffer.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
    if (length > maxBytes) throw Error('upgrade_journal_oversized');
    const raw = buffer.subarray(0, length).toString('utf8'); const value: unknown = JSON.parse(raw);
    if (upgradeCanonical(value) !== raw) throw Error('upgrade_journal_non_canonical'); return value;
  } finally { await file.close(); }
}
/** Complete-file link publication, then directory fsync. Never overwrite a record. */
async function publish(directoryPath: string, name: string, value: unknown): Promise<void> {
  await directory(directoryPath); const temporary = join(directoryPath, `.tmp-${randomBytes(16).toString('hex')}`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(upgradeCanonical(value)); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, join(directoryPath, name)); } finally { await unlink(temporary); }
  await syncDirectory(directoryPath);
}

/** The caller supplies an existing private root. Hashes detect corruption; they are not signatures. */
export class UpgradeJournal {
  constructor(readonly root: string) {}
  async create(input: FrozenUpgradePlan): Promise<void> {
    const frozen = freezeUpgradePlan(input.plan); if (frozen.digest !== input.digest) throw Error('upgrade_plan_digest_mismatch');
    await directory(this.root); const path = join(this.root, frozen.digest); await directory(path, true); await syncDirectory(this.root);
    try { await publish(path, 'plan.json', frozen.plan); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (upgradeCanonical(await readJson(join(path, 'plan.json'))) !== upgradeCanonical(frozen.plan)) throw Error('upgrade_plan_conflict');
    }
  }
  async plan(digest: string): Promise<FrozenUpgradePlan> {
    UpgradeDigest.parse(digest); await directory(this.root); await directory(join(this.root, digest));
    const frozen = freezeUpgradePlan(await readJson(join(this.root, digest, 'plan.json')));
    if (frozen.digest !== digest) throw Error('upgrade_plan_digest_mismatch'); return frozen;
  }
  async status(digest: string, groupId: string): Promise<UpgradeJournalStatus> {
    UpgradeId.parse(groupId); const plan = await this.plan(digest);
    if (!plan.plan.groups.some(g => g.group_id === groupId)) throw Error('upgrade_group_missing');
    const path = join(this.root, digest); const names = await readdir(path);
    if (names.length > 2200) throw Error('upgrade_journal_record_limit');
    const records: UpgradeJournalRecord[] = []; let previous: string | null = null;
    const prefix = `${upgradeDigest(groupId)}.`;
    for (const name of names.filter(name => name.startsWith(prefix)).sort()) {
      if (!/^[a-f0-9]{64}\.[0-9]{4}\.json$/.test(name)) throw Error('upgrade_journal_invalid_name');
      const record = RecordSchema.parse(await readJson(join(path, name), 8192));
      if (record.plan_digest !== digest || record.group_id !== groupId || record.sequence !== records.length || record.previous !== previous
        || name !== `${upgradeDigest(groupId)}.${String(record.sequence).padStart(4, '0')}.json`) throw Error('upgrade_journal_chain_broken');
      previous = upgradeDigest(record); records.push(record);
    }
    const recordedPhase = records.at(-1)?.phase ?? 'qualification_pending';
    const lastStarted = [...records].reverse().find(record => record.status === 'started');
    const completed = recordedPhase === 'verified' && records.at(-1)?.status === 'confirmed';
    const group = plan.plan.groups.find(g => g.group_id === groupId)!;
    const claimNames = [`claim-${upgradeDigest(group.installation_id)}.json`, ...group.homes.map(home => `home-claim-${upgradeDigest(home.home_id)}.json`)];
    let claimsHeld = 0;
    for (const name of claimNames) {
      const value = await readJson(join(this.root, name), 4096).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null; });
      if (value && typeof value === 'object' && 'plan_digest' in value && value.plan_digest === digest && 'group_id' in value && value.group_id === groupId) claimsHeld += 1;
    }
    const phase = recordedPhase === 'qualification_pending' && claimsHeld ? 'recovery_required' : recordedPhase;

    return { plan, group_id: groupId, records, phase, completed, resume_allowed: false,
      recovery: { claim_cleanup_pending: completed && claimsHeld > 0, claims_held: claimsHeld, claims_expected: claimNames.length, partial_claim: claimsHeld > 0 && claimsHeld < claimNames.length, historically_stopped_home_ids: [...new Set(records.filter(record => record.phase === 'draining' && record.status === 'confirmed' && record.home_id).map(record => record.home_id!))],
        last_started_phase: lastStarted?.phase ?? null, last_started_home_id: lastStarted?.home_id ?? null } };
  }
  /** Locks are keyed by shared installation, across plans. Never stale-steal by PID or timeout. */
  async claim(digest: string, groupId: string): Promise<UpgradeJournalWriter> {
    const state = await this.status(digest, groupId); const group = state.plan.plan.groups.find(g => g.group_id === groupId)!;
    if (state.completed) throw Error('upgrade_already_verified');
    if (state.phase === 'recovery_required' || state.records.some(record => record.phase !== 'qualification_pending')) throw Error('upgrade_recovery_required');
    const claim = { plan_digest: digest, group_id: groupId, token: randomBytes(32).toString('hex') };
    const names = [`claim-${upgradeDigest(group.installation_id)}.json`, ...group.homes.map(home => `home-claim-${upgradeDigest(home.home_id)}.json`).sort()];
    const attempted: string[] = [];
    const assertClaim = async () => {
      try {
        for (const name of names) if (upgradeCanonical(await readJson(join(this.root, name), 4096)) !== upgradeCanonical(claim)) throw Error('upgrade_claim_changed');
      } catch { throw Error('upgrade_claim_changed'); }
    };
    const release = async () => { await assertClaim(); for (const name of names) await unlink(join(this.root, name)); await syncDirectory(this.root); };
    try {
      for (const name of names) { attempted.push(name); await publish(this.root, name, claim); }
      const current = await this.status(digest, groupId);
      if (current.completed) { await release(); throw Error('upgrade_already_verified'); }
      if (upgradeCanonical(current.records) !== upgradeCanonical(state.records)) throw Error('upgrade_recovery_required');
    } catch (error) {
      // Covers every failure before returning a writer, including the post-publication re-read.
      // No native effect can have started. Remove only this fresh token's claims, never foreign or attempted-effect claims.
      let cleanupUnknown = false;
      for (const name of attempted) {
        try {
          const value = await readJson(join(this.root, name), 4096).catch(failure => { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; return null; });
          if (value && upgradeCanonical(value) === upgradeCanonical(claim)) await unlink(join(this.root, name));
        } catch { cleanupUnknown = true; }
      }
      try { await syncDirectory(this.root); } catch { cleanupUnknown = true; }
      if (cleanupUnknown || (error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('upgrade_recovery_required'); throw error;
    }
    let sequence = state.records.length; let previous = state.records.length ? upgradeDigest(state.records.at(-1)) : null; let writing = false;
    return {
      assertCurrent: () => {
        try {
          for (const name of names) {
            const fd = openSync(join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const info = fstatSync(fd); if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 4096
                || process.getuid && info.uid !== process.getuid()) throw Error('upgrade_claim_changed');
              const buffer = Buffer.alloc(4097); let length = 0;
              while (length < buffer.length) { const size = readSync(fd, buffer, length, buffer.length - length, length); if (!size) break; length += size; }
              if (length > 4096 || buffer.subarray(0, length).toString('utf8') !== upgradeCanonical(claim)) throw Error('upgrade_claim_changed');
            } finally { closeSync(fd); }
          }
        } catch { throw Error('upgrade_claim_changed'); }
      },
      append: async value => {
        if (writing) throw Error('upgrade_journal_concurrent_write'); writing = true;
        try {
          await assertClaim(); const record = RecordSchema.parse({ ...value, schema_version: 1, plan_digest: digest, group_id: groupId, sequence, previous });
          await publish(join(this.root, digest), `${upgradeDigest(groupId)}.${String(sequence).padStart(4, '0')}.json`, record);
          await assertClaim(); previous = upgradeDigest(record); sequence += 1; return record;
        } finally { writing = false; }
      },
      releaseVerified: async () => {
        await assertClaim(); const current = await this.status(digest, groupId);
        if (!current.completed || writing) throw Error('upgrade_release_requires_verified');
        await release();
      },
    };
  }
}
export interface UpgradeJournalWriter {
  assertCurrent(): void;
  append(value: Pick<UpgradeJournalRecord, 'at_ms' | 'phase' | 'status' | 'home_id' | 'evidence_digest' | 'evidence_ref' | 'reason'>): Promise<UpgradeJournalRecord>;
  releaseVerified(): Promise<void>;
}
