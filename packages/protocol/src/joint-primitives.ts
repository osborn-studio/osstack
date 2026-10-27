import { z } from 'zod';
export const Ref = z.string().min(1).max(512).refine(v => v.trim() === v && ![...v].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), 'NONCANONICAL_REF');
export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const GitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const UInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Role = z.enum(['builder', 'reviewer', 'verifier']);
export function issue(ctx: z.RefinementCtx, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });
}
export function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }

export function portableGitPath(path: string, allowRoot = false): boolean {
  if (allowRoot && path === '.') return true;
  return !/^[A-Za-z]:/.test(path) && !path.startsWith('/') && !path.includes('\\')
    && ![...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}
