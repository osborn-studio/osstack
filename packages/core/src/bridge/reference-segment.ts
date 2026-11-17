import { createHash } from "node:crypto";
import { createExternalReference, restoreExternalReference, type ExternalReference } from "./external-reference.js";

const referencePrototype: object = Object.getPrototypeOf(createExternalReference("boundary", ""));
/** Escaped reference data stays inside fixed marker lines. It never supplies instructions. */
export function serializeReferenceSegment(references: readonly ExternalReference[]): { readonly kind: "reference_segment"; readonly text: string; readonly sha256: string } {
  if (!Array.isArray(references)) throw new Error("REFERENCE_REQUIRED");
  if (references.length > 32) throw new Error("REFERENCE_SEGMENT_LIMIT");
  const parts = references.map(value => {
    try {
      if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== referencePrototype || !Object.isFrozen(value)) throw new Error("REFERENCE_REQUIRED");
      const ref = restoreExternalReference(JSON.parse(JSON.stringify(value)));
      return `<BEGIN_REFERENCE>\nsource_id: ${ref.source_id}\ncontent_digest: ${ref.content_digest}\n${ref.content}\n<END_REFERENCE>`;
    } catch { throw new Error("REFERENCE_REQUIRED"); }
  });
  const text = parts.join("\n");
  if (Buffer.byteLength(text, "utf8") > 65536) throw new Error("REFERENCE_SEGMENT_LIMIT");
  return Object.freeze({ kind: "reference_segment", text, sha256: createHash("sha256").update(text).digest("hex") });
}
