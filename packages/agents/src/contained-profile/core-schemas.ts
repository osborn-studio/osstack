import { LocalFailureRepositorySchema, VerificationProfileIdSchema } from '@osstack/core';
import { z } from 'zod/v3';

// Core builds these with its own zod 3 copy; the alias only shortens the type.
export const profileIdSchema = VerificationProfileIdSchema as unknown as z.ZodType<string>;
export const repositorySchema = LocalFailureRepositorySchema as unknown as z.ZodType<string>;
