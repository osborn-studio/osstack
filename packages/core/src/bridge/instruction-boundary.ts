import { createHash } from "node:crypto";

const issued = new WeakSet<InstructionConfig>();
class InstructionConfig {
  #text: string;
  private constructor(text: string) { this.#text = text; Object.freeze(this); }
  static load(entries: readonly { id: string; text: string }[]): InstructionConfig {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 64) throw new Error("INSTRUCTION_CONFIG_INVALID");
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(entry.id) || ids.has(entry.id)
        || typeof entry.text !== "string" || Buffer.byteLength(entry.text, "utf8") > 16384 || entry.text.includes("\0")) {
        throw new Error("INSTRUCTION_CONFIG_INVALID");
      }
      ids.add(entry.id);
    }
    return new InstructionConfig(entries.map(entry => `${entry.id}\n${entry.text}`).join("\n\n"));
  }
  text(): string { return this.#text; }
}
/** Host configuration issued by the loader. Structural copies lack the private brand. */
export type ProtectedInstructionConfig = InstructionConfig;
/** Load only instruction text shipped with the host or its protected configuration. */
export function loadProtectedInstructionConfig(entries: readonly { id: string; text: string }[]): ProtectedInstructionConfig {
  const config = InstructionConfig.load(entries);
  issued.add(config);
  return config;
}
export function buildInstructionSegment(config: ProtectedInstructionConfig): { readonly kind: "instruction_segment"; readonly text: string; readonly sha256: string } {
  if (!issued.has(config)) throw new Error("INSTRUCTION_CONFIG_REQUIRED");
  const text = config.text();
  return Object.freeze({ kind: "instruction_segment", text, sha256: createHash("sha256").update(text).digest("hex") });
}
