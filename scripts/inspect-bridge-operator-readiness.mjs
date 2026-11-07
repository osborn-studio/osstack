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
let registryRead;
const readRegistry = () => registryRead ??= readFile(ADR, 'utf8').then(parseRegistry);
const id = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const fail = reason => Object.assign(new Error(reason), { reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Only these public metadata endpoints are reachable, including through inherited ruleset summaries.
function assertEndpoint(path, registry, repo) {
  if (typeof path !== 'string' || !/^(?:repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/branches\/main(?:\/protection)?|\/rulesets(?:\/[1-9][0-9]*|\?per_page=100&page=[1-9][0-9]*&includes_parents=true))?|orgs\/[A-Za-z0-9_-]+\/rulesets\/[1-9][0-9]*|users\/[A-Za-z0-9_-]+(?:%5Bbot%5D)?)$/.test(path)) throw fail('endpoint_rejected');
  const repository = /^repos\/([^/]+\/[^/?]+)/.exec(path)?.[1];
  const organization = /^orgs\/([^/]+)/.exec(path)?.[1];
  const user = /^users\/(.+)$/.exec(path)?.[1];
  const repos = repo ? [repo] : [MAIN, registry.sandbox.repo];
  if (repository && !repos.includes(repository)) throw fail('endpoint_rejected');
  if (organization && !repos.some(name => name.split('/')[0] === organization)) throw fail('endpoint_rejected');
  if (user && !Object.values(registry.apps).some(app => user === encodeURIComponent(`${app.slug}[bot]`))) throw fail('endpoint_rejected');
}

/** gh handles its own authentication. Never request a token, read a key, or echo stderr. */
export async function ghGet(path, { run = promisify(execFile) } = {}) {
  assertEndpoint(path, await readRegistry());
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
    reason: ['pagination_limit', 'request_limit', 'endpoint_rejected', 'response_invalid', 'identity_mismatch', 'identity_conflict'].includes(error?.reason) ? error.reason : 'api_read_failed',
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

// Validate evidence before passing it to the shared comparison utility. Do not infer missing fields.
function validateLiveRuleset(value) {
  const invalid = () => { throw fail('response_invalid'); };
  if (!object(value) || !id(value.id) || typeof value.name !== 'string'
    || !['branch', 'tag', 'push'].includes(value.target) || !['active', 'disabled', 'evaluate'].includes(value.enforcement)
    || !Array.isArray(value.rules) || !object(value.conditions?.ref_name)) invalid();
  const refs = value.conditions.ref_name;
  if (![refs.include, refs.exclude].every(list => Array.isArray(list) && list.every(ref => typeof ref === 'string'))) invalid();
  const types = new Set();
  for (const rule of value.rules) {
    if (!object(rule) || typeof rule.type !== 'string' || types.has(rule.type)) invalid();
    types.add(rule.type);
    if (rule.parameters != null && !object(rule.parameters)) invalid();
    if (rule.type === 'required_status_checks') {
      const checks = rule.parameters?.required_status_checks;
      if (!Array.isArray(checks) || checks.some(check => !object(check) || typeof check.context !== 'string'
        || (check.integration_id != null && !id(check.integration_id)))) invalid();
    }
  }
  if (value.bypass_actors != null && (!Array.isArray(value.bypass_actors) || value.bypass_actors.some(actor => !object(actor)
    || !id(actor.actor_id) || typeof actor.actor_type !== 'string' || !['always', 'pull_request', 'exempt'].includes(actor.bypass_mode)))) invalid();
}

// Only exact refs and GitHub's two special branch tokens are resolved here. Glob/extra conditions stay unknown.
function appliesToMain(rule, defaultBranchIsMain) {
  if (Object.keys(rule.conditions).some(key => key !== 'ref_name')) return null;
  const match = ref => ref === '~ALL' || ref === 'refs/heads/main' ? true
    : ref === '~DEFAULT_BRANCH' ? defaultBranchIsMain
    : /^refs\/heads\/[A-Za-z0-9_./-]+$/.test(ref) ? false : null;
  const include = rule.conditions.ref_name.include.map(match);
  const exclude = rule.conditions.ref_name.exclude.map(match);
  if (exclude.includes(true) || (include.every(value => value === false))) return false;
  if (include.includes(null) || exclude.includes(null)) return null;
  return include.includes(true);
}
function mainCheckBinding(live, defaultBranchIsMain, branchStatus, appId) {
  if (branchStatus !== 'observed') return 'unknown';
  const candidates = live.filter(rule => rule.name === 'main-quality' && rule.target === 'branch' && rule.enforcement === 'active');
  if (candidates.some(rule => appliesToMain(rule, defaultBranchIsMain) === null)) return 'unknown';
  const binding = candidates.filter(rule => appliesToMain(rule, defaultBranchIsMain))
    .flatMap(rule => rule.rules).filter(rule => rule.type === 'required_status_checks')
    .flatMap(rule => rule.parameters.required_status_checks).filter(check => check.context === 'grok/verify-osstack');
  if (binding.length > 1) return 'conflicting';
  return binding.length === 1 && binding[0].integration_id === appId ? 'configured' : 'not_observed';
}

async function repositoryEvidence(repo, registry, files, actors, known, get) {
  let requests = 0;
  const seenRulesets = new Set();
  const boundedGet = async path => {
    assertEndpoint(path, registry, repo);
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
    if (page > LIMITS.pages) throw fail('pagination_limit');
    if (++requests > LIMITS.requestsPerRepository) throw fail('request_limit');
    const value = await get(path);
    if (path.includes('/rulesets?')) {
      if (!Array.isArray(value) || value.length > 100) throw fail('response_invalid');
      for (const summary of value) {
        if (!object(summary) || !id(summary.id) || seenRulesets.has(summary.id)) throw fail('response_invalid');
        if (summary.source_type === 'Repository' && summary.source !== repo) throw fail('response_invalid');
        if (summary.source_type != null && !['Repository', 'Organization'].includes(summary.source_type)) throw fail('response_invalid');
        seenRulesets.add(summary.id);
      }
    } else if (path.includes('/rulesets/')) {
      if (!object(value) || value.id !== Number(path.split('/').at(-1))) throw fail('response_invalid');
      const inherited = path.startsWith('orgs/');
      const expectedSource = inherited ? path.split('/')[1] : repo;
      if (value.source != null && value.source !== expectedSource) throw fail('response_invalid');
      if (value.source_type != null && value.source_type !== (inherited ? 'Organization' : 'Repository')) throw fail('response_invalid');
    }
    return value;
  };
  const metadata = await observe(async () => {
    const value = await boundedGet(`repos/${repo}`);
    if (!object(value) || value.full_name !== repo || !id(value.id)) throw fail('response_invalid');
    if (repo === registry.sandbox.repo) {
      try { assertSandbox(repo, registry, value); } catch { throw fail('identity_mismatch'); }
    }
    return { repositoryId: value.id, defaultBranchIsMain: typeof value.default_branch === 'string' ? value.default_branch === 'main' : null, visibility: ['public', 'private', 'internal'].includes(value.visibility) ? value.visibility : 'unknown' };
  });
  if (metadata.status !== 'observed') return { repo, ...metadata };
  const mainBranch = await observe(async () => {
    const value = await boundedGet(`repos/${repo}/branches/main`);
    if (!object(value) || value.name !== 'main') throw fail('response_invalid');
    return { name: 'main' };
  });
  const classicProtection = mainBranch.status === 'observed'
    ? await observe(async () => classicSummary(await boundedGet(`repos/${repo}/branches/main/protection`), known))
    : { status: 'unknown', reason: 'main_branch_unverified', httpStatus: mainBranch.httpStatus };
  const rulesets = await observe(async () => {
    const live = await readLiveRulesets(repo, boundedGet);
    for (const rule of live) validateLiveRuleset(rule);
    const comparison = checkRulesets(files, live, repo === registry.sandbox.repo ? 'sandbox' : 'main-repo-interim', actors);
    return {
      // This records configuration only, not effective branch protection or actual check production.
      readComplete: live.every(rule => Array.isArray(rule.bypass_actors)),
      grokCheckBinding: mainCheckBinding(live, metadata.defaultBranchIsMain, mainBranch.status, registry.apps['grok-pr-watcher'].appId),
      comparison: {
        ok: comparison.ok, complete: comparison.complete, target: comparison.target,
        results: comparison.results.map(result => ({
          name: RULESET_NAMES.includes(result.name) ? result.name : 'unregistered',
          status: result.status, id: id(result.id), differenceCount: result.diffs.length, noteCount: result.notes.length,
        })),
      },
    };
  });
  return { repo, ...metadata, mainBranch, classicProtection, rulesets };
}

/** Inject get(path) for offline tests. All transport calls have GET semantics. */
export async function collectReadiness({ get = ghGet } = {}) {
  const registry = await readRegistry();
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
      assertEndpoint(path, registry);
      const value = await get(path);
      if (value?.login !== login || value.type !== 'Bot' || !id(value.id)) throw fail('response_invalid');
      return { login, userId: value.id, type: 'Bot' };
    });
    identities.push({ key, registeredAppId: app.appId, registeredSlug: app.slug, publicBot });
  }
  const users = identities.filter(identity => identity.publicBot.status === 'observed').map(identity => identity.publicBot.userId);
  for (const identity of identities) {
    if (identity.publicBot.status === 'observed' && users.filter(userId => userId === identity.publicBot.userId).length > 1) {
      identity.publicBot = unknown(fail('identity_conflict'));
    }
  }
  return {
    schemaVersion: 1,
    readiness: 'not_assessed',
    evidenceScope: 'github_metadata_only',
    productionGate: 'closed',
    collectionComplete: repositories.every(repo => repo.status === 'observed' && repo.mainBranch.status === 'observed' && repo.classicProtection.status === 'observed' && repo.rulesets.status === 'observed' && repo.rulesets.readComplete) && identities.every(identity => identity.publicBot.status === 'observed'),
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
