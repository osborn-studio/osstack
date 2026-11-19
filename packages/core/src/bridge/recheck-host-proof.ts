import { z } from "zod";
import { verificationDigestSchema } from "./verification-result.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const fields = z.object({
  receipt_id: z
    .string()
    .min(1)
    .max(128)
    .refine((id) => !id.includes("\0")),
  receipt_digest: verificationDigestSchema,
  head_sha: sha,
  base_sha: sha,
  profile_digest: verificationDigestSchema,
  trusted_source_digest: verificationDigestSchema,
  outcome: z.enum(["passed", "failed", "blocked", "cancelled"]),
});
const brand = Symbol("host recheck proof");
const issued = new WeakSet<HostRecheckProof>();
export type HostRecheckProof = Readonly<z.infer<typeof fields> & { [brand]: true }>;

export function issueHostRecheckProof(input: z.input<typeof fields>): HostRecheckProof {
  const proof = Object.freeze({ ...fields.parse(input), [brand]: true as const });
  issued.add(proof);
  return proof;
}

export function isHostRecheckProof(input: unknown): input is HostRecheckProof {
  return typeof input === "object" && input !== null && issued.has(input as HostRecheckProof);
}
