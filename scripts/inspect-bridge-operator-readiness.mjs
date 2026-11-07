#!/usr/bin/env node
// Read-only phase 6 evidence. This does not evaluate or open a production gate.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertSandbox, parseRegistry } from './lib/bridge-probe.mjs';
import { checkRulesets, loadRulesetFiles, readLiveRulesets, RULESET_NAMES } from './lib/rulesets.mjs';

const MAIN = 'osborn-studio/osstack';
const ADR = new URL('../docs/decisions/ADR-006-bridge-s0-decisions.md', import.meta.url);
const RULESETS = fileURLToPath(new URL('../.github/rulesets/', import.meta.url));
const LIMITS = { pages: 3, requestsPerRepository: 50, timeoutMs: 15000, maxBuffer: 4 * 1024 * 1024 };
const id = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const fail = reason => Object.assign(new Error(reason), { reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Only these public metadata endpoints are reachable, including through inherited ruleset summaries.
function assertEndpoint(path) {
  if (typeof path !== 'string' || !/^(?:repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/branches\/main\/protection|\/rulesets(?:\/[1-9][0-9]*|\?per_page=100&page=[1-9][0-9]*&includes_parents=true))?|orgs\/[A-Za-z0-9_-]+\/rulesets\/[1-9][0-9]*|users\/[A-Za-z0-9_-]+(?:%5Bbot%5D)?)$/.test(path)) throw fail('endpoint_rejected');
}

/** gh handles its own authentication. Never request a token, read a key, or echo stderr. */
export async function ghGet(path, { run = promisify(execFile) } = {}) {
  assertEndpoint(path);
  try {
    const { stdout } = await run('gh', ['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', path], {
      shell: false, timeout: LIMITS.timeoutMs, maxBuffer: LIMITS.maxBuffer,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const status = Number(/HTTP (\d{3})/.exec(String(error?.stderr ?? ''))?.[1]);
    throw Object.assign(fail('api_read_failed'), { status: status >= 400 && status <= 599 ? status : null });
  }
}

function unknown(error) {
  return {
    status: 'unknown',
    reason: ['pagination_limit', 'request_limit', 'endpoint_rejected', 'response_invalid', 'identity_mismatch'].includes(error?.reason) ? error.reason : 'api_read_failed',
    httpStatus: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null,
  };
}
async function observe(read) {
  try { return { status: 'observed', ...await read() }; } catch (error) { return unknown(error); }
}

// Report only known check names. Arbitrary remote strings, error bodies and URLs are not evidence output.
function checksSummary(checks, known, producerKey) {
  if (!Array.isArray(checks)) throw fail('response_invalid');
  return {
    requiredChecks: checks.filter(check => known.has(check?.context)).map(check => ({ context: check.context, appId: id(check[producerKey]) })),
    otherRequiredCheckCount: checks.filter(check => !known.has(check?.context)).length,
  };
}
function classicSummary(value, known) {
  if (!object(value) || typeof value.enforce_admins?.enabled !== 'boolean') throw fail('response_invalid');
  const reviews = value.required_pull_request_reviews;
  const checks = value.required_status_checks;
  if (checks != null && (!object(checks) || !Array.isArray(checks.checks))) throw fail('response_invalid');
  return {
    enforceAdmins: value.enforce_admins.enabled,
    requiredApprovals: Number.isInteger(reviews?.required_approving_review_count) ? reviews.required_approving_review_count : null,
    dismissStaleReviews: bool(reviews?.dismiss_stale_reviews),
    requireLastPushApproval: bool(reviews?.require_last_push_approval),
    requiredConversationResolution: bool(value.required_conversation_resolution?.enabled),
    strictChecks: bool(checks?.strict),
    ...checksSummary(checks?.checks ?? [], known, 'app_id'),
  };
}

async function repositoryEvidence(repo, registry, files, actors, known, get) {
  let requests = 0;
  const boundedGet = path => {
    assertEndpoint(path);
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
    if (page > LIMITS.pages) throw fail('pagination_limit');
    if (++requests > LIMITS.requestsPerRepository) throw fail('request_limit');
    return get(path);
  };
  const metadata = await observe(async () => {
    const value = await boundedGet(`repos/${repo}`);
    if (!object(value) || value.full_name !== repo || !id(value.id)) throw fail('response_invalid');
    if (repo === registry.sandbox.repo) {
      try { assertSandbox(repo, registry, value); } catch { throw fail('identity_mismatch'); }
    }
    return { repositoryId: value.id, visibility: ['public', 'private', 'internal'].includes(value.visibility) ? value.visibility : 'unknown' };
  });
  if (metadata.status !== 'observed') return { repo, ...metadata };
  const classicProtection = await observe(async () => classicSummary(await boundedGet(`repos/${repo}/branches/main/protection`), known));
  const rulesets = await observe(async () => {
    const live = await readLiveRulesets(repo, boundedGet);
    if (live.some(rule => !object(rule) || !id(rule.id) || !Array.isArray(rule.rules))) throw fail('response_invalid');
    const comparison = checkRulesets(files, live, repo === registry.sandbox.repo ? 'sandbox' : 'main-repo-interim', actors);
    const binding = live.filter(rule => rule.name === 'main-quality' && rule.target === 'branch' && rule.enforcement === 'active')
      .flatMap(rule => rule.rules).filter(rule => rule.type === 'required_status_checks')
      .flatMap(rule => rule.parameters?.required_status_checks ?? []).filter(check => check.context === 'grok/verify-osstack');
    return {
      // This records configuration only, not effective branch protection or actual check production.
      readComplete: live.every(rule => Array.isArray(rule.bypass_actors)),
      grokCheckBinding: binding.some(check => check.integration_id === registry.apps['grok-pr-watcher'].appId) ? 'configured' : 'not_observed',
      comparison: {
        ok: comparison.ok, complete: comparison.complete, target: comparison.target,
        results: comparison.results.map(result => ({
          name: RULESET_NAMES.includes(result.name) ? result.name : 'unregistered',
          status: result.status, id: id(result.id), differenceCount: result.diffs.length, noteCount: result.notes.length,
        })),
      },
    };
  });
  return { repo, ...metadata, classicProtection, rulesets };
}

/** Inject get(path) for offline tests. All transport calls have GET semantics. */
export async function collectReadiness({ get = ghGet } = {}) {
  const registry = parseRegistry(await readFile(ADR, 'utf8'));
  const files = await loadRulesetFiles(RULESETS);
  const actors = Object.fromEntries(Object.entries(registry.apps).map(([key, app]) => [key, app.appId]));
  const known = new Set(['grok/verify-osstack', ...files.flatMap(file => file.rules).flatMap(rule => rule.parameters?.required_status_checks ?? []).map(check => check.context)]);
  const repositories = [];
  for (const repo of [MAIN, registry.sandbox.repo]) repositories.push(await repositoryEvidence(repo, registry, files, actors, known, get));
  const identities = [];
  for (const [key, app] of Object.entries(registry.apps)) {
    const login = `${app.slug}[bot]`;
    const publicBot = await observe(async () => {
      const path = `users/${encodeURIComponent(login)}`;
      assertEndpoint(path);
      const value = await get(path);
      if (value?.login !== login || value.type !== 'Bot' || !id(value.id)) throw fail('response_invalid');
      return { login, userId: value.id, type: 'Bot' };
    });
    identities.push({ key, registeredAppId: app.appId, registeredSlug: app.slug, publicBot });
  }
  return {
    schemaVersion: 1,
    productionGate: 'closed',
    collectionComplete: repositories.every(repo => repo.status === 'observed' && repo.classicProtection.status === 'observed' && repo.rulesets.status === 'observed' && repo.rulesets.readComplete) && identities.every(identity => identity.publicBot.status === 'observed'),
    limits: LIMITS,
    repositories, identities,
    platformUnknowns: Array.from({ length: 11 }, (_, i) => ({ id: `U-${i + 1}`, status: 'not_verified' })),
    missingEvidence: [
      'App C/D migration, installations, permissions and event delivery',
      'Owner confirmation of App A/C/D bot user IDs; public lookup does not bind a user ID to an App ID',
      'Platform U-1 through U-11 evidence and operator logs',
      'Phase 6 sandbox V-1 through V-31 acceptance records and rollback evidence',
      'Formal CHANGES_REQUESTED capability and its blocking/clearing behavior; PR Reviewer is paused',
      'Independent Watcher/Reviewer execution identities; shared Rubebun-Jadeem use is owner context, not an API finding',
      'Owner decisions, main ruleset application/readback and production acceptance',
    ],
  };
}

export async function main(argv, { get = ghGet, out = process.stdout } = {}) {
  if (argv.length === 1 && argv[0] === '--help') {
    out.write('Usage: node scripts/inspect-bridge-operator-readiness.mjs [--help]\nRead registered GitHub metadata with gh api GET. Emit JSON. Exit 0: collection complete (not readiness); 1: incomplete; 2: usage/local input error.\n');
    return 0;
  }
  if (argv.length) throw fail('usage');
  const report = await collectReadiness({ get });
  out.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.collectionComplete ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    process.stderr.write('Collector failed: invalid usage or local registry/ruleset input. No remote error body is printed.\n');
    process.exitCode = 2;
  });
}
