// JSON Schema generation — Zod is the source of truth; this module emits the
// committed schemas/*.schema.json artifacts. A single manifest is the shared
// source of truth for both scripts/generate-schemas.mjs (writes/checks the
// files) and schemas.test.ts (asserts zero drift), so regeneration is
// guaranteed identical from either entry point.
//
// NOTE (superRefine): the A-003 status<->code conditional rules on
// AgentCommandResult are enforced by a Zod superRefine, which zod-to-json-schema
// cannot represent. The generated agent-command-result schema therefore
// documents the object SHAPE only; the conditional rules live in the superRefine
// and the tests. This is a known, documented limitation, not a gap.

import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AgentCommand,
  AgentCommandResultObject,
} from "./envelope.js";
import { ApprovalDecision, ApprovalRequest } from "./approval.js";
import { EvidenceRef } from "./evidence.js";
import { EventEnvelope } from "./event.js";
import { PolicyDecision } from "./policy.js";
import { RunSummary } from "./run.js";
import { Task } from "./task.js";

interface SchemaEntry {
  /** File basename (without the .schema.json suffix) and schema registry key. */
  key: string;
  /** Human-readable title embedded in the JSON Schema. */
  title: string;
  schema: ZodTypeAny;
}

/** The 9 public protocol contracts emitted as JSON Schema. Order is stable. */
export const SCHEMA_MANIFEST: readonly SchemaEntry[] = [
  { key: "task", title: "Osstack Protocol Task", schema: Task },
  { key: "run-summary", title: "Osstack Protocol Run Summary", schema: RunSummary },
  { key: "event-envelope", title: "Osstack Protocol Event Envelope", schema: EventEnvelope },
  { key: "evidence-ref", title: "Osstack Protocol Evidence Ref", schema: EvidenceRef },
  { key: "approval-request", title: "Osstack Protocol Approval Request", schema: ApprovalRequest },
  { key: "approval-decision", title: "Osstack Protocol Approval Decision", schema: ApprovalDecision },
  { key: "policy-decision", title: "Osstack Protocol Policy Decision", schema: PolicyDecision },
  { key: "agent-command", title: "Osstack Protocol Agent Command", schema: AgentCommand },
  {
    key: "agent-command-result",
    title: "Osstack Protocol Agent Command Result",
    schema: AgentCommandResultObject,
  },
];

/** Render one schema entry to a pretty-printed JSON Schema string (trailing NL). */
function renderSchema(entry: SchemaEntry): string {
  const json = zodToJsonSchema(entry.schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  // Stable, self-describing header fields, independent of Zod internals.
  const withMeta: Record<string, unknown> = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: entry.title,
    ...json,
  };
  return `${JSON.stringify(withMeta, null, 2)}\n`;
}

/** filename -> file content for every committed schema. */
export function generateAll(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of SCHEMA_MANIFEST) {
    out[`${entry.key}.schema.json`] = renderSchema(entry);
  }
  return out;
}
