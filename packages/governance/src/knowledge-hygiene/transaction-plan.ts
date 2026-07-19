import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { assertKnowledgeHygieneRepositoryPathV1 } from "./path-pattern.js";
import { KnowledgeHygieneEvidenceRefV2 } from "./types-v2.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const planId = z.string().regex(/^khtp_[a-f0-9]{64}$/);
const actionId = z.string().regex(/^khta_[a-f0-9]{64}$/);
const approvalId = z.string().regex(/^khtap_[a-f0-9]{64}$/);
const receiptId = z.string().regex(/^khtr_[a-f0-9]{64}$/);

const portablePath = z.string().min(1).superRefine((value, context) => {
  try {
    assertKnowledgeHygieneRepositoryPathV1(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export const KnowledgeHygieneByteSpanV1 = z.object({
  root_id: z.enum(["repo", "memory"]),
  path: portablePath,
  blob_sha256: sha256,
  start_byte: z.number().int().nonnegative(),
  end_byte: z.number().int().positive(),
  bytes_sha256: sha256,
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
}).strict().superRefine((span, context) => {
  if (span.end_byte <= span.start_byte) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["end_byte"],
      message: "end_byte must be greater than start_byte",
    });
  }
  if (span.end_line < span.start_line) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["end_line"],
      message: "end_line must be greater than or equal to start_line",
    });
  }
});
export type KnowledgeHygieneByteSpanV1 = z.infer<
  typeof KnowledgeHygieneByteSpanV1
>;

export const KnowledgeHygieneInsertionPointV1 = z.object({
  root_id: z.enum(["repo", "memory"]),
  path: portablePath,
  preimage_sha256: sha256.nullable(),
  anchor_sha256: sha256.optional(),
  placement: z.enum(["before", "after", "replace"]),
}).strict();
export type KnowledgeHygieneInsertionPointV1 = z.infer<
  typeof KnowledgeHygieneInsertionPointV1
>;

const claimDisposition = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("preserved"),
    target_bytes_sha256: sha256,
  }).strict(),
  z.object({
    status: z.literal("merged"),
    target_claim_id: z.string().min(1),
    source_claim_ids: z.array(z.string().min(1)).min(1),
  }).strict(),
  z.object({
    status: z.literal("explicitly_discarded"),
    reason: z.string().trim().min(1),
  }).strict(),
]);

const moveAction = z.object({
  action_id: actionId,
  kind: z.literal("move"),
  risk: z.literal("medium"),
  source: KnowledgeHygieneByteSpanV1,
  target: KnowledgeHygieneInsertionPointV1,
}).strict();

const compressAction = z.object({
  action_id: actionId,
  kind: z.literal("compress"),
  risk: z.literal("high"),
  sources: z.array(KnowledgeHygieneByteSpanV1).min(1),
  target: KnowledgeHygieneInsertionPointV1,
  replacement_utf8: z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= 2 * 1024 * 1024,
    "replacement_utf8 exceeds 2 MiB",
  ),
  claims: z.array(z.object({
    claim_id: z.string().min(1),
    source: KnowledgeHygieneByteSpanV1,
    disposition: claimDisposition,
  }).strict()).min(1),
}).strict().superRefine((action, context) => {
  const sourceKeys = action.sources.map(spanKey);
  const claimSourceKeys = action.claims.map((claim) => spanKey(claim.source));
  if (
    new Set(sourceKeys).size !== sourceKeys.length
    || new Set(claimSourceKeys).size !== claimSourceKeys.length
    || sourceKeys.length !== claimSourceKeys.length
    || sourceKeys.some((key) => !claimSourceKeys.includes(key))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["claims"],
      message: "compress claims must map every source exactly once",
    });
  }
  const claimIds = action.claims.map((claim) => claim.claim_id);
  if (new Set(claimIds).size !== claimIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["claims"],
      message: "compress claim_id values must be unique",
    });
  }
  const knownClaims = new Set(claimIds);
  for (const [index, claim] of action.claims.entries()) {
    if (
      claim.disposition.status === "merged"
      && (
        !knownClaims.has(claim.disposition.target_claim_id)
        || claim.disposition.source_claim_ids.some((id) => !knownClaims.has(id))
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claims", index, "disposition"],
        message: "merged claim references must resolve inside the action ledger",
      });
    }
  }
});

const deleteAction = z.object({
  action_id: actionId,
  kind: z.literal("delete"),
  risk: z.literal("high"),
  sources: z.array(KnowledgeHygieneByteSpanV1).min(1),
  discards: z.array(z.object({
    source_bytes_sha256: sha256,
    reason: z.string().trim().min(1),
  }).strict()).min(1),
}).strict().superRefine((action, context) => {
  const sources = action.sources.map((source) => source.bytes_sha256).sort();
  const discards = action.discards.map((discard) => discard.source_bytes_sha256)
    .sort();
  if (
    new Set(sources).size !== sources.length
    || new Set(discards).size !== discards.length
    || sources.length !== discards.length
    || sources.some((digest, index) => digest !== discards[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discards"],
      message: "delete discards must map every source exactly once",
    });
  }
});

export const KnowledgeHygienePlanActionV1 = z.union([
  moveAction,
  compressAction,
  deleteAction,
]);
export type KnowledgeHygienePlanActionV1 = z.infer<
  typeof KnowledgeHygienePlanActionV1
>;

export const KnowledgeHygienePlanApprovalV1 = z.object({
  approval_id: approvalId,
  actor: z.string().trim().min(1),
  action_ids: z.array(actionId).min(1),
  revision: z.number().int().positive(),
  approved_at: z.string().datetime(),
  reason: z.string().trim().min(1),
  local_user_id: z.string().min(1),
  tty_consented_at: z.string().datetime(),
}).strict();
export type KnowledgeHygienePlanApprovalV1 = z.infer<
  typeof KnowledgeHygienePlanApprovalV1
>;

export const KnowledgeHygieneWriteSetEntryV1 = z.object({
  root_id: z.enum(["repo", "memory"]),
  path: portablePath,
  preimage_sha256: sha256.nullable(),
  after_sha256: sha256,
  after_utf8: z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= 4 * 1024 * 1024,
    "write-set entry exceeds 4 MiB",
  ),
  mode: z.number().int().min(0).max(0o777),
}).strict().superRefine((entry, context) => {
  if (digest(entry.after_utf8) !== entry.after_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["after_sha256"],
      message: "after_sha256 must match after_utf8 bytes",
    });
  }
});
export type KnowledgeHygieneWriteSetEntryV1 = z.infer<
  typeof KnowledgeHygieneWriteSetEntryV1
>;

export const KnowledgeHygieneTransactionTargetV1 = z.object({
  root_id: z.enum(["repo", "memory"]),
  path: portablePath,
  purpose: z.enum([
    "documentation",
    "instruction_canonical",
    "memory_original",
    "governance_config",
  ]),
}).strict().superRefine((target, context) => {
  if (
    (target.purpose === "memory_original") !== (target.root_id === "memory")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["purpose"],
      message: "memory_original targets require the memory root; other targets require repo",
    });
  }
});
export type KnowledgeHygieneTransactionTargetV1 = z.infer<
  typeof KnowledgeHygieneTransactionTargetV1
>;

export const KnowledgeHygieneTransactionReceiptV1 = z.object({
  receipt_id: receiptId,
  kind: z.enum(["dry_run", "apply", "recovery"]),
  revision: z.number().int().positive(),
  status: z.enum(["verified", "applied", "already_applied", "recovered"]),
  manifest_sha256: sha256,
  paths: z.array(z.string().min(1)),
  occurred_at: z.string().datetime(),
  evaluation_only: z.boolean().optional(),
}).strict();

const rootDescriptor = z.object({
  root_realpath: z.string().min(1),
  fingerprint: sha256,
}).strict();

const repoDescriptor = rootDescriptor.extend({
  repo_id: z.string().min(1),
  base_revision: z.string().min(1),
}).strict();

const closureCondition = z.enum([
  "write_set_after_images_match",
  "move_bytes_present_at_target",
  "claim_ledger_complete",
  "discard_ledger_complete",
  "selected_findings_absent",
]);

const planObject = z.object({
  schema_version: z.literal("1"),
  plan_id: planId,
  kind: z.enum(["memory", "narrative", "dependency"]),
  revision: z.number().int().positive(),
  state: z.enum([
    "draft",
    "partially_approved",
    "approved",
    "applying",
    "applied",
    "recovery_required",
    "recovered",
    "stale",
    "cancelled",
  ]),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  repo: repoDescriptor,
  memory_root: rootDescriptor.optional(),
  actions: z.array(KnowledgeHygienePlanActionV1).min(1),
  write_set: z.array(KnowledgeHygieneWriteSetEntryV1).min(1),
  target_allowlist: z.array(KnowledgeHygieneTransactionTargetV1),
  evidence_refs: z.array(KnowledgeHygieneEvidenceRefV2),
  closure_conditions: z.array(closureCondition).min(1),
  approvals: z.array(KnowledgeHygienePlanApprovalV1),
  receipts: z.array(KnowledgeHygieneTransactionReceiptV1),
});

export const KnowledgeHygieneTransactionPlanV1 = planObject.strict()
  .superRefine((plan, context) => {
    if (Date.parse(plan.expires_at) <= Date.parse(plan.created_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expires_at"],
        message: "plan expiry must follow creation",
      });
    }
    if (plan.actions.some((action) => actionSources(action).some(
      (source) => source.root_id === "memory",
    )) && plan.memory_root === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memory_root"],
        message: "memory actions require an explicit memory root",
      });
    }
    const actionIds = plan.actions.map((action) => action.action_id);
    if (new Set(actionIds).size !== actionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actions"],
        message: "action_id values must be unique",
      });
    }
    const requiredConditions = new Set([
      "write_set_after_images_match",
      ...(plan.actions.some((action) => action.kind === "move")
        ? ["move_bytes_present_at_target"]
        : []),
      ...(plan.actions.some((action) => action.kind === "compress")
        ? ["claim_ledger_complete"]
        : []),
      ...(plan.actions.some((action) => action.kind === "delete")
        ? ["discard_ledger_complete"]
        : []),
      ...(plan.kind === "narrative" ? ["selected_findings_absent"] : []),
    ]);
    if (
      new Set(plan.closure_conditions).size !== plan.closure_conditions.length
      || [...requiredConditions].some((condition) =>
        !plan.closure_conditions.includes(condition as z.infer<typeof closureCondition>)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closure_conditions"],
        message: "plan closure conditions must be unique and complete",
      });
    }
    const sources = plan.actions.flatMap(actionSources)
      .sort((left, right) => spanKey(left).localeCompare(spanKey(right)));
    for (let index = 1; index < sources.length; index += 1) {
      const previous = sources[index - 1]!;
      const current = sources[index]!;
      if (
        previous.root_id === current.root_id
        && previous.path === current.path
        && current.start_byte < previous.end_byte
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actions"],
          message: "source byte spans cannot overlap",
        });
        break;
      }
    }
    const writeKeys = plan.write_set.map((entry) =>
      `${entry.root_id}:${entry.path}`
    );
    if (new Set(writeKeys).size !== writeKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["write_set"],
        message: "write-set paths must be unique",
      });
    }
    const writeSet = new Map(plan.write_set.map((entry) => [
      `${entry.root_id}:${entry.path}`,
      entry,
    ]));
    const allowlistKeys = plan.target_allowlist.map((target) =>
      `${target.root_id}:${target.path}`
    );
    if (new Set(allowlistKeys).size !== allowlistKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target_allowlist"],
        message: "target allowlist paths must be unique",
      });
    }
    const allowlist = new Map(plan.target_allowlist.map((target) => [
      `${target.root_id}:${target.path}`,
      target,
    ]));
    const memorySourcePaths = new Set(plan.actions.flatMap(actionSources)
      .filter((source) => source.root_id === "memory")
      .map((source) => source.path));
    for (const [index, action] of plan.actions.entries()) {
      for (const source of actionSources(action)) {
        const entry = writeSet.get(`${source.root_id}:${source.path}`);
        if (entry?.preimage_sha256 !== source.blob_sha256) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["actions", index],
            message: "source blob must match its write-set preimage",
          });
        }
      }
      const target = actionTarget(action);
      if (target !== undefined) {
        const entry = writeSet.get(`${target.root_id}:${target.path}`);
        if (entry?.preimage_sha256 !== target.preimage_sha256) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["actions", index, "target"],
            message: "target preimage must match its write-set entry",
          });
        }
        const allowed = allowlist.get(`${target.root_id}:${target.path}`);
        if (
          allowed === undefined
          || (allowed.purpose === "memory_original"
            && !memorySourcePaths.has(allowed.path))
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["actions", index, "target"],
            message: "action target is not an allowlisted destination",
          });
        }
      }
    }
    const knownActions = new Set(actionIds);
    const approved = new Set<string>();
    for (const [index, approval] of plan.approvals.entries()) {
      if (
        approval.revision !== plan.revision
        || new Set(approval.action_ids).size !== approval.action_ids.length
        || approval.action_ids.some((id) => !knownActions.has(id))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvals", index],
          message: "approval must target unique actions in the current revision",
        });
      }
      const highRisk = approval.action_ids.filter((id) =>
        plan.actions.find((action) => action.action_id === id)?.risk === "high"
      );
      if (highRisk.length > 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvals", index, "action_ids"],
          message: "high-risk actions require one approval at a time",
        });
      }
      approval.action_ids.forEach((id) => {
        approved.add(id);
      });
    }
    const expectedApprovalState = approved.size === 0
      ? "draft"
      : approved.size === actionIds.length
      ? "approved"
      : "partially_approved";
    if (
      ["draft", "partially_approved", "approved"].includes(plan.state)
      && plan.state !== expectedApprovalState
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: `plan state must be ${expectedApprovalState} for its approvals`,
      });
    }
    if (plan.plan_id !== planIdentity(plan)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["plan_id"],
        message: "plan_id does not match immutable plan content",
      });
    }
  });
export type KnowledgeHygieneTransactionPlanV1 = z.infer<
  typeof KnowledgeHygieneTransactionPlanV1
>;

export type CreateKnowledgeHygieneTransactionPlanInputV1 = Omit<
  z.input<typeof planObject>,
  | "schema_version"
  | "plan_id"
  | "state"
  | "closure_conditions"
  | "approvals"
  | "receipts"
>;

export interface ApproveKnowledgeHygieneTransactionPlanInputV1 {
  action_ids: string[];
  actor: string;
  reason: string;
  if_revision: number;
  local_user_id: string;
  tty_consented_at: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function spanKey(span: KnowledgeHygieneByteSpanV1): string {
  return `${span.root_id}:${span.path}:${span.start_byte}:${span.end_byte}:${span.bytes_sha256}`;
}

function actionSources(
  action: KnowledgeHygienePlanActionV1,
): KnowledgeHygieneByteSpanV1[] {
  return action.kind === "move" ? [action.source] : [...action.sources];
}

function actionTarget(
  action: KnowledgeHygienePlanActionV1,
): KnowledgeHygieneInsertionPointV1 | undefined {
  return action.kind === "delete" ? undefined : action.target;
}

function immutablePlan(plan: z.input<typeof planObject>) {
  return {
    schema_version: plan.schema_version,
    kind: plan.kind,
    revision: plan.revision,
    created_at: plan.created_at,
    expires_at: plan.expires_at,
    repo: plan.repo,
    ...(plan.memory_root === undefined ? {} : { memory_root: plan.memory_root }),
    actions: plan.actions,
    write_set: plan.write_set,
    target_allowlist: plan.target_allowlist,
    evidence_refs: plan.evidence_refs,
    closure_conditions: plan.closure_conditions,
  };
}

function planIdentity(plan: z.input<typeof planObject>): string {
  return `khtp_${digest(JSON.stringify(immutablePlan(plan)))}`;
}

export function createKnowledgeHygieneTransactionPlanV1(
  input: CreateKnowledgeHygieneTransactionPlanInputV1,
): KnowledgeHygieneTransactionPlanV1 {
  const closureConditions = [
    "write_set_after_images_match" as const,
    ...(input.actions.some((action) => action.kind === "move")
      ? ["move_bytes_present_at_target" as const]
      : []),
    ...(input.actions.some((action) => action.kind === "compress")
      ? ["claim_ledger_complete" as const]
      : []),
    ...(input.actions.some((action) => action.kind === "delete")
      ? ["discard_ledger_complete" as const]
      : []),
    ...(input.kind === "narrative" ? ["selected_findings_absent" as const] : []),
  ];
  const raw = {
    schema_version: "1" as const,
    plan_id: `khtp_${"0".repeat(64)}`,
    state: "draft" as const,
    approvals: [],
    receipts: [],
    closure_conditions: closureConditions,
    ...input,
  };
  const normalized = planObject.strict().parse(raw);
  return KnowledgeHygieneTransactionPlanV1.parse({
    ...normalized,
    plan_id: planIdentity(normalized),
  });
}

export function approveKnowledgeHygieneTransactionPlanV1(
  rawPlan: KnowledgeHygieneTransactionPlanV1,
  rawInput: ApproveKnowledgeHygieneTransactionPlanInputV1,
): KnowledgeHygieneTransactionPlanV1 {
  const plan = KnowledgeHygieneTransactionPlanV1.parse(rawPlan);
  if (rawInput.if_revision !== plan.revision) {
    throw new Error(
      `plan revision conflict: expected ${plan.revision}, received ${rawInput.if_revision}`,
    );
  }
  if (!["draft", "partially_approved", "approved"].includes(plan.state)) {
    throw new Error(`plan cannot be approved from state ${plan.state}`);
  }
  const actionIds = [...new Set(rawInput.action_ids)].sort();
  if (actionIds.length === 0 || actionIds.length !== rawInput.action_ids.length) {
    throw new Error("approval action ids must be non-empty and unique");
  }
  const selected = actionIds.map((id) => {
    const action = plan.actions.find((candidate) => candidate.action_id === id);
    if (action === undefined) throw new Error(`plan has no action ${id}`);
    return action;
  });
  if (selected.filter((action) => action.risk === "high").length > 1) {
    throw new Error("high-risk actions require one approval at a time");
  }
  const approvedAt = rawInput.tty_consented_at;
  if (Date.parse(approvedAt) >= Date.parse(plan.expires_at)) {
    throw new Error("plan is expired");
  }
  const approvalBody = {
    actor: rawInput.actor,
    action_ids: actionIds,
    revision: plan.revision,
    approved_at: approvedAt,
    reason: rawInput.reason,
    local_user_id: rawInput.local_user_id,
    tty_consented_at: rawInput.tty_consented_at,
  };
  const approval = KnowledgeHygienePlanApprovalV1.parse({
    ...approvalBody,
    approval_id: `khtap_${digest(JSON.stringify([plan.plan_id, approvalBody]))}`,
  });
  if (plan.approvals.some((item) => item.approval_id === approval.approval_id)) {
    return plan;
  }
  const priorActions = new Set(plan.approvals.flatMap((item) => item.action_ids));
  if (actionIds.some((id) => priorActions.has(id))) {
    throw new Error("one or more actions already have a different approval");
  }
  const approvals = [...plan.approvals, approval];
  const covered = new Set(approvals.flatMap((item) => item.action_ids));
  return KnowledgeHygieneTransactionPlanV1.parse({
    ...plan,
    approvals,
    state: covered.size === plan.actions.length ? "approved" : "partially_approved",
  });
}

export function renderKnowledgeHygieneTransactionPlanMarkdownV1(
  rawPlan: KnowledgeHygieneTransactionPlanV1,
): string {
  const plan = KnowledgeHygieneTransactionPlanV1.parse(rawPlan);
  const lines = [
    `# Plan ${plan.plan_id}`,
    "",
    `- Kind: ${plan.kind}`,
    `- Revision: ${plan.revision}`,
    `- State: ${plan.state}`,
    `- Repository: ${plan.repo.repo_id}`,
    `- Expires: ${plan.expires_at}`,
    "",
    "## Actions",
    "",
  ];
  for (const action of plan.actions) {
    lines.push(
      `- \`${action.action_id}\`: ${action.kind} (${action.risk})`,
    );
  }
  lines.push("", "## Write set", "");
  for (const entry of plan.write_set) {
    lines.push(
      `- ${entry.root_id}:${entry.path} — ${entry.preimage_sha256 ?? "absent"} → ${entry.after_sha256}`,
    );
  }
  lines.push("", "## Closure conditions", "");
  for (const condition of plan.closure_conditions) {
    lines.push(`- ${condition}`);
  }
  lines.push("", "## Target allowlist", "");
  for (const target of plan.target_allowlist) {
    lines.push(`- ${target.root_id}:${target.path} (${target.purpose})`);
  }
  return `${lines.join("\n")}\n`;
}
