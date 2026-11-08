import { z } from "zod";

/** Bounded owner/repository identity; dot and underscore prefixes are legitimate name data, never traversal. */
export const LocalFailureRepositorySchema = z.string().min(3).max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine(value => value.split("/").every(component => component !== "." && component !== ".."));
