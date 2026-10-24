// Explicit installed-host maintenance; importing this module performs no work.
// It never migrates, starts a worker, or switches the serving binary. Lock release
// is restricted to the exact inspected dead owner under the existing G15 verifier.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, GraphRunStore } from '@osstack/core';
import { workerCanonical } from '@osstack/protocol';
import { assertDbAccessAllowed } from './control-plane-guard.js';
import { assertManagedHomeMarker } from './managed-home-guard.js';
import { assertSingleSqliteFiles } from './sqlite-file-guard.js';
import { VERSION, PROTOCOL_VERSION } from './version.js';
import { loadLocalGraphRegistration, GraphRpcService } from './graph-rpc.js';
import { cancelUnstartedGraphPreparation } from './graph-preparation-recovery.js';
import { graphUpgradeHolds } from './graph-upgrade-guard.js';
import type { RepoLockOwner } from '@osstack/autonomy';
import { cancelStoppedGraphVerification } from './graph-stopped-verification-recovery.js';

const digest = (value: unknown) => createHash('sha256').update(workerCanonical(value)).digest('hex');
const schema = (db: Database.Database) => digest(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all());
function owned(path: string, directory: boolean) {
  const stat = lstatSync(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || realpathSync(path) !== path
    || (!directory && stat.nlink !== 1) || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw Error('MAINTENANCE_OWNER_REQUIRED');
}

/** Run once after independent approval, from the installed release directory.
 * Without apply this is a read-only guard/schema/registration check. The role
 * A standalone maintenance entry is not authorized for a managed-marker home:
 * it fails the managed serving-entry gate. Managed invocation must come through
 * the declared serving entry; no standalone managed maintenance CLI is provided.
 * The role declaration must already allow the home; this entry cannot provision one.
 * apply requires a new consistent backup and invokes only the exact-v4 proof.
 * An error is a stop condition, never permission to retry or force settlement. */
interface MaintenanceOptions {
  home: string; graphRunId: string; expectedRevision: number;
  apply?: boolean; backupDirectory?: string;
  expectedDaemonPid?: number; expectedLockOwner?: RepoLockOwner;
}
export async function reconcileUnstartedPreparation(options: MaintenanceOptions) {
  return runMaintenance(options, 'preparation');
}
/** Two stages: inspect while the old owner is alive; apply only after normal
 * shutdown with the exact inspected token. Never kills or restarts a daemon. */
export async function reconcileStoppedVerification(options: MaintenanceOptions & { expectedDaemonPid: number }) {
  return runMaintenance(options, 'verification');
}
async function runMaintenance(options: MaintenanceOptions, kind: 'preparation' | 'verification') {
  if (!/^[a-f0-9-]{36}$/.test(options.graphRunId) || !Number.isSafeInteger(options.expectedRevision)
    || options.expectedRevision < 0) throw Error('MAINTENANCE_INPUT_INVALID');
  const home = realpathSync(options.home);
  if (kind === 'verification' && options.apply === true && existsSync(join(home, 'daemon.sock'))) throw Error('MAINTENANCE_DAEMON_MUST_STOP');
  const guard = assertDbAccessAllowed({ checkoutRoot: dirname(realpathSync(fileURLToPath(import.meta.url))), osstackHome: home });
  assertManagedHomeMarker(home, process.argv[1], {version:VERSION,protocol_version:PROTOCOL_VERSION,database_schema:CURRENT_SCHEMA_VERSION});
  owned(home, true); const path = join(home, 'state.db'); owned(path, false); assertSingleSqliteFiles(path);
  const db = new Database(path, { readonly: options.apply !== true, fileMustExist: true });
  let initialSchema: string | undefined;
  let service: GraphRpcService | undefined;
  const assertSchema = () => {
    if (initialSchema && (schema(db) !== initialSchema || db.pragma('user_version', { simple: true }) !== CURRENT_SCHEMA_VERSION)) throw Error('MAINTENANCE_SCHEMA_CHANGED');
  };
  try {
    db.pragma('busy_timeout = 5000'); db.pragma('foreign_keys = ON');
    if (db.pragma('user_version', { simple: true }) !== CURRENT_SCHEMA_VERSION) throw Error('MAINTENANCE_SCHEMA_MISMATCH');
    initialSchema = schema(db);
    const registration = await loadLocalGraphRegistration(join(home, 'graph-host.json'), new Map());
    const authorize = () => {
      const permission: unknown = registration.authorize('cancel');
      if (permission !== undefined) { void Promise.resolve(permission).catch(() => {}); throw Error('MAINTENANCE_AUTHORITY_INVALID'); }
      if (registration.admitNewRuns?.() !== false) throw Error('MAINTENANCE_ADMISSION_MUST_BE_CLOSED');
      if (kind === 'verification' && options.apply === true && existsSync(join(home, 'daemon.sock'))) throw Error('MAINTENANCE_DAEMON_MUST_STOP');
      assertSchema();
    };
    authorize();
    const connection = {};
    service = new GraphRpcService({ db, root: join(home, 'graph-delivery'),
      registrations: [{ ...registration, admitNewRuns: () => false }],
      resolveCaller: candidate => candidate === connection ? registration.id : null,
      acquire: async () => { throw Error('MAINTENANCE_EXECUTION_FORBIDDEN'); } });
    // Normal public binding validation proves config registration, scope and
    // product match the durable run before the narrower host proof is invoked.
    await service.handle(connection, 'graph.status', { schemaVersion: 1, scope: registration.scope, graphRunId: options.graphRunId });
    const runs = new GraphRunStore(db); const run = runs.get(registration.scope, options.graphRunId)!;
    if (run.status !== 'cancel_pending' || run.revision !== options.expectedRevision) throw Error('MAINTENANCE_RUN_CHANGED');
    const actions = () => digest(db.prepare('SELECT * FROM graph_actions WHERE graph_run_id=? ORDER BY effect_key').all(run.graphRunId));
    const actionsBefore = actions();
    assertSchema();
    const verify = (inspectOnly: boolean) => {
      if (!Number.isSafeInteger(options.expectedDaemonPid) || options.expectedDaemonPid! <= 0) throw Error('MAINTENANCE_PID_REQUIRED');
      return cancelStoppedGraphVerification(db, join(home, 'graph-delivery', run.graphRunId), {
        fence: { scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, expectedGeneration: run.generation,
          expectedOwner: run.leaseOwner, expectedRevision: run.revision, now: Date.now() },
        receiptId: `maintenance-verification:${run.graphRunId}`, expectedDaemonPid: options.expectedDaemonPid!,
        ...(options.expectedLockOwner ? { expectedLockOwner: options.expectedLockOwner } : {}),
        acceptanceRegistry: registration.delivery.acceptanceRegistry, inspectOnly,
      }, authorize);
    };
    if (options.apply !== true) {
      const verification = kind === 'verification' ? await verify(true) : undefined;
      assertSchema();
      return { mode: 'read_only' as const, guard, schemaVersion: CURRENT_SCHEMA_VERSION,
        schemaDigest: initialSchema, graphRunId: run.graphRunId, revision: run.revision, status: run.status,
        upgradeHolds: graphUpgradeHolds(db), ...(verification ? { verification } : {}) };
    }
    if (!options.backupDirectory) throw Error('MAINTENANCE_BACKUP_REQUIRED');
    const parent = realpathSync(options.backupDirectory); owned(parent, true);
    const directory = mkdtempSync(join(parent, 'graph-maintenance-')); chmodSync(directory, 0o700);
    const backupPath = join(directory, 'state.db');
    await db.backup(backupPath); chmodSync(backupPath, 0o600);
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try { if (backup.pragma('integrity_check', { simple: true }) !== 'ok' || schema(backup) !== initialSchema) throw Error('MAINTENANCE_BACKUP_INVALID'); }
    finally { backup.close(); }
    authorize();
    // The old serving release cannot make this preparation decision. Effect
    // decisions share the verifier's deterministic key; this operator owns only
    // the final project receipt. No concurrent public reconcile is permitted.
    const result = kind === 'verification' ? await verify(false) : await cancelUnstartedGraphPreparation(db, join(home, 'graph-delivery', run.graphRunId), registration.delivery.repositoryPath,
      { fence: { scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, expectedGeneration: run.generation,
        expectedOwner: run.leaseOwner, expectedRevision: run.revision, now: Date.now() }, receiptId: `maintenance-preparation:${run.graphRunId}` }, authorize);
    if (runs.get(run.scope, run.graphRunId)?.status !== 'cancelled' || actions() !== actionsBefore) throw Error('MAINTENANCE_RESULT_UNCONFIRMED');
    assertSchema();
    return { mode: 'applied', guard, schemaVersion: CURRENT_SCHEMA_VERSION, schemaDigest: initialSchema,
      graphRunId: run.graphRunId, status: 'cancelled', actionsUnchanged: true, backupPath, exit: 'exit' in result ? result.exit : 'inspection', upgradeHolds: graphUpgradeHolds(db) };
  } catch (error) {
    try { assertSchema(); } catch (schemaError) { throw new AggregateError([error, schemaError], 'MAINTENANCE_SCHEMA_CHANGED'); }
    throw error;
  } finally {
    try { await service?.close(); } finally { db.close(); }
  }
}
