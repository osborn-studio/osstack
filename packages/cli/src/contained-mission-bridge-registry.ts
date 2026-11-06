// Producer registry for the bridge shadow reconciler (appendix §5.2). Host-private, numeric ids only.
// Deliberately independent of loadBridgeConfig: it never reads apps.json, rulesets.json or any key.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sameProducer, type ProducerIdentity, type ProducerRegistry } from '@osstack/core';
import { z } from 'zod';

const identitySchema = z.object({ actor_id: z.number().int().positive(), app_id: z.number().int().positive().nullable() }).strict();
const registrySchema = z
  .object({
    version: z.literal(1),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    publisher: z.array(identitySchema).nonempty(),
    reviewers: z.array(identitySchema).nonempty(),
  })
  .strict();

export interface ProducerRegistryConfig extends ProducerRegistry {
  readonly repository: string;
}

const invalid = (reason: string): Error => new Error(`BRIDGE_CONFIG_INVALID:producers.json:${reason}`);

function hasDuplicate(list: readonly ProducerIdentity[]): boolean {
  return list.some((a, i) => list.findIndex((b) => sameProducer(a, b)) !== i);
}

/** Missing file -> undefined (shadow off). Present but invalid -> `BRIDGE_CONFIG_INVALID:producers.json:<path>`. */
export async function loadProducerRegistry(home: string): Promise<ProducerRegistryConfig | undefined> {
  let text: string;
  try {
    text = await readFile(join(home, 'bridge', 'producers.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw invalid(`unreadable:${(error as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw invalid('json');
  }
  const result = registrySchema.safeParse(json);
  if (!result.success) throw invalid(result.error.issues[0]?.path.join('.') || 'root');
  const { repository, publisher, reviewers } = result.data;
  if (hasDuplicate(publisher) || hasDuplicate(reviewers)) throw invalid('duplicate_identity');
  if (publisher.some((p) => reviewers.some((r) => sameProducer(p, r)))) throw invalid('publisher_is_reviewer');
  return { repository, publisher, reviewers };
}
