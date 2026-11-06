#!/usr/bin/env node
// Records the "sandbox Mission corpus" (bridge shadow reconciler appendix §5.4, second table row): a scripted Mission PR is
// published in the sandbox through the REAL phase 3 publication path (delivery.ts openPullRequestToGitHub + fencedDeliveryRunner +
// appCredentialRunner, App A credentials), App B posts `osstack/verify`, and the test-reviewer App then walks a fixed scenario.
// After EVERY step one exact, de-identified PrSnapshot is appended to the fixture by scripts/record-pr-timeline.mjs.
//
//   node scripts/sandbox-bridge-scenario.mjs [--run <id>] [--apps-dir <dir>] [--preflight]
//
// Scenario: (a) PR opened, no reviews; (b) test reviewer COMMENTED; (c) CHANGES_REQUESTED with a body and one inline comment;
// (d) a second CHANGES_REQUESTED by the same App on the same head; (e) App A fast-forwards the Mission branch (new head);
// (f) the test reviewer APPROVES the new head; (g) the PR is closed (never merged).
//
// SAFETY. The only repository this script can write to is osborn-studio/osstack-bridge-sandbox: the name is a constant, the
// registry (ADR-006) and GitHub must agree on its numeric id before anything is written, and every request goes through
// `request()`, which refuses any path outside that repository. App keys are read only by createInstallationTokenSource (the same
// code the Mission host uses); tokens live in memory, never in argv, files or output. Real actor ids go only to a 0600 registry
// file in the scratch root (removed at the end) and to the private fixture sidecar owned by record-pr-timeline.mjs.
// Each run leaves one closed PR and one Mission branch that the mission-history ruleset forbids deleting; keep reruns minimal.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProbeError, assertSandbox, parseRegistry } from './lib/bridge-probe.mjs';
import { createScratchDir } from './lib/scratch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = 'osborn-studio/osstack-bridge-sandbox';
const SANDBOX_ID = 1446327922;
const REMOTE_URL = `https://github.com/${SANDBOX}.git`;
const MISSION_RULESET_IDS = [26577637, 26577639]; // mission-writers, mission-history (ADR-006)
const OUT_DIR = join(root, 'packages', 'cli', 'src', '__fixtures__', 'bridge', 'sandbox');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = { run: `scenario-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`, appsDir: join(homedir(), '.config', 'osstack-bridge', 'apps'), preflight: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--preflight') opts.preflight = true;
    else if (arg === '--run' || arg === '--apps-dir') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new ProbeError('USAGE', `${arg} needs a value`);
      opts[arg === '--run' ? 'run' : 'appsDir'] = argv[i + 1]; i += 1;
    } else throw new ProbeError('USAGE', `unknown argument ${arg}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(opts.run) || opts.run.includes('..')) throw new ProbeError('USAGE', 'invalid --run id');
  opts.appsDir = resolve(opts.appsDir);
  return opts;
}

/** The single egress point for GitHub REST calls made with App tokens. Never echoes the token or a response body. */
const WRITE_PATH = new RegExp(`^repos/${SANDBOX.replace(/[.]/gu, '\\.')}/(?:pulls(?:/[0-9]+(?:/reviews)?)?|git/(?:blobs|trees|commits|refs/heads/osstack/mission/[A-Za-z0-9._-]+))$`, 'u');
async function request(token, method, path, body) {
  const readable = method === 'GET' && (path.startsWith(`repos/${SANDBOX}/`) || /^users\/[A-Za-z0-9-]+%5Bbot%5D$/u.test(path));
  if (!readable && !(method !== 'GET' && WRITE_PATH.test(path))) throw new ProbeError('OUTSIDE_SANDBOX', `refused ${method} ${path.split('/').slice(0, 3).join('/')}`);
  const response = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'osstack-sandbox-scenario', 'x-github-api-version': '2022-11-28' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) throw new ProbeError('HTTP', `${method} ${path.replace(`repos/${SANDBOX}/`, '')} -> ${response.status}`, 1);
  return text ? JSON.parse(text) : null;
}

/** Reads through the host's own gh credentials (query-only): the repository id and public bot user ids. */
function ghRead(path) {
  if (!(path === `repos/${SANDBOX}` || /^users\/[A-Za-z0-9-]+%5Bbot%5D$/u.test(path))) throw new ProbeError('OUTSIDE_SANDBOX', 'refused read');
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 30_000 }));
}

/** Environment for local git commands: the delivery allowlist without any GitHub token (clone and commit need none). */
let deliveryEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0' });
const HARDENED_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];

function exec(command, args, options) {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args[0] ?? ''} failed (${error.code ?? 'error'}): ${String(stderr).slice(0, 200)}`));
      else resolveRun(stdout);
    });
  });
}

/** The credentialed `git push` inherits HOME (and so ~/.gitconfig) from the delivery environment. A global or system Git trace
 * configuration could write the push token (OSSTACK_BRIDGE_PUSH_TOKEN) to a file, which output redaction cannot stop: refuse to run. */
function assertGitCannotTraceCredentials(cwd) {
  const traced = Object.keys(process.env).filter((k) => /^GIT_TRACE|^GIT_CONFIG_(COUNT|KEY|VALUE|PARAMETERS)/u.test(k));
  let configured = '';
  try { configured = execFileSync('git', ['config', '--get-regexp', '^(trace2?|include|includeif)\\.'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: deliveryEnv(), ...(cwd ? { cwd } : {}) }); } catch { /* exit 1: no match */ }
  if (traced.length > 0 || configured.trim() !== '') throw new ProbeError('GIT_TRACE', 'git tracing/include configuration is present in the environment or git config; remove it before running');
}

async function checkKey(path) {
  const info = await lstat(path).catch(() => undefined);
  if (!info || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new ProbeError('KEY_PERMISSIONS', 'an App key is missing, not a regular file, or accessible by others');
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dist = join(root, 'packages', 'cli', 'dist');
  for (const f of ['bridge-reader.js', 'bridge-fixture.js', 'bridge-kit.js', 'bridge-ports.js', 'bridge-github-app.js']) {
    if (!existsSync(join(dist, f))) throw new ProbeError('NOT_BUILT', `missing ${f}; run pnpm build first`);
  }
  const imp = (p) => import(pathToFileURL(p).href);
  const [reader, kitModule, portsModule, appModule, githubModule] = await Promise.all([
    imp(join(dist, 'bridge-reader.js')), imp(join(dist, 'bridge-kit.js')), imp(join(dist, 'bridge-ports.js')),
    imp(join(dist, 'bridge-github-app.js')), imp(join(root, 'packages', 'github', 'dist', 'index.js')),
  ]);

  deliveryEnv = () => { const e = githubModule.githubDeliveryEnvironment(); delete e.GH_TOKEN; delete e.GITHUB_TOKEN; return e; };
  assertGitCannotTraceCredentials();

  // ---- allowlist: ADR-006 registry and the live repository must both say this is the sandbox.
  const registry = parseRegistry(await readFile(join(root, 'docs', 'decisions', 'ADR-006-bridge-s0-decisions.md'), 'utf8'));
  if (registry.sandbox.repo !== SANDBOX || registry.sandbox.id !== SANDBOX_ID) throw new ProbeError('NOT_SANDBOX', 'ADR-006 does not register the expected sandbox');
  assertSandbox(SANDBOX, registry, ghRead(`repos/${SANDBOX}`));

  const appOf = (slug) => {
    const a = registry.apps[slug];
    return { app_id: a.appId, installation_id: a.installationId, private_key_path: join(opts.appsDir, `${a.slug}.pem`) };
  };
  const publisherApp = appOf('osstack-publisher');
  const evidenceApp = appOf('osstack-evidence');
  const reviewerApp = appOf('osstack-sandbox-test-reviewer');
  for (const a of [publisherApp, evidenceApp, reviewerApp]) await checkKey(a.private_key_path);

  const config = { repository: SANDBOX, publisher: publisherApp, evidence: evidenceApp, mission_ruleset_ids: MISSION_RULESET_IDS };
  const kit = kitModule.createBridgeKit({ config });
  const reviewerToken = appModule.createInstallationTokenSource(reviewerApp, { repository: SANDBOX, permissions: { pull_requests: 'write' } });

  // Public bot user ids: the identity the reader reports for each App's reviews and PRs.
  const botId = (slug) => { const u = ghRead(`users/${encodeURIComponent(`${registry.apps[slug].slug}[bot]`)}`); if (u.type !== 'Bot' || !Number.isInteger(u.id)) throw new ProbeError('BOT_ID', 'unexpected bot user'); return u.id; };
  const producers = {
    publisher: [{ actor_id: botId('osstack-publisher'), app_id: registry.apps['osstack-publisher'].appId }],
    reviewers: [{ actor_id: botId('osstack-sandbox-test-reviewer'), app_id: registry.apps['osstack-sandbox-test-reviewer'].appId }],
  };

  // Credentials resolve (and are scope-checked by the token module) before any write.
  await kit.publisherToken();
  await reviewerToken.token();
  await appModule.createInstallationTokenSource(evidenceApp, { repository: SANDBOX, permissions: appModule.EVIDENCE_PERMISSIONS }).token(); // fail before the first write, not after it
  console.log(`preflight ok: sandbox ${SANDBOX} (id ${SANDBOX_ID}), 3 App tokens minted, run ${opts.run}`);
  if (opts.preflight) return;

  const scratch = await createScratchDir('smoke', `sandbox-scenario-${opts.run}`);
  await chmod(scratch, 0o700);
  const work = join(scratch, 'work');
  const registryFile = join(scratch, 'producers.json');
  await writeFile(registryFile, JSON.stringify(producers), { mode: 0o600 });
  const branch = `osstack/mission/${opts.run}`;
  const [owner, name] = SANDBOX.split('/');
  const transport = reader.ghGraphqlTransport();
  const steps = [];
  let prNumber;
  let closed = false;

  const observe = async () => {
    const read = await reader.readPullRequest(transport, { owner, name, number: prNumber });
    return read.complete ? reader.normalizeSnapshot(read, producers, Date.now()) : undefined;
  };
  /** Waits until GraphQL shows the step's effect (GitHub's read side lags), then records one snapshot through the recorder. */
  const record = async (label, expected) => {
    const deadline = Date.now() + 120_000;
    let snap;
    for (;;) {
      snap = await observe();
      if (snap && expected(snap)) break;
      if (Date.now() > deadline) throw new ProbeError('NOT_OBSERVED', `step ${label}: the expected state never showed in GraphQL`, 1);
      await sleep(3_000);
    }
    const args = [join(root, 'scripts', 'record-pr-timeline.mjs'), '--repo', SANDBOX, '--pr', String(prNumber), '--registry', registryFile, '--out', OUT_DIR];
    if (steps.length > 0) args.push('--append');
    await exec(process.execPath, args, { cwd: root });
    steps.push(label);
    console.log(`recorded (${label}): ${snap.pr_state}, ${snap.reviews.length} reviews`);
    await sleep(2_100); // submitted_at has one-second resolution: keep consecutive reviews strictly ordered
  };
  const lastReview = (s) => s.reviews.at(-1);
  const review = (token, head, event, body, comments) =>
    request(token, 'POST', `repos/${SANDBOX}/pulls/${prNumber}/reviews`, { commit_id: head, event, body, ...(comments ? { comments } : {}) });

  try {
    // ---- the real publication path, App A credentials, Mission ruleset exceptions
    // An empty template directory: no template config or hooks can be installed into the clone (init.templateDir is ignored).
    const emptyTemplate = join(scratch, 'empty-template');
    await mkdir(emptyTemplate, { mode: 0o700 });
    await exec('git', [...HARDENED_GIT, 'clone', '--quiet', '--no-tags', `--template=${emptyTemplate}`, REMOTE_URL, work], { cwd: scratch, env: deliveryEnv() });
    assertGitCannotTraceCredentials(work); // the clone's own config (repository-local and included files) is checked too, before any write
    const git = (...args) => exec('git', [...HARDENED_GIT, ...args], { cwd: work, env: deliveryEnv() });
    await git('checkout', '--quiet', '-b', branch);
    const filePath = `scenario/${opts.run}.md`;
    // The sandbox's own content is not trusted: the directory must not be a symlink, and the file is created exclusively (never follows or overwrites).
    const scenarioDir = join(work, 'scenario');
    const dirInfo = await lstat(scenarioDir).catch(() => undefined);
    if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) throw new ProbeError('UNSAFE_CLONE', 'scenario/ in the clone is not a plain directory');
    await mkdir(scenarioDir, { recursive: true });
    await writeFile(join(work, filePath), `# Sandbox bridge scenario ${opts.run}\n\nThis file exists only to give the scenario PR a diff.\n`, { flag: 'wx' });
    await git('add', '--', filePath);
    await git('-c', 'user.name=osstack-sandbox-scenario', '-c', 'user.email=noreply@users.noreply.github.com', 'commit', '--quiet', '-m', `test: sandbox bridge scenario ${opts.run}`);
    const head1 = (await git('rev-parse', 'HEAD')).trim();

    const fence = (kind) => {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
      const url = execFileSync('git', ['remote', 'get-url', '--push', 'origin'], { cwd: work, encoding: 'utf8' }).trim();
      if (head !== head1 || url !== REMOTE_URL || !['push', 'pr_create'].includes(kind)) throw new ProbeError('FENCE', 'publication fence refused');
    };
    const inner = portsModule.fencedDeliveryRunner(
      kitModule.appCredentialRunner(githubModule.defaultDeliveryCommandRunner, () => kit.publisherToken(), kit.exec),
      fence, { remote: 'origin', repository: SANDBOX, httpsOnly: true });
    const bodyFile = join(scratch, 'pr-body.md');
    await writeFile(bodyFile, `Sandbox bridge scenario ${opts.run}. Scripted by scripts/sandbox-bridge-scenario.mjs; not a real change.\n`, { mode: 0o600 });
    const opened = await githubModule.openPullRequestToGitHub(
      { workspacePath: work, remote: 'origin', base: 'main', branch, title: `Sandbox bridge scenario ${opts.run}`, bodyFile, mergeStrategy: 'squash', ciTimeoutMs: 60_000 },
      { repository: SANDBOX, headCommit: head1, draft: true, missionRulesetIds: MISSION_RULESET_IDS }, inner);
    if (opened.pushedCommit !== head1 || !Number.isSafeInteger(opened.pr.number)) throw new ProbeError('PUBLISH', 'unexpected publication result', 1);
    prNumber = opened.pr.number;
    console.log(`published sandbox PR #${prNumber} on ${branch}`);

    // ---- App B: osstack/verify on the published head (display copy, as in phase 3)
    const verify = await kit.publishVerifyCheck(
      { mission_id: `msn_${createHash('sha256').update(opts.run).digest('hex').slice(0, 16)}`, state: 'pr_opened', candidate_head: head1 },
      { head: head1, repository: SANDBOX, evidence_digest: createHash('sha256').update(`scenario:${opts.run}`).digest('hex'), verify: { argv: ['sandbox-scenario'], exit_code: 0 } });
    console.log(`osstack/verify check run ${verify.created ? 'created' : 'updated'}`);

    // (a)
    await record('a_pr_opened', (s) => s.pr_state === 'OPEN' && s.head === head1 && s.reviews.length === 0);
    // (b)
    let t = await reviewerToken.token();
    await review(t, head1, 'COMMENT', 'Scenario step b: a comment-only review.');
    await record('b_commented', (s) => s.reviews.length === 1 && lastReview(s).state === 'COMMENTED');
    // (c)
    t = await reviewerToken.token();
    await review(t, head1, 'REQUEST_CHANGES', 'Scenario step c: changes are requested.', [{ path: filePath, line: 1, side: 'RIGHT', body: 'Scenario step c: an inline comment on the first line.' }]);
    await record('c_changes_requested', (s) => s.reviews.length === 2 && lastReview(s).state === 'CHANGES_REQUESTED' && lastReview(s).has_feedback && lastReview(s).review_commit === head1);
    // (d)
    t = await reviewerToken.token();
    await review(t, head1, 'REQUEST_CHANGES', 'Scenario step d: the same App requests changes again on the same head.');
    await record('d_changes_requested_again', (s) => s.reviews.length === 3 && lastReview(s).state === 'CHANGES_REQUESTED' && lastReview(s).review_commit === head1 && s.head === head1);
    // (e) App A fast-forwards the Mission branch: a head change with no human involved
    const pt = await kit.publisherToken();
    const base = await request(pt, 'GET', `repos/${SANDBOX}/git/commits/${head1}`);
    const tree = await request(pt, 'POST', `repos/${SANDBOX}/git/trees`, { base_tree: base.tree.sha, tree: [{ path: filePath, mode: '100644', type: 'blob', content: `# Sandbox bridge scenario ${opts.run}\n\nFollow-up commit pushed by the publisher App.\n` }] });
    const next = await request(pt, 'POST', `repos/${SANDBOX}/git/commits`, { message: `test: sandbox bridge scenario ${opts.run} follow-up`, tree: tree.sha, parents: [head1] });
    await request(pt, 'PATCH', `repos/${SANDBOX}/git/refs/heads/${branch}`, { sha: next.sha, force: false });
    const head2 = next.sha;
    await record('e_head_changed', (s) => s.head === head2 && s.pr_state === 'OPEN');
    // (f)
    t = await reviewerToken.token();
    await review(t, head2, 'APPROVE', 'Scenario step f: approved on the new head.');
    await record('f_approved_new_head', (s) => lastReview(s)?.state === 'APPROVED' && lastReview(s).review_commit === head2 && s.reviews.length === 4);
    // (g)
    await request(await kit.publisherToken(), 'PATCH', `repos/${SANDBOX}/pulls/${prNumber}`, { state: 'closed' });
    closed = true;
    await record('g_closed', (s) => s.pr_state === 'CLOSED');
    console.log(`done: PR #${prNumber}, ${steps.length} snapshots -> packages/cli/src/__fixtures__/bridge/sandbox/osborn-studio-osstack-bridge-sandbox-${prNumber}.json`);
  } finally {
    if (prNumber !== undefined && !closed) {
      try { await request(await kit.publisherToken(), 'PATCH', `repos/${SANDBOX}/pulls/${prNumber}`, { state: 'closed' }); console.log(`closed PR #${prNumber} after a failure`); } catch { console.error(`COULD NOT CLOSE PR #${prNumber}; close it by hand`); }
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  // Messages come from this script's own fixed texts or from tools that redact tokens; cap and scrub anyway.
  const text = String(error instanceof Error ? error.message : error).replace(/gh[pousr]_[A-Za-z0-9_]+/gu, '[REDACTED]').replace(/eyJ[A-Za-z0-9_.-]+/gu, '[REDACTED]').slice(0, 400);
  console.error(`FAILED: ${text}`);
  process.exit(error?.exitCode ?? 1);
});
