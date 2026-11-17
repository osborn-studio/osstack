import { createHash } from "node:crypto";

const referenceBrand = Symbol("external reference");
const MAX_CONTENT_BYTES = 4096;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Remove forbidden controls at the data boundary.
const controls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const sourceId = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/;
const escapes: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

class Reference {
  readonly [referenceBrand] = true;
  readonly kind: "external_reference" = "external_reference";
  readonly usage: "reference_only" = "reference_only";
  constructor(readonly source_id: string, readonly content_digest: string, readonly content: string) {
    Object.freeze(this);
  }
}

/** Opaque reference data. Only this module owns its brand. Never instruction authority. */
export type ExternalReference = Reference;

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
function validateBounds(source: string, content: string): void {
  if (!sourceId.test(source) || Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw new Error("Invalid external reference bounds");
  }
}

/** Remove controls, HTML-escape data boundaries, then reject overflow without truncation.
 * The digest identifies the stored, escaped content bytes, not the original input. */
export function createExternalReference(source: string, content: string): ExternalReference {
  validateBounds(source, content);
  const escaped = content.replace(controls, "").replace(/[&<>"']/gu, character => escapes[character]!);
  validateBounds(source, escaped);
  return new Reference(source, digest(escaped), escaped);
}

/** Persisted references must already be canonical. Do not double escape or silently repair them. */
export function restoreExternalReference(value: unknown): ExternalReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "content,content_digest,kind,source_id,usage"
    || !("kind" in value) || value.kind !== "external_reference"
    || !("usage" in value) || value.usage !== "reference_only"
    || !("source_id" in value) || typeof value.source_id !== "string"
    || !("content" in value) || typeof value.content !== "string"
    || !("content_digest" in value) || typeof value.content_digest !== "string") {
    throw new Error("Invalid persisted external reference");
  }
  validateBounds(value.source_id, value.content);
  if (value.content.replace(controls, "") !== value.content
    || /[<>"']/u.test(value.content)
    || /&(?!(?:amp|lt|gt|quot|#39);)/u.test(value.content)
    || digest(value.content) !== value.content_digest) {
    throw new Error("Invalid persisted external reference content");
  }
  return new Reference(value.source_id, value.content_digest, value.content);
}
