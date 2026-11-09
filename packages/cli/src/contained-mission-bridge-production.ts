// Production effects for phase 5. Construction does not qualify or activate live startup.
import { z } from 'zod';
import type { RevisionChain } from '@osstack/core';
import type { GhExec } from './contained-mission-bridge-reader.js';
import type { assembleLiveBridge } from './contained-mission-bridge-assembly.js';

// Sandbox harness building blocks; the normal daemon still passes through its acceptance gate.
export { createContainedMissionPorts } from './contained-mission-ports.js';
export { ContainedMissionHost } from './contained-mission-host.js';
export { ContainedMissionService } from './contained-mission-rpc.js';
export { EngineeringAccess } from './engineering-access.js';
export { readCiFailureHints } from './contained-mission-local-failure-reader.js';
export { createActionsCiFailureReadDeps } from './contained-mission-local-failure-reader-transport.js';
export { readSandboxCiJobs, createSandboxCiReader } from './contained-mission-github-ci.js';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const compared = z.object({ status: z.enum(['ahead', 'behind', 'diverged', 'identical']),
  merge_base_commit: z.object({ sha: z.string().regex(SHA) }) });

/** Remote ancestry is a read. Missing local objects must not be mistaken for a regressed remote head. */
export async function readBridgeAncestry(chain: Pick<RevisionChain, 'repository' | 'published_head'>, observed: string,
  signal: AbortSignal, exec: GhExec): Promise<boolean> {
  signal.throwIfAborted();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(chain.repository) || !SHA.test(chain.published_head) || !SHA.test(observed)) throw Error('bridge_ancestry_target_invalid');
  if (observed === chain.published_head) return true;
  const result = await exec(['api', `repos/${chain.repository}/compare/${chain.published_head}...${observed}?per_page=1`], { timeoutMs: 30_000, signal });
  signal.throwIfAborted();
  if (result.exitCode !== 0) throw Error('bridge_ancestry_read_failed');
  const facts = compared.parse(JSON.parse(result.stdout) as unknown);
  return facts.status === 'ahead' && facts.merge_base_commit.sha === chain.published_head;
}

type AssemblyDeps = Parameters<typeof assembleLiveBridge>[0];
export type ProductionLiveBridgeDeps = Pick<AssemblyDeps, 'home' | 'chains' | 'missions' | 'ports' | 'host' | 'access' | 'enabled' | 'now' | 'log' | 'launchCaps'>;

/** All mutating effects use the host's W13 ledger and App A; all GitHub reads use host credentials. */
export async function createProductionLiveBridge(deps: ProductionLiveBridgeDeps) {
  // Validate signed issuer, producer identities and App configuration before installing any port.
  const { loadLiveBridgeConfiguration, assembleLiveBridge } = await import('./contained-mission-bridge-assembly.js');
  await loadLiveBridgeConfiguration(deps.home);
  if (!deps.ports.revisionPublicationAdapters) throw Error('BRIDGE_CONFIG_INVALID:live:publication_adapters_required');
  const caps = deps.ports.revisionLaunchCaps;
  if (!caps || caps.executor_seconds !== deps.launchCaps.executor_seconds || caps.verify_seconds !== deps.launchCaps.verify_seconds) throw Error('BRIDGE_CONFIG_INVALID:live:launch_caps_mismatch');
  if (!deps.ports.installRevisionCheckAuthority) throw Error('BRIDGE_CONFIG_INVALID:live:check_authority_required');
  deps.ports.installRevisionCheckAuthority(deps.enabled);
  const [{ missionProtectedSetDigest }, reader, { createReceiptReadAdapters }, { stoppedChainPrReader }] = await Promise.all([
    import('@osstack/governance'), import('./contained-mission-bridge-reader.js'),
    import('./contained-mission-bridge-receipt-adapter.js'), import('./contained-mission-bridge-stopped-scan.js'),
  ]);
  const readAbort = new AbortController();
  const exec: GhExec = (args, options) => reader.defaultGhExec(args, { ...options,
    signal: options.signal ? AbortSignal.any([options.signal, readAbort.signal]) : readAbort.signal });
  const transport = reader.ghGraphqlTransport(exec);
  const read = await createReceiptReadAdapters({ signal: readAbort.signal, exec, transport });
  const { compareBridgeLedgerRange } = await import('./contained-mission-bridge-ledger.js');
  const write = await deps.ports.revisionPublicationAdapters();
  const assembled = await assembleLiveBridge({ ...deps, protectedSetDigest: missionProtectedSetDigest,
    receiptReadAdapters: signal => createReceiptReadAdapters({ signal: AbortSignal.any([signal, readAbort.signal]), exec }),
    ledgerCompare: (repository, start, head, signal) => compareBridgeLedgerRange(repository, start, head, exec, signal),
    readPr: ref => reader.readPullRequest(transport, ref),
    headIsDescendant: (chain, head, signal) => readBridgeAncestry(chain, head, signal, exec),
    stoppedRead: stoppedChainPrReader(transport),
    publication: { ...read, ...write, checkEnabled: typeof deps.ports.publishVerifyCheck === 'function' },
  });
  for (const service of [assembled.live, assembled.stoppedScan]) {
    const stop = service.stop.bind(service);
    service.stop = async () => { readAbort.abort(); await stop(); };
  }
  return assembled;
}
