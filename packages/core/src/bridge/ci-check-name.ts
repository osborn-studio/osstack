import { z } from "zod";

/** Exact CI retry identity: bounded UTF-16 units and UTF-8 bytes, never normalized or truncated. */
export const CiCheckNameSchema = z.string().min(1).max(256).regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u)
  .refine(value => value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 1024);
