// Pure parts of the bridge platform probes (plan task 2.5, ADR-006): the sandbox allowlist read from ADR-006,
// GitHub App authentication, a small REST/GraphQL client and outcome classification. The probe sequence itself
// lives in scripts/bridge-probe-github.mjs. Nothing here prints tokens or keys.
import { createSign } from 'node:crypto';

export class ProbeError extends Error {
  constructor(code, detail, exitCode = 2) { super(`${code}: ${detail}`); this.code = code; this.exitCode = exitCode; }
}

/** Logical App names used by ADR-006 decision 3 and by .github/rulesets (`${app:<name>}`). */
export const APP_KEYS = ['osstack-publisher', 'osstack-evidence', 'grok-pr-watcher', 'grok-pr-reviewer', 'osstack-merger', 'osstack-sandbox-test-reviewer'];

/**
 * Reads the sandbox repository and the App registry from ADR-006's text. The ADR is the allowlist: destructive probes
 * may only target the repository it registers, identified by name *and* numeric id (so a rename or a look-alike fails).
 */
export function parseRegistry(adrText) {
  const sandbox = /\*\*Sandbox repository \(plan 2\.3\)\.\*\* `([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)` \(repository id (\d+)\)/.exec(adrText);
  if (!sandbox) throw new ProbeError('REGISTRY_INVALID', 'ADR-006 does not register a sandbox repository');
  const apps = {};
  const row = /^\| (?:[A-E]|test reviewer) `([a-z0-9-]+)` \| `([a-z0-9-]+)` \| (\d+) \| (\d+) \|/gm;
  for (let m = row.exec(adrText); m; m = row.exec(adrText)) apps[m[1]] = { slug: m[2], appId: Number(m[3]), installationId: Number(m[4]) };
  for (const key of APP_KEYS) if (!apps[key]) throw new ProbeError('REGISTRY_INVALID', `ADR-006 registers no App ${key}`);
  return { sandbox: { repo: sandbox[1], id: Number(sandbox[2]) }, apps };
}

/** Refuses any repository except the registered sandbox: the name must match and GitHub must report the registered id. */
export function assertSandbox(repo, registry, liveRepo) {
  if (repo.toLowerCase() !== registry.sandbox.repo.toLowerCase()) throw new ProbeError('NOT_SANDBOX', `${repo} is not the sandbox registered in ADR-006`);
  if (!liveRepo || liveRepo.id !== registry.sandbox.id) throw new ProbeError('NOT_SANDBOX', `${repo} has repository id ${liveRepo?.id}, ADR-006 registers ${registry.sandbox.id}`);
}

export function appJwt(appId, pem, now = Math.floor(Date.now() / 1000)) {
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(pem, 'base64url')}`;
}

/** A client that never throws on HTTP status and never echoes its credential. */
export function githubClient(authorization, { fetchImpl = fetch, base = 'https://api.github.com' } = {}) {
  const request = async (method, path, body) => {
    const response = await fetchImpl(`${base}/${path}`, {
      method,
      headers: { accept: 'application/vnd.github+json', authorization, 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
    return { status: response.status, body: json };
  };
  return {
    request,
    graphql: async (query, variables) => {
      const r = await request('POST', 'graphql', { query, variables });
      const errors = r.body?.errors;
      return { status: errors?.length ? 422 : r.status, body: r.body, errors };
    },
  };
}

/**
 * allowed: GitHub accepted the write. rejected: GitHub refused it (permission, ruleset, or validation).
 * error: anything else (5xx, network, unexpected), which never counts as a refusal.
 */
export function classify(response) {
  const { status } = response;
  if (status >= 200 && status < 300) return 'allowed';
  if ([401, 403, 404, 405, 409, 422].includes(status)) return 'rejected';
  return 'error';
}

/** A short, credential-free reason taken from a GitHub response. */
export function reason(response) {
  const body = response.body ?? {};
  const parts = [body.message, ...(Array.isArray(body.errors) ? body.errors.map(e => (typeof e === 'string' ? e : e.message ?? e.code)) : [])];
  return parts.filter(Boolean).join('; ').replace(/\s+/g, ' ').trim().replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[token]').slice(0, 300);
}

/** One probe record. `pass` compares the observed outcome with the plan's expectation; `record` expectations always pass. */
export function record(id, attempt, expected, response, extra = {}) {
  const outcome = response ? classify(response) : extra.outcome ?? 'error';
  const pass = expected === 'record' ? outcome !== 'error' : outcome === expected;
  return { id, attempt, expected, outcome, status: response?.status ?? null, reason: response ? reason(response) : extra.reason ?? '', pass, ...extra };
}

/**
 * Plan P-1: an App A write that GitHub allows is acceptable only once ADR-006 records that code alone prevents it.
 * Such a result passes with `accepted` naming that record; a refusal passes as usual.
 */
export function codeGuarded(result, note) {
  return result.outcome === 'allowed' ? { ...result, pass: true, accepted: note } : result;
}
