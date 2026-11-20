import { createSign } from 'node:crypto';
import { constants, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export interface VerificationInstallationApp { readonly app_id: number; readonly installation_id: number; readonly verification_private_key_path: string }
export type VerificationInstallationAnswer =
  | { readonly status: 'installed'; readonly installation_id: number }
  | { readonly status: 'not_installed' }
  | { readonly status: 'unavailable'; readonly reason: 'key' | 'network' | 'http' | 'response' };

const id = z.number().int().positive().safe();
const appSchema = z.object({ app_id: id, installation_id: id, verification_private_key_path: z.string().refine(isAbsolute) });
const scopeSchema = z.object({ repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u).refine(s => !s.includes('..')), repository_id: id });
const installation = z.object({ id: z.number().int().positive(), app_id: z.number().int().positive(),
  suspended_at: z.string().nullable(), repository_selection: z.string(),
  permissions: z.custom<Record<string, string>>(v => v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v).every(p => typeof p === 'string')),
});

async function jwt(app: VerificationInstallationApp, now: () => number): Promise<string> {
  const path = app.verification_private_key_path;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let pem: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw Error('key');
    pem = await file.readFile('utf8');
  } finally { await file.close(); }
  const sec = Math.floor(now() / 1000);
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: sec - 60, exp: sec + 540, iss: String(app.app_id) })}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(pem, 'base64url')}`;
}

async function readBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error('response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { void reader.cancel().catch(() => {}); throw Error('response'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

export function createVerificationInstallationProof(
  app: VerificationInstallationApp, scope: { readonly repository: string; readonly repository_id: number },
  deps: { readonly fetchImpl?: typeof fetch; readonly now?: () => number } = {},
): (query: { app_id: number; repository_id: number }, options: { signal: AbortSignal }) => Promise<VerificationInstallationAnswer> {
  const identity = appSchema.safeParse(app); const target = scopeSchema.safeParse(scope);
  if (!identity.success || !target.success) throw Error('VERIFICATION_INSTALLATION_PROOF_INVALID');
  return async (query, { signal }) => {
    if (query.app_id !== identity.data.app_id || query.repository_id !== target.data.repository_id) return { status: 'not_installed' };
    if (signal.aborted) return { status: 'unavailable', reason: 'network' };
    let token: string;
    try { token = await jwt(identity.data, deps.now ?? Date.now); } catch { return { status: 'unavailable', reason: 'key' }; }
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    try {
      requestSignal.throwIfAborted();
      const response = await (deps.fetchImpl ?? fetch)(`https://api.github.com/repos/${target.data.repository}/installation`, {
        method: 'GET', redirect: 'error', signal: requestSignal,
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      });
      requestSignal.throwIfAborted();
      if (response.redirected) return { status: 'unavailable', reason: 'http' };
      if (response.status === 404) return { status: 'not_installed' };
      if (response.status !== 200) return { status: 'unavailable', reason: 'http' };
      try {
        const result = installation.parse(await readBody(response));
        requestSignal.throwIfAborted();
        if (result.id !== identity.data.installation_id || result.app_id !== identity.data.app_id || result.suspended_at !== null
          || result.repository_selection !== 'selected' || Object.keys(result.permissions).length !== 2
          || result.permissions.checks !== 'write' || result.permissions.metadata !== 'read') return { status: 'not_installed' };
        return { status: 'installed', installation_id: identity.data.installation_id };
      } catch { return { status: 'unavailable', reason: requestSignal.aborted ? 'network' : 'response' }; }
    } catch { return { status: 'unavailable', reason: 'network' }; }
  };
}
