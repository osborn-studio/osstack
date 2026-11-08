#!/usr/bin/env node
// One closed-PR policy diagnostic. No Codex/Docker, retries, cleanup writes, or 5-G qualification.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratchDir } from './lib/scratch.mjs';

const REPOSITORY = 'osborn-studio/osstack-bridge-sandbox', REPOSITORY_ID = 1446327922;
const API = 'https://api.github.com', ROOT = `/repos/${REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/;
const assertThat = (condition, code) => { if (!condition) throw Error(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseOptions(argv) {
  const opts = { execute: false }, seen = new Set();
  const flags = { '--sandbox-report': 'sandboxReport', '--pull-number': 'pullNumber', '--expected-head': 'expectedHead', '--ancestor': 'ancestor',
    '--runtime-prefix': 'runtimePrefix', '--expected-source-commit': 'expectedSourceCommit', '--apps-config': 'appsConfig' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]; assertThat(!seen.has(flag), 'duplicate_option'); seen.add(flag);
    if (flag === '--execute') opts.execute = true;
    else { assertThat(flags[flag] && argv[i + 1] && !argv[i + 1].startsWith('--'), 'invalid_option'); opts[flags[flag]] = argv[++i]; }
  }
  for (const key of ['sandboxReport', 'runtimePrefix', 'appsConfig']) if (opts[key] !== undefined) assertThat(isAbsolute(opts[key]), 'absolute_path_required');
  for (const key of ['expectedHead', 'ancestor', 'expectedSourceCommit']) if (opts[key] !== undefined) assertThat(SHA.test(opts[key]), 'invalid_sha');
  if (opts.pullNumber !== undefined) { assertThat(/^[1-9][0-9]*$/.test(opts.pullNumber) && Number.isSafeInteger(Number(opts.pullNumber)), 'invalid_pull_number'); opts.pullNumber = Number(opts.pullNumber); }
  if (opts.execute) for (const key of ['sandboxReport', 'pullNumber', 'expectedHead', 'runtimePrefix', 'expectedSourceCommit', 'appsConfig']) assertThat(opts[key] !== undefined, `${key}_required`);
  return opts;
}
async function privateFile(path) {
  const info = await lstat(path);
  assertThat(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600 && info.uid === process.getuid(), 'private_owned_file_required');
}
async function readPrivate(path) {
  await privateFile(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    assertThat(info.isFile() && (info.mode & 0o777) === 0o600 && info.uid === process.getuid(), 'private_owned_file_required');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
export async function probeRulesets(opts, deps = {}) {
  // This return precedes every injected dependency access, file read, runtime import and credential read.
  if (!opts.execute) return { execute: false, diagnostic_only: true, full_5g_qualified: false, repository: REPOSITORY,
    repository_id: REPOSITORY_ID, network_requests: 0, credential_reads: 0, maximum_patch_requests: 1,
    required_execute_flags: ['--sandbox-report', '--pull-number', '--expected-head', '--runtime-prefix', '--expected-source-commit', '--apps-config'],
    ancestor: '--ancestor SHA or original report.base; ancestry is verified before PATCH' };
  // Validate programmatic callers as strictly as CLI callers.
  parseOptions(Object.entries(opts).flatMap(([key, value]) => key === 'execute' ? ['--execute'] : [({ sandboxReport: '--sandbox-report', pullNumber: '--pull-number', expectedHead: '--expected-head', ancestor: '--ancestor', runtimePrefix: '--runtime-prefix', expectedSourceCommit: '--expected-source-commit', appsConfig: '--apps-config' })[key], String(value)]));
  const originalBytes = await readPrivate(opts.sandboxReport);
  const original = JSON.parse(originalBytes);
  assertThat(original.schema_version === 2 && original.repository === REPOSITORY && original.repository_id === REPOSITORY_ID
    && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(original.run) && Array.isArray(original.owned_prs)
    && original.owned_prs.every(number => Number.isSafeInteger(number) && number > 0)
    && new Set(original.owned_prs).size === original.owned_prs.length && original.owned_prs.includes(opts.pullNumber), 'original_report_binding');
  const ancestor = opts.ancestor ?? original.base;
  assertThat(SHA.test(ancestor ?? '') && ancestor !== opts.expectedHead, 'distinct_ancestor_required');
  // The original local report is the trusted ledger. Its canonical run layout anchors
  // consumption independently of the environment selected for new diagnostic output.
  assertThat(typeof original.scratch === 'string' && isAbsolute(original.scratch)
    && original.scratch === await realpath(original.scratch) && basename(dirname(original.scratch)) === 'smoke'
    && basename(original.scratch).startsWith(`bridge-revision-${original.run}-`)
    && /^[a-zA-Z0-9]{6}$/.test(basename(original.scratch).slice(`bridge-revision-${original.run}-`.length))
    && original.home === join(original.scratch, 'home') && original.home === await realpath(original.home)
    && await realpath(opts.sandboxReport) === join(original.scratch, 'report.json'), 'original_report_layout');
  const originalRoot = dirname(dirname(original.scratch)), runtimeRoot = join(originalRoot, 'runtime');
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const runtimeInfo = await lstat(runtimeRoot);
  assertThat(runtimeInfo.isDirectory() && !runtimeInfo.isSymbolicLink() && runtimeRoot === await realpath(runtimeRoot), 'private_guard_directory_required');
  const guardDirectory = join(runtimeRoot, 'bridge-ruleset-probes');
  await mkdir(guardDirectory, { recursive: true, mode: 0o700 });
  const guardInfo = await lstat(guardDirectory);
  assertThat(guardInfo.isDirectory() && !guardInfo.isSymbolicLink() && (guardInfo.mode & 0o777) === 0o700 && guardInfo.uid === process.getuid() && guardDirectory === await realpath(guardDirectory), 'private_guard_directory_required');
  const identity = hash(JSON.stringify([REPOSITORY_ID, original.run, opts.pullNumber, opts.expectedHead]));
  let guard;
  try { guard = await open(join(await realpath(guardDirectory), `${identity}.guard`), 'wx', 0o600); }
  catch { throw Error('diagnostic_already_used_or_guard_unavailable'); }
  await guard.close();
  const directory = await createScratchDir('smoke', 'bridge-ruleset-contract', deps.scratchEnv), resultPath = join(directory, 'result.json');
  const output = await open(resultPath, 'wx', 0o600), secrets = [];
  const clean = (value, limit) => {
    if (typeof value !== 'string') return null;
    let text = value; for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
    return text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]')
      .replace(/\bgh[opsur]_[A-Za-z0-9_]+\b/g, '[REDACTED]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g, '[REDACTED]').slice(0, limit);
  };
  const report = { schema_version: 1, diagnostic_only: true, full_5g_qualified: false, original_report_sha256: hash(originalBytes),
    repository: REPOSITORY, repository_id: REPOSITORY_ID, pull_number: opts.pullNumber, expected_head: opts.expectedHead, proposed_head: ancestor,
    runtime_source_commit: opts.expectedSourceCommit, target_ref: null, before_head: null, after_head: null,
    patch_requests: 0, patch_response: null, ruleset_refused: null, passed: false, failure: null };
  const persist = async () => { await output.truncate(0); await output.write(JSON.stringify(report, null, 2) + '\n', 0, 'utf8'); await output.sync(); await deps.onPersist?.(report); };
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const send = async (url, init) => {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    assertThat(!response.redirected && !(response.status >= 300 && response.status < 400) && (!response.url || response.url === url), 'redirect_or_response_url_refused');
    return response;
  };
  let patchSent = false, readHead, token;
  try {
    await persist();
    const selected = await (deps.loadRuntime ?? (async options => (await import('./lib/bridge-installed-runtime.mjs')).loadBridgeRuntime(options)))({ runtimePrefix: opts.runtimePrefix, expectedSourceCommit: opts.expectedSourceCommit });
    const app = selected.appModule;
    assertThat(selected.provenance?.mode === 'installed' && selected.provenance.sourceCommit === opts.expectedSourceCommit
      && typeof app?.createInstallationTokenSource === 'function' && JSON.stringify(app.PUBLISHER_PERMISSIONS) === JSON.stringify({ contents: 'write', pull_requests: 'write' }), 'selected_runtime_binding');
    const predicate = await (deps.loadPredicate ?? (async () => (await import('./smoke-bridge-revision-sandbox.mjs')).isRulesetRefusal))();
    assertThat(typeof predicate === 'function', 'ruleset_predicate_required');
    const config = JSON.parse(await readPrivate(opts.appsConfig)), publisher = config?.publisher;
    // Other roles in the existing config are not used, copied, imported or passed to the SDK.
    assertThat(config.version === 1 && config.repository === REPOSITORY && publisher
      && Number.isSafeInteger(publisher.app_id) && publisher.app_id > 0 && Number.isSafeInteger(publisher.installation_id) && publisher.installation_id > 0
      && typeof publisher.private_key_path === 'string' && isAbsolute(publisher.private_key_path)
      && Object.keys(publisher).length === 3 && Object.keys(publisher).every(k => ['app_id', 'installation_id', 'private_key_path'].includes(k)), 'publisher_config_binding');
    await privateFile(publisher.private_key_path);
    let mints = 0;
    const mintFetch = async (url, init) => {
      assertThat(String(url) === `${API}/app/installations/${publisher.installation_id}/access_tokens` && init?.method === 'POST' && ++mints === 1, 'mint_scope_refused');
      const scope = JSON.parse(init.body);
      assertThat(JSON.stringify(scope) === JSON.stringify({ repositories: ['osstack-bridge-sandbox'], permissions: app.PUBLISHER_PERMISSIONS }), 'mint_scope_refused');
      const authorization = new Headers(init.headers).get('authorization'); if (authorization?.startsWith('Bearer ')) secrets.push(authorization.slice(7));
      return send(String(url), init);
    };
    token = await app.createInstallationTokenSource(publisher, { repository: REPOSITORY, permissions: app.PUBLISHER_PERMISSIONS }, { fetchImpl: mintFetch }).token();
    assertThat(typeof token === 'string' && token.length > 0 && mints === 1, 'scoped_token_required'); secrets.push(token);
    let branch, patchPath, patchConsumed = false;
    const getPaths = new Set([ROOT, `${ROOT}/pulls/${opts.pullNumber}`, `${ROOT}/compare/${ancestor}...${opts.expectedHead}`]);
    const request = async (method, path, body) => {
      assertThat((method === 'GET' && getPaths.has(path) && body === undefined)
        || (method === 'PATCH' && path === patchPath && patchSent && !patchConsumed && report.patch_requests === 1 && body?.sha === ancestor && body.force === true && Object.keys(body).length === 2), 'request_scope_refused');
      if (method === 'PATCH') patchConsumed = true;
      return send(`${API}${path}`, { method, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28', 'user-agent': 'osstack-ruleset-contract-probe' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    };
    const get = async path => { const response = await request('GET', path); assertThat(response.ok, 'precheck_get_failed'); return response.json(); };
    const repo = await get(ROOT); assertThat(repo.id === REPOSITORY_ID && repo.full_name === REPOSITORY, 'repository_precheck_mismatch');
    const pr = await get(`${ROOT}/pulls/${opts.pullNumber}`);
    branch = pr.head?.ref;
    assertThat(pr.number === opts.pullNumber && pr.state === 'closed' && pr.merged === false && pr.merged_at === null && typeof pr.closed_at === 'string' && pr.closed_at.length > 0
      && pr.head?.repo?.id === REPOSITORY_ID && pr.head.repo.full_name === REPOSITORY && pr.head.sha === opts.expectedHead
      && typeof branch === 'string' && branch.startsWith(`osstack/mission/${original.run}-`) && /^[a-zA-Z0-9/_-]+$/.test(branch)
      && /^[a-z][a-z0-9_-]*$/.test(branch.slice(`osstack/mission/${original.run}-`.length)), 'closed_owned_pr_precheck_mismatch');
    report.target_ref = `refs/heads/${branch}`; patchPath = `${ROOT}/git/refs/heads/${branch}`;
    const refPath = `${ROOT}/git/ref/heads/${branch}`; getPaths.add(refPath);
    readHead = async () => { const ref = await get(refPath); assertThat(ref.ref === report.target_ref && ref.object?.type === 'commit' && SHA.test(ref.object.sha), 'ref_response_binding'); return ref.object.sha; };
    const comparison = await get(`${ROOT}/compare/${ancestor}...${opts.expectedHead}`);
    assertThat(comparison.status === 'ahead' && comparison.base_commit?.sha === ancestor && comparison.merge_base_commit?.sha === ancestor && comparison.total_commits > 0, 'ancestor_precheck_mismatch');
    report.before_head = await readHead(); assertThat(report.before_head === opts.expectedHead, 'ref_head_precheck_mismatch');
    report.patch_requests = 1; await persist(); // Durable intent precedes the only ref write.
    patchSent = true;
    try {
      const response = await request('PATCH', patchPath, { sha: ancestor, force: true });
      report.patch_response = { status: response.status, message: null, request_id: clean(response.headers.get('x-github-request-id'), 300) }; await persist();
      let details; try { details = await response.json(); } catch { report.failure = 'patch_body_unavailable'; }
      report.patch_response.message = clean(details?.message, 4000); await persist(); // Actual HTTP facts precede predicate evaluation.
      report.ruleset_refused = predicate(response.status, details, report.target_ref) === true;
    } catch { report.failure ??= 'patch_transport_or_capture_failed'; }
    finally {
      try { report.after_head = await readHead(); } catch { report.failure ??= 'after_head_observation_failed'; }
      if (report.after_head !== null && report.after_head !== opts.expectedHead) report.failure = 'remote_head_changed_do_not_compensate';
    }
    report.passed = report.failure === null && report.ruleset_refused === true && report.before_head === opts.expectedHead && report.after_head === opts.expectedHead;
  } catch (error) {
    report.failure = /^[a-z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'preparation_or_precheck_failed';
  } finally { await persist(); await output.close(); token = undefined; secrets.length = 0; }
  return { execute: true, passed: report.passed, full_5g_qualified: false, result_path: resultPath, report };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await probeRulesets(parseOptions(process.argv.slice(2))); console.log(JSON.stringify(result, null, 2)); if (result.execute && !result.passed) process.exitCode = 1; }
  catch { console.error('ruleset_diagnostic_refused; no retry or compensation'); process.exitCode = 1; }
}
