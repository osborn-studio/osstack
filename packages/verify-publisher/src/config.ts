import { z } from "zod";

export const numericId = z.number().int().positive().safe();
export const sha = z.string().regex(/^[a-f0-9]{40}$/u);
export const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u);
export const repository = z.string().max(200).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const binding = z.object({
  repository, repository_id: numericId,
  skill_id: identifier, skill_version: z.string().max(64).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u),
  skill_blob: sha, skill_manifest_digest: digest, profile_id: identifier, profile_digest: digest,
  trusted_source: z.object({ repository, commit_sha: sha, artifact_digest: digest }).strict(),
}).strict();

const allowlist = z.object({
  version: z.literal(1),
  producer: z.object({ app_id: numericId, installation_id: numericId }).strict(),
  allow: z.array(binding).min(1).max(32).refine(entries =>
    new Set(entries.map(e => [e.repository_id, e.skill_id].join(":"))).size === entries.length),
}).strict();

const request = z.object({
  version: z.literal(1), repository_id: numericId, pr: numericId, skill_id: identifier, head_sha: sha, base_sha: sha,
  record: z.custom<Record<string, unknown>>(v => typeof v === "object" && v !== null
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)),
}).strict();

export type PublisherAllowlist = z.infer<typeof allowlist>;
export type PublishRequest = z.infer<typeof request>;

function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } as const : { ok: false } as const;
}
export const parsePublisherAllowlist = (value: unknown) => parse(allowlist, value);
export const parsePublishRequest = (value: unknown) => parse(request, value);
