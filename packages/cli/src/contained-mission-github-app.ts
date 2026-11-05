import { createSign } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { redactSecrets } from '@osstack/governance';
import { z } from 'zod';

export type AppPermission = 'read' | 'write';
export type AppPermissions = Record<string, AppPermission>;

export const PUBLISHER_PERMISSIONS = { contents: 'write', pull_requests: 'write' } as const satisfies AppPermissions;
export const EVIDENCE_PERMISSIONS = { checks: 'write' } as const satisfies AppPermissions;

const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const appSchema = z
  .object({
    app_id: z.number().int().positive(),
    installation_id: z.number().int().positive(),
    private_key_path: z.string().refine((p) => isAbsolute(p), 'must be absolute'),
  })
  .strict();
const appsSchema = z
  .object({ version: z.literal(1), repository: repoSchema, publisher: appSchema, evidence: appSchema })
  .strict();
const rulesetsSchema = z
  .object({
    version: z.literal(1),
    repository: repoSchema,
    mission_ruleset_ids: z.array(z.number().int().positive()).nonempty(),
  })
  .strict();

export type BridgeApp = z.infer<typeof appSchema>;
export interface BridgeConfig {
  readonly repository: string;
  readonly publisher: BridgeApp;
  readonly evidence: BridgeApp;
  readonly mission_ruleset_ids: readonly number[];
}

export interface TokenScope {
  readonly repository: string;
  readonly permissions: AppPermissions;
}
export interface TokenSourceDeps {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly apiBase?: string;
}
export interface InstallationTokenSource {
  token(): Promise<string>;
}

const invalid = (reason: string): Error => new Error(`BRIDGE_CONFIG_INVALID:${reason}`);

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw invalid(`unreadable:${(error as NodeJS.ErrnoException).code ?? 'error'}`);
  }
}

function parse<T>(schema: z.ZodType<T>, text: string, file: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw invalid(`${file}:json`);
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw invalid(`${file}:${issue?.path.join('.') || 'root'}`);
  }
  return result.data;
}

async function checkKey(role: 'publisher' | 'evidence', path: string): Promise<void> {
  const fail = (): Error => new Error(`BRIDGE_KEY_PERMISSIONS:${role}`);
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch {
    throw fail();
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail();
  if ((stat.mode & 0o077) !== 0) throw fail();
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw fail();
}

export async function loadBridgeConfig(home: string): Promise<BridgeConfig | undefined> {
  const [appsText, rulesetsText] = await Promise.all([
    readOptional(join(home, 'bridge', 'apps.json')),
    readOptional(join(home, 'bridge', 'rulesets.json')),
  ]);
  if (appsText === undefined && rulesetsText === undefined) return undefined;
  if (appsText === undefined || rulesetsText === undefined) throw invalid('incomplete');
  const apps = parse(appsSchema, appsText, 'apps.json');
  const rulesets = parse(rulesetsSchema, rulesetsText, 'rulesets.json');
  if (apps.repository.toLowerCase() !== rulesets.repository.toLowerCase()) throw invalid('repository_mismatch');
  await checkKey('publisher', apps.publisher.private_key_path);
  await checkKey('evidence', apps.evidence.private_key_path);
  return {
    repository: apps.repository,
    publisher: apps.publisher,
    evidence: apps.evidence,
    mission_ruleset_ids: rulesets.mission_ruleset_ids,
  };
}

const responseSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().refine((s) => Number.isFinite(Date.parse(s)), 'iso'),
  permissions: z.record(z.string()).optional(),
  repositories: z.array(z.object({ full_name: z.string() })).optional(),
});

const REFRESH_WINDOW_MS = 5 * 60_000;

function redact(text: string): string {
  return redactSecrets(text)
    .replace(/gh[opsur]_[A-Za-z0-9]+/gu, '[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu, '[REDACTED]')
    .replace(/[A-Za-z0-9+/=_-]{64,}/gu, '[REDACTED]')
    .slice(0, 300);
}

function appJwt(app: BridgeApp, pem: string, nowMs: number): string {
  const sec = Math.floor(nowMs / 1000);
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: sec - 60, exp: sec + 540, iss: String(app.app_id) })}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(pem, 'base64url')}`;
}

export function createInstallationTokenSource(
  app: BridgeApp,
  scope: TokenScope,
  deps: TokenSourceDeps = {},
): InstallationTokenSource {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const apiBase = deps.apiBase ?? 'https://api.github.com';
  const repoName = scope.repository.split('/')[1] ?? '';
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function mint(): Promise<string> {
    let pem: string;
    try {
      pem = await readFile(app.private_key_path, 'utf8');
    } catch {
      throw new Error('BRIDGE_KEY_PERMISSIONS:unreadable');
    }
    let jwt: string;
    try {
      jwt = appJwt(app, pem, now());
    } catch {
      throw new Error('BRIDGE_KEY_INVALID');
    }
    const response = await fetchImpl(`${apiBase}/app/installations/${app.installation_id}/access_tokens`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ repositories: [repoName], permissions: scope.permissions }),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.status < 200 || response.status >= 300) {
      const message =
        json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string'
          ? (json as { message: string }).message
          : text;
      throw new Error(`BRIDGE_TOKEN_REQUEST:${response.status}:${redact(message)}`);
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new Error('BRIDGE_TOKEN_SCOPE:malformed_response');
    const body = parsed.data;
    if (body.repositories !== undefined) {
      const only = body.repositories.length === 1 && body.repositories[0]?.full_name.toLowerCase() === scope.repository.toLowerCase();
      if (!only) throw new Error('BRIDGE_TOKEN_SCOPE:repositories');
    }
    for (const [key, level] of Object.entries(body.permissions ?? {})) {
      // GitHub grants `metadata: read` to every installation token, requested or not.
      const wanted = scope.permissions[key] ?? (key === 'metadata' ? 'read' : undefined);
      if (wanted === undefined || (level === 'write' && wanted !== 'write') || (level !== 'read' && level !== 'write')) {
        throw new Error(`BRIDGE_TOKEN_SCOPE:permission:${key}`);
      }
    }
    cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }

  return {
    async token(): Promise<string> {
      if (cached && cached.expiresAt - now() >= REFRESH_WINDOW_MS) return cached.token;
      if (!inflight) {
        inflight = mint().finally(() => {
          inflight = undefined;
        });
      }
      return await inflight;
    },
  };
}
