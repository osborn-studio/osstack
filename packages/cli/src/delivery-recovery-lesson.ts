import { deliveryCheckReference, deliveryContractDigest } from "@osstack/core";
import { writeLessonDraft, type LoopRunOptions } from "@osstack/loop";
import type {
  DeliveryReceiptReferenceV2,
  FrozenDeliveryContractV2,
} from "@osstack/protocol";
import {
  persistDeliveryHostRecord,
  readDeliveryHostRecord,
  verifyPersistedDeliveryReceipt,
} from "./delivery-contract-host.js";
import { join } from "node:path";

type Observation = Parameters<
  NonNullable<LoopRunOptions["observeVerification"]>
>[0];
interface Attempt {
  schemaVersion: 1;
  source: "osstack_verifier_observer";
  loopId: string;
  taskId: string;
  runId: string;
  iteration: number;
  contractDigest: string;
  policyDigest: string;
  workspaceDigest: string;
  pass: boolean;
  checks: Array<{
    reference: string;
    exitCode: number;
    exitConfirmed: boolean;
  }>;
}
/** In-process host port only. No CLI/JSON import endpoint can insert observations.
 * Durable references are evidence, never authorization; successful recovery is emitted only by this live execution closure.
 */
export function createDeliveryRecoveryLesson(input: {
  frozen: FrozenDeliveryContractV2;
  stateDirectory: string;
  assertVerified: (workspace: string) => Promise<string>;
}) {
  const attempts: Array<{ record: Attempt; ref: DeliveryReceiptReferenceV2 }> =
    [];
  const root = join(input.stateDirectory, "recovery-evidence");
  let activeLoop: string | undefined;
  let activeWorkspace: string | undefined;
  let finalized = false;
  return {
    async observe(observation: Observation): Promise<void> {
      if (
        finalized ||
        attempts.length >= 10 ||
        observation.task.task_id !== input.frozen.contract.task_id ||
        observation.iteration !== attempts.length + 1
      )
        throw Error("lesson_attempt_sequence_invalid");
      if (
        activeLoop !== undefined &&
        (activeLoop !== observation.loopId ||
          activeWorkspace !== observation.workspacePath)
      )
        throw Error("lesson_execution_scope_changed");
      activeLoop = observation.loopId;
      activeWorkspace = observation.workspacePath;
      const workspaceDigest = await input.assertVerified(
        observation.workspacePath,
      );
      const checks = (observation.verdict.verify_commands ?? []).map(
        (check) => ({
          reference: deliveryCheckReference(check.command),
          exitCode: check.exit_code,
          exitConfirmed: check.exit_confirmed === true,
        }),
      );
      if (
        checks.length === 0 ||
        checks.length > 200 ||
        checks.some((check) => !Number.isSafeInteger(check.exitCode)) ||
        new Set(checks.map((check) => check.reference)).size !== checks.length
      )
        throw Error("lesson_verifier_checks_invalid");
      for (const check of input.frozen.contract.required_checks)
        if (!checks.some((actual) => actual.reference === check.registry_ref))
          throw Error("lesson_verifier_check_missing");
      const record: Attempt = {
        schemaVersion: 1,
        source: "osstack_verifier_observer",
        loopId: observation.loopId,
        taskId: observation.task.task_id,
        runId: observation.run.run_id,
        iteration: observation.iteration,
        contractDigest: input.frozen.digest,
        policyDigest: input.frozen.contract.policy_digest,
        workspaceDigest,
        pass: observation.verdict.pass,
        checks,
      };
      const ref = await persistDeliveryHostRecord(root, record);
      attempts.push({ record, ref });
    },
    async finish(inputReceipt: {
      root: string;
      ref: DeliveryReceiptReferenceV2;
      runId: string;
    }) {
      if (finalized) throw Error("lesson_already_finalized");
      finalized = true;
      const last = attempts.at(-1);
      if (!last?.record.pass || attempts.length < 2)
        return {
          state: "not_qualified" as const,
          reason: "no_verified_repair_history",
        };
      // Re-read every create-only host record; stale/tampered evidence cannot be silently replaced by caller JSON.
      for (const attempt of attempts)
        if (
          deliveryContractDigest(
            await readDeliveryHostRecord(root, attempt.ref),
          ) !== deliveryContractDigest(attempt.record)
        )
          throw Error("lesson_attempt_evidence_changed");
      if (!activeWorkspace) throw Error("lesson_workspace_missing");
      const { receipt } = await verifyPersistedDeliveryReceipt({
        root: inputReceipt.root,
        ref: inputReceipt.ref,
        frozen: input.frozen,
        runId: inputReceipt.runId,
        workspace: activeWorkspace,
      });
      if (
        last.record.checks.some((check) => !check.exitConfirmed) ||
        receipt.run_id !== last.record.runId ||
        receipt.workspace_state_digest !== last.record.workspaceDigest ||
        !activeWorkspace ||
        (await input.assertVerified(activeWorkspace)) !==
          last.record.workspaceDigest
      )
        throw Error("lesson_success_binding_mismatch");
      const successfulChecks = receipt.checks.map((check) => ({
        reference: check.registry_ref,
        exitCode: check.exit_code,
      }));
      if (
        deliveryContractDigest(successfulChecks) !==
        deliveryContractDigest(
          last.record.checks.map(({ reference, exitCode }) => ({
            reference,
            exitCode,
          })),
        )
      )
        throw Error("lesson_success_check_mismatch");
      const failures = attempts
        .slice(0, -1)
        .filter(
          (attempt) =>
            !attempt.record.pass &&
            attempt.record.workspaceDigest !== last.record.workspaceDigest &&
            attempt.record.checks.some(
              (check) =>
                check.exitConfirmed &&
                check.exitCode > 0 &&
                check.exitCode < 124 &&
                input.frozen.contract.required_checks.some(
                  (required) => required.registry_ref === check.reference,
                ) &&
                successfulChecks.some(
                  (success) =>
                    success.reference === check.reference &&
                    success.exitCode === 0,
                ),
            ),
        );
      if (failures.length === 0)
        return {
          state: "not_qualified" as const,
          reason: "no_required_check_failure_with_changed_source",
        };
      const key = deliveryContractDigest({
        contract: input.frozen.digest,
        attempts: attempts.map((attempt) => attempt.ref.digest),
        success: inputReceipt.ref.digest,
      });
      const result = await writeLessonDraft(
        {
          task: {
            task_id: `recovery-${key.slice(0, 48)}`,
            capability: "code.fix",
            source: "manual",
            priority: 50,
            prompt: `Host-verified recovery for contract ${input.frozen.digest}. Canonical JSON task identity digest ${deliveryContractDigest(input.frozen.contract.task_id)}. Candidate tree ${receipt.candidate.tree_id}. This is review material; no automatic skill change or publication.`,
          },
          iterations: last.record.iteration,
          feedback: failures.map((attempt) => ({
            attempt: attempt.record.iteration,
            verdict_summary: `Required local check rejected source ${attempt.record.workspaceDigest}; host evidence ${attempt.ref.digest}`,
            blocking_issues: [
              {
                severity: "error" as const,
                message: `Actual verifier command failed. Canonical JSON run identity digest ${deliveryContractDigest(attempt.record.runId)}`,
              },
            ],
            failed_evaluations: attempt.record.checks
              .filter(
                (check) =>
                  check.exitConfirmed &&
                  check.exitCode > 0 &&
                  check.exitCode < 124,
              )
              .map((check) => check.reference),
            suggested_focus: [
              "Keep the same registered check while changing source; independently review the final candidate.",
            ],
          })),
          changedFiles: [],
          diffSummary: `Changed source: ${failures.map((attempt) => attempt.record.workspaceDigest).join(", ")} -> ${last.record.workspaceDigest}. Successful verification receipt ${inputReceipt.ref.digest}; policy ${input.frozen.contract.policy_digest}.`,
        },
        { workspacePath: input.stateDirectory },
      );
      return {
        state: "draft" as const,
        ...result,
        evidence: attempts.map((attempt) => attempt.ref),
        successReceipt: inputReceipt.ref,
        qualification: "host_verified_required_check_recovery",
        promoted: false,
      };
    },
  };
}
