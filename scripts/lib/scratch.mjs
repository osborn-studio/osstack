// Build-free counterpart of packages/core/src/scratch.ts for standalone scripts.
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function scratchRoot(env = process.env) {
  const override = env.OSSTACK_SCRATCH_ROOT?.trim();
  return override ? resolve(override) : join(tmpdir(), 'osstack');
}

export async function createScratchDir(kind, label, env = process.env) {
  if (!['worktrees', 'runtime', 'tests', 'smoke'].includes(kind)) throw new Error('invalid scratch kind');
  const parent = join(scratchRoot(env), kind);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const sanitized = label.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const prefix = sanitized === '' ? 'scratch' : sanitized.slice(0, 48);
  return mkdtemp(join(parent, `${prefix}-`));
}
