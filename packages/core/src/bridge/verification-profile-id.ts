import { z } from "zod";

/** Exact installed-profile identity grammar, shared by new V2 grants and local receipts. */
export const VerificationProfileIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
