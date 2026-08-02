import { createHash } from "node:crypto";
import { sortProbeItems } from "./priority.js";
import {
  deriveProbeReadiness,
  type ProbeDomainStateV1,
} from "./reducer.js";
import {
  ProbeEventV1,
  ProbeLedgerV1,
  ProbeRenderManifestV1,
  type ProbeEventV1 as ProbeEvent,
  type ProbeLedgerV1 as ProbeLedger,
  type ProbeRenderManifestV1 as ProbeRenderManifest,
} from "./types.js";

export type ProbeRenderTargetV1 =
  | "ledger"
  | "product-delta"
  | "technical-delta"
  | "test-matrix";

export interface CreateProbeRenderBundleInputV1 {
  state: ProbeDomainStateV1;
  events: readonly ProbeEvent[];
  exported_at_ms: number;
  generator_version: string;
  targets: readonly ProbeRenderTargetV1[];
}

export interface ProbeRenderedFileV1 {
  path: string;
  content: string;
  sha256: string;
  bytes: number;
}

export interface ProbeRenderBundleV1 {
  ledger: ProbeLedger;
  ledger_sha256: string;
  files: ProbeRenderedFileV1[];
  manifest: ProbeRenderManifest;
  manifest_content: string;
}

export type ProbeRenderIntegrityCodeV1 =
  | "missing_file"
  | "sha256_mismatch"
  | "bytes_mismatch"
  | "noncanonical_ledger"
  | "markdown_binding_mismatch"
  | "manifest_revision_mismatch";

export class ProbeRenderIntegrityError extends Error {
  readonly code: ProbeRenderIntegrityCodeV1;
  readonly path?: string;

  constructor(
    code: ProbeRenderIntegrityCodeV1,
    message: string,
    path?: string,
  ) {
    super(message);
    this.name = "ProbeRenderIntegrityError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
}

export function canonicalProbeJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value))}\n`;
}

export function probeSha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function renderedFile(path: string, content: string): ProbeRenderedFileV1 {
  return {
    path,
    content,
    sha256: probeSha256(content),
    bytes: Buffer.byteLength(content),
  };
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\r", "").replaceAll("\n", "<br>");
}

function renderLedgerMarkdown(
  ledger: ProbeLedger,
  sourceSha256: string,
): string {
  const rows = ledger.items.map((item) => {
    const disposition =
      item.state === "resolved"
        ? item.resolution.answer
        : item.state === "deferred"
          ? item.deferral.revisit_trigger
          : item.state === "waived"
            ? item.waiver.reason
            : item.state === "invalidated"
              ? item.invalidation.reason
              : "—";
    return `| ${item.item_id} | ${item.current_quadrant.toUpperCase()} | ${item.state} | ${item.category} | ${markdownCell(disposition)} |`;
  });
  return [
    "---",
    `probe_session_id: ${ledger.session.session_id}`,
    `probe_schema_version: ${ledger.schema_version}`,
    `probe_revision: ${ledger.session.revision}`,
    `source_sha256: ${sourceSha256}`,
    "---",
    "",
    `# Probe ledger: ${ledger.session.session_id}`,
    "",
    `- State: ${ledger.session.state}`,
    `- Required disposed: ${ledger.readiness.required_disposed}/${ledger.readiness.required_total}`,
    `- Completion: ${ledger.readiness.completion_percent}%`,
    "",
    "| Item | Quadrant | State | Category | Disposition |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function renderDelta(
  ledger: ProbeLedger,
  target: Exclude<ProbeRenderTargetV1, "ledger">,
): string {
  const docType =
    target === "product-delta" ? "product" : target === "test-matrix" ? "test" : "tech";
  const title =
    target === "product-delta"
      ? "Product decision delta"
      : target === "test-matrix"
        ? "Test matrix delta"
        : "Technical decision delta";
  const resolved = ledger.items.filter(
    (
      item,
    ): item is Extract<ProbeLedger["items"][number], { state: "resolved" }> =>
      item.doc_type === docType && item.state === "resolved",
  );
  return [
    `# ${title}`,
    "",
    `- Probe session: ${ledger.session.session_id}`,
    `- Revision: ${ledger.session.revision}`,
    "",
    ...(resolved.length === 0
      ? ["No resolved decisions for this document type.", ""]
      : resolved.flatMap((item) => [
          `## ${item.prompt}`,
          "",
          item.resolution.answer,
          "",
          `Destination: ${item.destination.role === "session_profile" ? "session profile" : item.destination.path} (${item.destination.write_state})`,
          "",
        ])),
  ].join("\n");
}

export function createProbeRenderBundle(
  input: CreateProbeRenderBundleInputV1,
): ProbeRenderBundleV1 {
  const targets = [...new Set(input.targets)];
  if (targets.length === 0) throw new Error("at least one render target is required");
  const events = [...input.events]
    .map((event) => ProbeEventV1.parse(event))
    .sort((left, right) => left.revision - right.revision || left.event_id.localeCompare(right.event_id));
  const items = sortProbeItems(input.state.items);
  const state = { session: input.state.session, items };
  const ledger = ProbeLedgerV1.parse({
    schema_version: "1",
    session: input.state.session,
    items,
    events,
    readiness: deriveProbeReadiness(state, input.exported_at_ms),
    artifact: {
      exported_revision: input.state.session.revision,
      exported_at_ms: input.exported_at_ms,
      generator_version: input.generator_version,
    },
    redactions: [],
  });
  const ledgerContent = canonicalProbeJson(ledger);
  const ledgerSha256 = probeSha256(ledgerContent);
  const files = [
    renderedFile("ledger.json", ledgerContent),
    renderedFile("ledger.md", renderLedgerMarkdown(ledger, ledgerSha256)),
    ...targets
      .filter((target): target is Exclude<ProbeRenderTargetV1, "ledger"> => target !== "ledger")
      .sort()
      .map((target) => renderedFile(`${target}.md`, renderDelta(ledger, target))),
  ];
  const manifest = ProbeRenderManifestV1.parse({
    schema_version: "1",
    session_id: ledger.session.session_id,
    exported_revision: ledger.session.revision,
    files: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    generator_version: input.generator_version,
    completed_at_ms: input.exported_at_ms,
  });
  return {
    ledger,
    ledger_sha256: ledgerSha256,
    files,
    manifest,
    manifest_content: canonicalProbeJson(manifest),
  };
}

export function verifyProbeRenderArtifacts(
  rawManifest: unknown,
  files: ReadonlyMap<string, string | Uint8Array>,
): { manifest: ProbeRenderManifest; ledger: ProbeLedger } {
  const manifest = ProbeRenderManifestV1.parse(rawManifest);
  for (const expected of manifest.files) {
    const content = files.get(expected.path);
    if (content === undefined) {
      throw new ProbeRenderIntegrityError(
        "missing_file",
        `manifest file is missing: ${expected.path}`,
        expected.path,
      );
    }
    const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
    if (bytes !== expected.bytes) {
      throw new ProbeRenderIntegrityError(
        "bytes_mismatch",
        `manifest byte count differs for ${expected.path}`,
        expected.path,
      );
    }
    if (probeSha256(content) !== expected.sha256) {
      throw new ProbeRenderIntegrityError(
        "sha256_mismatch",
        `manifest digest differs for ${expected.path}`,
        expected.path,
      );
    }
  }
  const ledgerContent = files.get("ledger.json");
  const markdownContent = files.get("ledger.md");
  if (ledgerContent === undefined || markdownContent === undefined) {
    throw new ProbeRenderIntegrityError(
      "missing_file",
      "portable render requires ledger.json and ledger.md",
    );
  }
  const ledgerText =
    typeof ledgerContent === "string"
      ? ledgerContent
      : Buffer.from(ledgerContent).toString("utf8");
  const ledger = ProbeLedgerV1.parse(JSON.parse(ledgerText));
  if (canonicalProbeJson(ledger) !== ledgerText) {
    throw new ProbeRenderIntegrityError(
      "noncanonical_ledger",
      "ledger.json is not canonical probe JSON",
      "ledger.json",
    );
  }
  if (ledger.session.revision !== manifest.exported_revision) {
    throw new ProbeRenderIntegrityError(
      "manifest_revision_mismatch",
      "manifest and ledger revisions differ",
    );
  }
  const markdownText =
    typeof markdownContent === "string"
      ? markdownContent
      : Buffer.from(markdownContent).toString("utf8");
  if (!markdownText.includes(`source_sha256: ${probeSha256(ledgerText)}\n`)) {
    throw new ProbeRenderIntegrityError(
      "markdown_binding_mismatch",
      "ledger.md is not bound to ledger.json",
      "ledger.md",
    );
  }
  return { manifest, ledger };
}
