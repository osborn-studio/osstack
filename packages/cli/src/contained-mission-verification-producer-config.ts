import { constants, lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseVerificationProducerPolicyV1, type VerificationProducerPolicyV1 } from '@osstack/core/verification-intake';
import { z } from 'zod';

export interface VerificationAppIdentity { readonly app_id: number; readonly installation_id: number; readonly verification_private_key_path: string }
export interface VerificationProducerConfig { readonly policy: VerificationProducerPolicyV1; readonly app: VerificationAppIdentity | null }

const id = z.number().int().positive().safe();
const configSchema = z.object({
  version: z.literal(1),
  verification_app: z.object({ app_id: id, installation_id: id, verification_private_key_path: z.string().refine(isAbsolute) }).strict(),
  // Preserve the complete policy for the core parser, including unknown keys.
  policy: z.custom<Record<string, unknown>>(p => p !== null && typeof p === 'object' && !Array.isArray(p) && Object.hasOwn(p, 'schema_version')),
}).strict();
const invalid = (reason: string) => new Error(`VERIFICATION_PRODUCER_CONFIG_INVALID:${reason}`);

export async function loadVerificationProducerConfig(home: string): Promise<VerificationProducerConfig> {
  const path = join(home, 'bridge', 'verification-producers.json');
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw invalid('unreadable');
  });
  if (!stat) return { policy: { schema_version: 1, producers: [] }, app: null };
  const checkFile = (info: NonNullable<typeof stat>) => {
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw invalid('file_mode');
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
  try { json = JSON.parse(bytes.toString('utf8')); } catch { throw invalid('json'); }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) throw invalid('schema');
  const { verification_app: app, policy } = parsed.data;
  const result = parseVerificationProducerPolicyV1(policy);
  if (!result.ok) throw invalid('policy');
  if (result.policy.producers.some(p => p.type !== 'App' || p.carrier !== 'check-run'
    || p.app_id !== app.app_id || p.installation_id !== app.installation_id)) throw invalid('producer_mismatch');
  return { app, policy: result.policy };
}
