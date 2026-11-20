import { randomUUID } from "node:crypto";
import type { ContainedMissionStore } from "@osstack/core";
import { DiagnosisStore, LocalFailureRecheckRunStore } from "@osstack/core/verification-intake";
import { readActionsAttemptFact } from "./contained-mission-actions-attempt.js";
import type { GithubCiPolicy } from "./contained-mission-ci-policy.js";
import type { GrantLiveContext } from "./contained-mission-grant.js";
import type { RecheckCollectorDeps } from "./contained-mission-local-failure-recheck-collect.js";
import type { RecheckRunPorts } from "./contained-mission-local-failure-recheck-run.js";
import {
  loadInstalledVerificationProfile,
  type InstalledVerificationProfileHost,
} from "./contained-mission-verification-profile.js";
import { exportContainedCommit } from "./contained-verification.js";

export interface RecheckRunPortsConfig {
  store: ContainedMissionStore;
  now(): number;
  keys(): GrantLiveContext["keys"];
  access: GrantLiveContext["access"];
  profileHost: InstalledVerificationProfileHost;
  repositoryPath: string;
  docker: { socketPath: string; daemonId: string; baseImageId: string; journalRoot: string };
}

export function createRecheckRunPorts(config: RecheckRunPortsConfig): RecheckRunPorts {
  const { store, now, keys, access, profileHost, repositoryPath, docker } = config;
  const { socketPath, daemonId, baseImageId, journalRoot } = docker;
  const assertOwner = () => store.attention.assertOwner(store.owner);
  return {
    store: new DiagnosisStore(store.attention, store.owner, now),
    now,
    keys,
    access,
    loadInstalledProfile: (binding) => loadInstalledVerificationProfile(profileHost, binding),
    readCandidate: async (head) => exportContainedCommit(repositoryPath, head),
    imageOptions: { socketPath, daemonId, baseImageId },
    host: { socketPath, journalRoot, authorizeStop: assertOwner, authorizeRead: assertOwner },
    randomId: randomUUID,
  };
}

export interface RecheckCollectorPortsConfig {
  store: ContainedMissionStore;
  now(): number;
  actions?: { ci: Parameters<typeof readActionsAttemptFact>[0]; policy: GithubCiPolicy };
}

// The ledger stores only contract digests. Supplying readOriginalContract and readRecheckContracts
// depends on the owner's decision about who reads and records the Watcher result.
export function createRecheckCollectorPorts({
  store,
  now,
  actions,
}: RecheckCollectorPortsConfig): Pick<RecheckCollectorDeps, "readActions" | "hostProof"> {
  const runs = new LocalFailureRecheckRunStore(new DiagnosisStore(store.attention, store.owner, now), now);
  return {
    hostProof: (id) => runs.hostProof(id),
    readActions: async (q, signal) => {
      if (!actions || q.repository !== actions.policy.repository || q.repository_id !== actions.policy.repositoryId)
        return null;
      const { pr, head, base, branch } = q;
      return readActionsAttemptFact(actions.ci, actions.policy, { pr, head, base, branch }, { signal });
    },
  };
}
