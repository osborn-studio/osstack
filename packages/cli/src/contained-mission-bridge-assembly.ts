// Testable phase 5-E assembly. This does not open the production live-mode gate.
import { parseStoredGrant, type ContainedMissionStore, type RevisionChainStore } from '@osstack/core';
import type { EngineeringAccess } from './engineering-access.js';
import type { ContainedMissionHost } from './contained-mission-host.js';
import type { ContainedMissionHostPorts } from './contained-mission-ports.js';
import type { DispatchRevisionDeps } from './contained-mission-revision.js';
import type { LiveReconcilerOptions } from './contained-mission-bridge-live.js';
import type { RevisionPublicationDeps } from './contained-mission-revision-publication.js';

/** Validate every live configuration before constructing a service or installing a write port. */
export async function loadLiveBridgeConfiguration(home: string) {
  const [{ loadBridgeConfig }, { loadProducerRegistry }, { loadRevisionIssuer }] = await Promise.all([
    import('./contained-mission-github-app.js'), import('./contained-mission-bridge-registry.js'), import('./contained-mission-grant.js'),
  ]);
  const [bridge, registry, issuer] = await Promise.all([loadBridgeConfig(home), loadProducerRegistry(home), loadRevisionIssuer(home)]);
  if (!bridge) throw Error('BRIDGE_CONFIG_INVALID:live:apps_rulesets_required');
  if (!registry) throw Error('BRIDGE_CONFIG_INVALID:live:producers_required');
  if (!issuer) throw Error('BRIDGE_CONFIG_INVALID:live:revision_issuer_required');
  if (bridge.repository.toLowerCase() !== registry.repository.toLowerCase()
    || !registry.publisher.some(p => p.app_id === bridge.publisher.app_id)) throw Error('BRIDGE_CONFIG_INVALID:live:publisher_mismatch');
  return { bridge, registry, issuer };
}

/** Callers must provide the real fenced publisher and protected-set reader. No fallback credentials or synthetic write ports. */
export async function assembleLiveBridge(deps: {
  home: string; chains: RevisionChainStore; missions: ContainedMissionStore;
  ports: ContainedMissionHostPorts;
  host: Pick<ContainedMissionHost, 'isBusy' | 'cancel' | 'cancelFromBridge'>;
  access: EngineeringAccess;
  enabled: () => boolean;
  now: () => number;
  log: (line: string) => void;
  launchCaps: DispatchRevisionDeps['launchCaps'];
  protectedSetDigest: () => string;
  readPr: DispatchRevisionDeps['readPr'];
  headIsDescendant: LiveReconcilerOptions['headIsDescendant'];
  publication: Omit<RevisionPublicationDeps, 'chains' | 'missions' | 'host' | 'now' | 'fenceAuthority' | 'cancelChild'>;
  stoppedRead: import('./contained-mission-bridge-stopped-scan.js').StoppedChainScanOptions['readPr'];
  ledgerCompare?: import('./contained-mission-bridge-ledger.js').LedgerCompare;
  /** Startup/manual recovery cancellation belongs to that invocation, not the live scanner lifetime. */
  receiptReadAdapters?: (signal: AbortSignal) => Promise<Pick<RevisionPublicationDeps, 'remoteHead' | 'localGit' | 'compare' | 'readPr' | 'remoteIsDescendant'>>;
}) {
  const config = await loadLiveBridgeConfiguration(deps.home);
  if (!/^[0-9a-f]{64}$/.test(deps.protectedSetDigest())) throw Error('BRIDGE_CONFIG_INVALID:live:protected_set_digest');
  for (const cap of [deps.launchCaps.executor_seconds, deps.launchCaps.verify_seconds]) {
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('BRIDGE_CONFIG_INVALID:live:launch_caps');
  }
  const [revision, publication, grant, { LiveReconciler }, { StoppedChainScanService }, { BridgeReadLimiter }, { createRevisionCheckRetryScheduler }] = await Promise.all([
    import('./contained-mission-revision.js'), import('./contained-mission-revision-publication.js'), import('./contained-mission-grant.js'),
    import('./contained-mission-bridge-live.js'), import('./contained-mission-bridge-stopped-scan.js'), import('./contained-mission-bridge-read-limiter.js'),
    import('./contained-mission-revision-check-retry.js'),
  ]);
  const common = { chains: deps.chains, missions: deps.missions, access: deps.access, now: deps.now,
    enabled: deps.enabled, keys: () => config.issuer.keys, launchCaps: deps.launchCaps };
  const cancel = async (missionId: string, principalId: string, sessionId: string) => {
    let actor: ReturnType<EngineeringAccess['refresh']> | undefined;
    try { actor = deps.access.refresh(principalId, sessionId); } catch { /* revoked authority still owes cancellation */ }
    if (actor) {
      try { await deps.host.cancel(actor, missionId); return; }
      catch (error) { if (!(error instanceof Error) || error.message !== 'permission_denied') throw error; }
    }
    await deps.host.cancelFromBridge(missionId);
  };
  const pub = publication.createRevisionPublicationPort({ ...deps.publication, chains: deps.chains, missions: deps.missions,
    host: deps.ports.hostProcesses, now: deps.now,
    fenceAuthority: () => ({ enabled: deps.enabled(), access: deps.access, keys: config.issuer.keys, now: deps.now() }),
    cancelChild: async id => {
      const chain = deps.chains.chainForMission(id, 'live');
      if (!chain) throw Error('revision_chain_missing');
      const signed = parseStoredGrant(chain.grant_json);
      await cancel(id, signed.principal_id, signed.client_session_id);
    },
  });
  const receipts = publication.createRevisionReceiptRecovery({ ...deps.publication, chains: deps.chains, missions: deps.missions,
    host: deps.ports.hostProcesses, now: deps.now });
  const ledger = await import('./contained-mission-bridge-ledger.js');
  const ledgerDeps = { chains: deps.chains, missions: deps.missions, remoteHead: deps.publication.remoteHead,
    compare: deps.ledgerCompare ?? deps.publication.compare };
  const cancelChain = async (chain: import('@osstack/core').RevisionChain) => {
    if (!chain.current_mission_id) return;
    const signed = parseStoredGrant(chain.grant_json);
    await cancel(chain.current_mission_id, signed.principal_id, signed.client_session_id);
  };
  const revisionRecovery = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const invocationReads = await deps.receiptReadAdapters?.(signal);
    const invocationReceipts = invocationReads ? publication.createRevisionReceiptRecovery({ ...deps.publication, ...invocationReads,
      chains: deps.chains, missions: deps.missions, host: deps.ports.hostProcesses, now: deps.now }) : receipts;
    let afterIntentId: string | undefined;
    while (!signal.aborted) {
      const page = await invocationReceipts.recoverPendingReceipts({ limit: 10, signal, ...(afterIntentId ? { afterIntentId } : {}) });
      if (page.complete) break;
      if (!page.afterIntentId || page.afterIntentId === afterIntentId) throw Error('receipt_recovery_cursor_stalled');
      afterIntentId = page.afterIntentId;
    }
    await ledger.recoverBridgeLedgers({ ...ledgerDeps, ...(invocationReads ? { remoteHead: invocationReads.remoteHead } : {}), now: deps.now, cancelChild: cancelChain }, signal);
  };
  const readLimiter = new BridgeReadLimiter();
  const live = new LiveReconciler({ dispatch: { ...common, registry: config.registry, readPr: deps.readPr, protectedSetDigest: deps.protectedSetDigest },
    readLimiter, isBusy: id => deps.host.isBusy(id), headIsDescendant: deps.headIsDescendant, log: deps.log,
    verifyLedger: (chain, signal) => ledger.verifyBridgeLedger(ledgerDeps, chain, signal),
    cancelChild: async chain => {
      if (!chain.current_mission_id) return;
      const signed = parseStoredGrant(chain.grant_json);
      await cancel(chain.current_mission_id, signed.principal_id, signed.client_session_id);
    },
  });
  const stoppedScan = new StoppedChainScanService({ chains: deps.chains, enabled: deps.enabled, now: deps.now, readLimiter,
    missionState: id => deps.missions.get(id).state, refreshPrincipal: (id, session) => deps.access.refresh(id, session),
    cancelChild: (actor, id) => actor ? deps.host.cancel(actor, id) : deps.host.cancelFromBridge(id), readPr: deps.stoppedRead, log: deps.log,
    auditLedger: async (chain, signal) => {
      if (await ledger.verifyBridgeLedger(ledgerDeps, chain, signal) !== 'external_write') return;
      const stopped = deps.chains.stopLive(chain.chain_id, chain.revision, 'external_write', deps.now());
      await cancelChain(stopped);
    } });
  const grants = new grant.RevisionGrantService({ chains: deps.chains, missions: await grant.createGrantMissionView(deps.missions),
    compare: deps.ledgerCompare ?? deps.publication.compare,
    access: deps.access, registry: config.registry, readPr: deps.readPr, loadIssuer: () => grant.loadRevisionIssuer(deps.home),
    enabled: deps.enabled, now: deps.now, protectedSetDigest: deps.protectedSetDigest,
    reconcileReceipt: chain => receipts.reconcileUncertain(chain),
    cancelChild: async (actor, id) => { await cancel(id, actor.principal_id, actor.client_session_id); },
  });
  const sendCheck = deps.ports.publishVerifyCheck;
  const checkRetry = deps.publication.checkEnabled && sendCheck ? createRevisionCheckRetryScheduler({
    chains: deps.chains, missions: deps.missions, now: deps.now, enabled: deps.enabled, log: deps.log,
    publishCheck: childId => pub.publishCheck(childId, sendCheck),
  }) : undefined;
  // Attach only after every constructor and configuration validation succeeded.
  deps.ports.revision = revision.createRevisionLaunchPort(common);
  deps.ports.revisionPublication = pub;
  return { live, stoppedScan, grants, publication: pub, readLimiter, revisionRecovery, checkRetry };
}
