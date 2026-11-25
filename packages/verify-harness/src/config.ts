import { isAbsolute } from "node:path";
import { z } from "zod";

export const numericId = z.number().int().positive().safe();
export const sha = z.string().regex(/^[a-f0-9]{40}$/u);
export const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u);
export const repository = z.string().max(200).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z.string().refine(value => isAbsolute(value) && !value.includes("\0"));
const argument = z.string().refine(value => Buffer.byteLength(value) <= 4096 && !/\p{Cc}/u.test(value));
const entry = z.object({
  repository, repository_id: numericId, skill_id: identifier, profile_id: identifier, profile_digest: digest,
  trusted_source: z.object({ repository, commit_sha: sha, artifact_digest: digest }).strict(),
  base_image_id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  allowed_argv: z.array(argument).min(2).max(128), failure_code: identifier,
}).strict();
const config = z.object({
  version: z.literal(1),
  docker: z.object({ socket_path: path, daemon_id: z.string().min(1).max(256) }).strict(),
  profiles_root: path,
  entries: z.array(entry).min(1).max(32).refine(entries =>
    new Set(entries.map(item => item.repository_id)).size === entries.length),
}).strict();
export type HarnessConfig = z.infer<typeof config>;
export type HarnessEntry = z.infer<typeof entry>;

export function parseHarnessConfig(value: unknown): { ok: true; value: HarnessConfig } | { ok: false } {
  const parsed = config.safeParse(value);
  return parsed.success && Buffer.byteLength(JSON.stringify(parsed.data)) <= 262144
    ? { ok: true, value: parsed.data } : { ok: false };
}
