#!/usr/bin/env node
// Bridge probe P-13 (phase 5 PR "5-P", docs/design/2026-11-06-bridge-same-pr-revision.md §3): REAL `git push --force-with-lease`
// with App A (osstack-publisher) credentials under the mission-writers (26577637) and mission-history (26577639) rulesets.
// P-2..P-4 (scripts/bridge-probe-github.mjs) used the REST refs API, which is not the transport phase 5 uses.
//
//   node scripts/bridge-probe-p13.mjs [--run <id>] [--apps-dir <dir>] [--preflight]
//
// Cases, on one fresh branch osstack/mission/p13-<run>:
//   0 (setup)   plain push creates the branch at c1 (App A may create Mission branches, P-2).
//   1 lease-ff  `--force-with-lease=<ref>:c1 c2:<ref>`, c2 child of c1, lease correct        -> accepted
//   2 stale     a separate plain push advances the branch to c3; then `--force-with-lease=<ref>:c2 c4:<ref>`
//               (c4 child of c3, so the update is a fast-forward and only the lease is wrong)  -> rejected, "stale info"
//   3 non-ff    `--force-with-lease=<ref>:c3 c5:<ref>`, c5 a sibling of c3, lease correct        -> rejected by mission-history
// After every push the remote ref is read back (REST GET) and must equal the expected sha.
//
// SAFETY. Same model as scripts/sandbox-bridge-scenario.mjs: the only repository this script can write to is
// osborn-studio/osstack-bridge-sandbox, name AND numeric id (1446327922, ADR-006) are asserted before any write; the push goes through
// fencedDeliveryRunner + appCredentialRunner (the Mission host's own credential path), and every `git push` argv is validated against
// one exact shape for this run's branch. App keys are read only by createInstallationTokenSource; tokens stay in memory.
// The script refuses to run when GIT_TRACE*/trace2/include/template configuration could write the push token to a file.
// No PR is opened. The branch cannot be deleted (mission-history forbids it), so each run leaves one branch; keep reruns minimal.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProbeError, assertSandbox, parseRegistry } from './lib/bridge-probe.mjs';
import { createScratchDir } from './lib/scratch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SANDBOX = 'osborn-studio/osstack-bridge-sandbox';
export const SANDBOX_ID = 1446327922;
export const REMOTE_URL = `https://github.com/${SANDBOX}.git`;
export const MISSION_RULESET_IDS = [26577637, 26577639]; // mission-writers, mission-history (ADR-006)
const SHA = /^[0-9a-f]{40}$/u;
// Must make a valid git ref component: no trailing '.', no '.lock' suffix, no '..'.
const RUN_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/u;
export const validRunId = (id) => RUN_ID.test(id) && !id.includes('..') && !id.endsWith('.lock');

export function parseArgs(argv) {
  const opts = { run: `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`, appsDir: join(homedir(), '.config', 'osstack-bridge', 'apps'), preflight: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--preflight') opts.preflight = true;
    else if (arg === '--run' || arg === '--apps-dir') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new ProbeError('USAGE', `${arg} needs a value`);
      opts[arg === '--run' ? 'run' : 'appsDir'] = argv[i + 1]; i += 1;
    } else throw new ProbeError('USAGE', `unknown argument ${arg}`);
  }
  if (!validRunId(opts.run)) throw new ProbeError('USAGE', 'invalid --run id');
  opts.appsDir = resolve(opts.appsDir);
  return opts;
}

export const branchFor = (run) => `osstack/mission/p13-${run}`;

/** Registry (ADR-006 text) and the live repository must both say this is the sandbox, by name and numeric id. */
export function assertSandboxIdentity(registry, live) {
  if (registry?.sandbox?.repo !== SANDBOX || registry?.sandbox?.id !== SANDBOX_ID) throw new ProbeError('NOT_SANDBOX', 'ADR-006 does not register the expected sandbox');
  assertSandbox(SANDBOX, registry, live);
  if (live.full_name !== undefined && String(live.full_name).toLowerCase() !== SANDBOX) throw new ProbeError('NOT_SANDBOX', 'live repository name differs');
}

/** The only push argv shapes this script issues: `push [--force-with-lease=<ref>:<sha>] origin <sha>:<ref>` for the run's own branch. */
export function buildPushArgs(branch, newSha, expectedOld) {
  if (!SHA.test(newSha) || (expectedOld !== undefined && !SHA.test(expectedOld))) throw new ProbeError('PUSH_ARGS', 'refspec needs full shas');
  const ref = `refs/heads/${branch}`;
  return ['push', ...(expectedOld === undefined ? [] : [`--force-with-lease=${ref}:${expectedOld}`]), 'origin', `${newSha}:${ref}`];
}

export function assertPushArgs(args, branch) {
  const ref = `refs/heads/${branch}`;
  if (!branch.startsWith('osstack/mission/p13-') || !validRunId(branch.slice('osstack/mission/p13-'.length))) throw new ProbeError('PUSH_ARGS', 'not a P-13 branch');
  const [push, ...rest] = args;
  const refspec = rest.at(-1) ?? '';
  const lease = rest.length === 3 ? rest[0] : undefined;
  const ok = push === 'push' && (rest.length === 2 || rest.length === 3) && rest.at(-2) === 'origin'
    && new RegExp(`^[0-9a-f]{40}:${ref.replace(/[.]/gu, '\\.')}$`, 'u').test(refspec)
    && (lease === undefined || new RegExp(`^--force-with-lease=${ref.replace(/[.]/gu, '\\.')}:[0-9a-f]{40}$`, 'u').test(lease));
  if (!ok) throw new ProbeError('PUSH_ARGS', 'refused a git push that is not the exact P-13 shape');
}

/** Scrubs anything that could be a credential and keeps only the git status lines worth recording. */
export function sanitizeStderr(text) {
  return String(text)
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/gu, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_.-]+/gu, '[REDACTED]')
    .replace(/https:\/\/[^/\s@]+@/gu, 'https://[REDACTED]@')
    .split('\n').map((l) => l.trim()).filter((l) => /^(?:!|To |error:|remote:|fatal:)/u.test(l)).join('\n').slice(0, 800);
}

/**
 * Classifies a finished `git push`. Order matters: a *server* refusal is "! [remote rejected]" (git's own words); a *client-side*
 * refusal is "! [rejected]". A lease that does not match the advertised ref is the latter, "(stale info)"; a ruleset refusal is the former
 * and carries GH013 / "Repository rule violations" / "protected ref". An unrecognised failure is `other`, never a guess.
 */
export function classifyPush({ exitCode, stderr, branch }) {
  // The run id is operator-chosen and git echoes the branch in its status lines: remove it so a branch named e.g. `force-push` or `GH013` cannot look like diagnostic text.
  const s = branch ? String(stderr).split(branch).join('<branch>') : String(stderr);
  // Exit 0 is acceptance whatever the text says: App A's bypass makes GitHub print "Bypassed rule violations ... Cannot update this protected ref" on a push it ACCEPTED.
  if (exitCode === 0) return 'accepted';
  if (/\[remote rejected\]|GH013|Repository rule violations|protected ref/iu.test(s)) {
    if (/force-push|non[- ]fast[- ]forward/iu.test(s)) return 'server_non_ff_ruleset_rejection'; // mission-history's non_fast_forward rule
    return /GH013|rule violations|protected ref/iu.test(s) ? 'server_other_ruleset_rejection' : 'server_rejection_other';
  }
  if (/\(stale info\)/u.test(s)) return 'client_lease_stale_info';
  if (/\[rejected\]/u.test(s) && /(fetch first|non-fast-forward)/u.test(s)) return 'client_non_fast_forward';
  if (/could not read Username|Authentication failed|403|401/u.test(s)) return 'auth_failure';
  return 'other';
}

/** The plan's expectation for each case. */
export const EXPECTED = { lease_ff: 'accepted', stale_lease: 'client_lease_stale_info', non_ff_with_lease: 'server_non_ff_ruleset_rejection' };

/** Compares an observed case with its expectation, including that the remote ref ended where it should. */
export function judge(id, observed) {
  const expectedClass = EXPECTED[id];
  const refOk = observed.remoteAfter === observed.expectedRemoteAfter;
  return { id, expected: expectedClass, observed: observed.class, remote_ref_as_expected: refOk, pass: observed.class === expectedClass && refOk };
}

/** The only GitHub REST egress: read-only ref lookups inside the sandbox. */
async function readRef(token, branch) {
  const path = `repos/${SANDBOX}/git/ref/heads/${branch}`;
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'osstack-p13', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new ProbeError('HTTP', `GET ref -> ${response.status}`, 1);
  const body = await response.json();
  return typeof body?.object?.sha === 'string' ? body.object.sha : undefined;
}

function ghRead(path) {
  if (path !== `repos/${SANDBOX}`) throw new ProbeError('OUTSIDE_SANDBOX', 'refused read');
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 30_000 }));
}

let deliveryEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0' });
const HARDENED_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];

function exec(command, args, options) {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args[0] ?? ''} failed (${error.code ?? 'error'}): ${sanitizeStderr(stderr).slice(0, 200)}`));
      else resolveRun(stdout);
    });
  });
}

/** Refuses when GIT_TRACE*, GIT_CONFIG_* or trace2/include/template git configuration could write the push token to a file. */
export function traceRisks({ env, configured }) {
  const risks = Object.keys(env).filter((k) => /^GIT_TRACE|^GIT_CONFIG_(COUNT|KEY|VALUE|PARAMETERS|GLOBAL|SYSTEM)|^GIT_(EXEC_PATH|TEMPLATE_DIR)$/u.test(k));
  if (String(configured).trim() !== '') risks.push('git config');
  return risks;
}
function assertGitCannotTraceCredentials(cwd) {
  let configured = '';
  try { configured = execFileSync('git', ['config', '--get-regexp', '^(trace2?|include|includeif|init\\.templatedir)(\\.|$)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: deliveryEnv(), ...(cwd ? { cwd } : {}) }); } catch { /* exit 1: no match */ }
  if (traceRisks({ env: process.env, configured }).length > 0) throw new ProbeError('GIT_TRACE', 'git tracing/include/template configuration is present in the environment or git config; remove it before running');
}

async function checkKey(path) {
  const info = await lstat(path).catch(() => undefined);
  if (!info || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new ProbeError('KEY_PERMISSIONS', 'the App A key is missing, not a regular file, or accessible by others');
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dist = join(root, 'packages', 'cli', 'dist');
  for (const f of ['bridge-kit.js', 'bridge-ports.js', 'bridge-github-app.js']) if (!existsSync(join(dist, f))) throw new ProbeError('NOT_BUILT', `missing ${f}; run pnpm build first`);
  const imp = (p) => import(pathToFileURL(p).href);
  const [kitModule, portsModule, , githubModule] = await Promise.all([
    imp(join(dist, 'bridge-kit.js')), imp(join(dist, 'bridge-ports.js')), imp(join(dist, 'bridge-github-app.js')), imp(join(root, 'packages', 'github', 'dist', 'index.js')),
  ]);
  deliveryEnv = () => { const e = githubModule.githubDeliveryEnvironment(); delete e.GH_TOKEN; delete e.GITHUB_TOKEN; return e; };
  assertGitCannotTraceCredentials();

  const registry = parseRegistry(await readFile(join(root, 'docs', 'decisions', 'ADR-006-bridge-s0-decisions.md'), 'utf8'));
  assertSandboxIdentity(registry, ghRead(`repos/${SANDBOX}`));

  const a = registry.apps['osstack-publisher'];
  const publisherApp = { app_id: a.appId, installation_id: a.installationId, private_key_path: join(opts.appsDir, `${a.slug}.pem`) };
  const evidence = registry.apps['osstack-evidence'];
  const evidenceApp = { app_id: evidence.appId, installation_id: evidence.installationId, private_key_path: join(opts.appsDir, `${evidence.slug}.pem`) };
  await checkKey(publisherApp.private_key_path);
  await checkKey(evidenceApp.private_key_path);
  // createBridgeKit needs the evidence App in its config; only publisherToken() is ever called here.
  const kit = kitModule.createBridgeKit({ config: { repository: SANDBOX, publisher: publisherApp, evidence: evidenceApp, mission_ruleset_ids: MISSION_RULESET_IDS } });
  await kit.publisherToken();
  const branch = branchFor(opts.run);
  console.log(`preflight ok: sandbox ${SANDBOX} (id ${SANDBOX_ID}), App A token minted, branch ${branch}`);
  if (opts.preflight) return;

  const scratch = await createScratchDir('smoke', `bridge-probe-p13-${opts.run}`);
  await chmod(scratch, 0o700);
  const work = join(scratch, 'work');
  const results = [];
  try {
    const emptyTemplate = join(scratch, 'empty-template');
    await mkdir(emptyTemplate, { mode: 0o700 });
    await exec('git', [...HARDENED_GIT, 'clone', '--quiet', '--no-tags', `--template=${emptyTemplate}`, REMOTE_URL, work], { cwd: scratch, env: deliveryEnv() });
    assertGitCannotTraceCredentials(work);
    const git = (...args) => exec('git', [...HARDENED_GIT, ...args], { cwd: work, env: deliveryEnv() });
    const commitOn = async (parent, label) => {
      await git('checkout', '--quiet', '--detach', parent);
      const dirInfo = await lstat(join(work, 'p13')).catch(() => undefined);
      if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) throw new ProbeError('UNSAFE_CLONE', 'p13/ in the clone is not a plain directory');
      await mkdir(join(work, 'p13'), { recursive: true });
      await writeFile(join(work, 'p13', `${opts.run}-${label}.md`), `# P-13 ${opts.run} ${label}\n\nProbe content; no real change.\n`, { flag: 'wx' });
      await git('add', '--', `p13/${opts.run}-${label}.md`);
      await git('-c', 'user.name=osstack-p13-probe', '-c', 'user.email=noreply@users.noreply.github.com', 'commit', '--quiet', '-m', `test: bridge probe P-13 ${opts.run} ${label}`);
      return (await git('rev-parse', 'HEAD')).trim();
    };
    const base = (await git('rev-parse', 'origin/HEAD')).trim();
    const c1 = await commitOn(base, 'c1');

    const fence = (kind) => {
      const url = execFileSync('git', ['remote', 'get-url', '--push', 'origin'], { cwd: work, encoding: 'utf8' }).trim();
      if (url !== REMOTE_URL || kind !== 'push') throw new ProbeError('FENCE', 'publication fence refused');
    };
    const inner = portsModule.fencedDeliveryRunner(
      kitModule.appCredentialRunner(githubModule.defaultDeliveryCommandRunner, () => kit.publisherToken(), kit.exec),
      fence, { remote: 'origin', repository: SANDBOX, httpsOnly: true });
    const push = async (newSha, expectedOld) => {
      const args = buildPushArgs(branch, newSha, expectedOld);
      assertPushArgs(args, branch);
      let done;
      try { done = await inner.run('git', args, { cwd: work, timeoutMs: 120_000 }); } catch (error) { done = { exitCode: 1, stderr: String(error instanceof Error ? error.message : error), stdout: '' }; }
      return { exitCode: done.exitCode, class: classifyPush({ ...done, branch }), stderr: sanitizeStderr(done.stderr) };
    };
    const remote = async () => readRef(await kit.publisherToken(), branch);

    // case 0: setup, plain push creates the branch at c1
    const setup = await push(c1);
    if (setup.class !== 'accepted' || (await remote()) !== c1) throw new ProbeError('SETUP', `creating the P-13 branch failed (${setup.class})`, 1);
    console.log(`setup: branch ${branch} created at ${c1.slice(0, 12)}`);

    // case 1: fast-forward with a correct lease
    const c2 = await commitOn(c1, 'c2');
    const r1 = await push(c2, c1);
    results.push({ ...judge('lease_ff', { class: r1.class, remoteAfter: await remote(), expectedRemoteAfter: c2 }), exit_code: r1.exitCode, stderr: r1.stderr });
    // case 2: someone else advances the branch (separate plain fast-forward push by App A), then the stale lease
    const c3 = await commitOn(c2, 'c3');
    const adv = await push(c3);
    if (adv.class !== 'accepted' || (await remote()) !== c3) { console.log(JSON.stringify({ partial: results, advance: adv })); throw new ProbeError('SETUP', `advancing the branch failed (${adv.class})`, 1); }
    const c4 = await commitOn(c3, 'c4');
    const r2 = await push(c4, c2);
    results.push({ ...judge('stale_lease', { class: r2.class, remoteAfter: await remote(), expectedRemoteAfter: c3 }), exit_code: r2.exitCode, stderr: r2.stderr });
    // case 3: non-fast-forward (sibling of c3) with a correct lease on c3
    const c5 = await commitOn(c2, 'c5');
    const r3 = await push(c5, c3);
    results.push({ ...judge('non_ff_with_lease', { class: r3.class, remoteAfter: await remote(), expectedRemoteAfter: c3 }), exit_code: r3.exitCode, stderr: r3.stderr });

    const pass = results.every((r) => r.pass);
    console.log(JSON.stringify({ probe: 'P-13', run: opts.run, branch, repository: SANDBOX, repository_id: SANDBOX_ID, shas: { c1, c2, c3, c4, c5 }, results, pass }, null, 2));
    if (!pass) process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const text = sanitizeStderr(String(error instanceof Error ? error.message : error)) || String(error instanceof Error ? error.message : error).replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/gu, '[REDACTED]').replace(/eyJ[A-Za-z0-9_.-]+/gu, '[REDACTED]');
    console.error(`FAILED: ${text.slice(0, 400)}`);
    process.exit(error?.exitCode ?? 1);
  });
}
