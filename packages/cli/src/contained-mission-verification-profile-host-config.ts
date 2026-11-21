import { constants, lstat, open } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { z } from 'zod';
import type { InstalledVerificationProfileHost } from './contained-mission-verification-profile.js';

const invalid = (reason: string) => Error(`VERIFICATION_PROFILE_HOST_CONFIG_INVALID:${reason}`);
const config = z.object({
  version: z.literal(1),
  installed_root: z.string().refine(root => isAbsolute(root) && normalize(root) === root
    && !root.endsWith(sep) && !root.includes('\0')),
  allowed_argv: z.array(z.array(z.string().min(1).max(256).regex(/^\P{Cc}*$/u)).min(1).max(32)).min(1).max(16),
}).strict();

export async function loadVerificationProfileHostConfig(home: string): Promise<InstalledVerificationProfileHost | null> {
  if (typeof process.getuid !== 'function') throw invalid('file_mode');
  const ownerUid = process.getuid();
  const path = join(home, 'bridge', 'verification-profile-host.json');
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw invalid('unreadable');
  });
  if (!stat) return null;
  const checkFile = (info: NonNullable<typeof stat>) => {
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== ownerUid || (info.mode & 0o077) !== 0)
      throw invalid('file_mode');
    if (info.size > 65536) throw invalid('too_large');
  };
  checkFile(stat);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => { throw invalid(error.code === 'ELOOP' ? 'file_mode' : 'unreadable'); });
  let bytes: Buffer;
  try {
    checkFile(await file.stat().catch(() => { throw invalid('unreadable'); }));
    bytes = await file.readFile().catch(() => { throw invalid('unreadable'); });
  } finally { await file.close().catch(() => { throw invalid('unreadable'); }); }
  if (bytes.length > 65536) throw invalid('too_large');
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid('json'); }
  const result = config.safeParse(json);
  if (!result.success) throw invalid('schema');
  return { installedRoot: result.data.installed_root, allowedArgv: result.data.allowed_argv, ownerUid };
}
