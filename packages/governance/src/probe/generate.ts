import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ProbeEventV1,
  ProbeItemV1,
  ProbeLedgerV1,
  ProbeQuestionBatchV1,
  ProbeRenderManifestV1,
  ProbeRestatementFindingV1,
  ProbeSessionV1,
} from "./types.js";
import { ProbeGatePolicyV1 } from "./gate.js";

interface ProbeSchemaEntryV1 {
  key: string;
  title: string;
  comment?: string;
  schema: ZodTypeAny;
}

export const PROBE_SCHEMA_MANIFEST_V1 = Object.freeze([
  {
    key: "probe-item-v1",
    title: "Osstack Probe Item v1",
    comment:
      "Option uniqueness, selected-option membership, and calibration destination constraints are additionally enforced by @osstack/governance Zod validation.",
    schema: ProbeItemV1,
  },
  {
    key: "probe-session-v1",
    title: "Osstack Probe Session v1",
    comment:
      "Question-count, uniqueness, and selected/unselected disjointness constraints are additionally enforced by @osstack/governance Zod validation.",
    schema: ProbeSessionV1,
  },
  {
    key: "probe-event-v1",
    title: "Osstack Probe Event v1",
    schema: ProbeEventV1,
  },
  {
    key: "probe-ledger-v1",
    title: "Osstack Probe Portable Ledger v1",
    comment:
      "Cross-object session, item, event, revision, and current-question constraints are additionally enforced by @osstack/governance Zod validation.",
    schema: ProbeLedgerV1,
  },
  {
    key: "probe-question-batch-v1",
    title: "Osstack Probe Dynamic Question Batch v1",
    comment:
      "Question-id uniqueness and batch/question origin equality are additionally enforced by @osstack/governance Zod validation.",
    schema: ProbeQuestionBatchV1,
  },
  {
    key: "probe-restatement-finding-v1",
    title: "Osstack Probe Restatement Finding v1",
    comment:
      "At least one side of the restatement comparison must carry evidence; @osstack/governance Zod validation enforces this constraint.",
    schema: ProbeRestatementFindingV1,
  },
  {
    key: "probe-policy-v1",
    title: "Osstack Probe Readiness Policy v1",
    comment:
      "YAML policy uses numeric schema_version 1; defaults are applied by @osstack/governance Zod validation.",
    schema: ProbeGatePolicyV1,
  },
  {
    key: "probe-render-manifest-v1",
    title: "Osstack Probe Render Manifest v1",
    comment:
      "File paths must be unique and must exclude render-manifest.json; @osstack/governance Zod validation enforces this constraint.",
    schema: ProbeRenderManifestV1,
  },
] satisfies readonly ProbeSchemaEntryV1[]);

function renderSchema(entry: ProbeSchemaEntryV1): string {
  const generated = zodToJsonSchema(entry.schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  return `${JSON.stringify(
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: entry.title,
      ...(entry.comment === undefined ? {} : { $comment: entry.comment }),
      ...generated,
    },
    null,
    2,
  )}\n`;
}

export function generateAllProbeSchemasV1(): Record<string, string> {
  return Object.fromEntries(
    PROBE_SCHEMA_MANIFEST_V1.map((entry) => [
      `${entry.key}.schema.json`,
      renderSchema(entry),
    ]),
  );
}
