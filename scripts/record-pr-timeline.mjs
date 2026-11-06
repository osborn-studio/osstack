#!/usr/bin/env node
// Records one exact, de-identified PrSnapshot per PR for the bridge replay corpus (appendix §5.4).
//   node scripts/record-pr-timeline.mjs --repo owner/name --pr 340 [--pr 341 …] [--append] [--out dir] [--registry producers.json]
// The query, paging and normalisation are the reader's own code (packages/cli/dist/bridge-reader.js, built from
// src/contained-mission-bridge-reader.ts), so there is a single source of truth. Raw pages stay in memory; only a
// PrSnapshot that passed the allowlist schema is written, after a final scan of the output bytes.
// Read-only: gh with the host's existing authentication, query operations only.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'packages', 'cli', 'dist');
for (const file of ['bridge-reader.js', 'bridge-fixture.js']) {
  if (!existsSync(join(dist, file))) {
    console.error(`Missing ${join(dist, file)}; run pnpm --filter @osstack/cli build first.`);
    process.exit(2);
  }
}
const reader = await import(join(dist, 'bridge-reader.js'));
const fixture = await import(join(dist, 'bridge-fixture.js'));

// ADR-005 §1 (Reviewer role) and the osstack publisher. Logins are used only to scan the output; the registry matches ids.
const ADR_005 = {
  publisher: [{ actor_id: 269190136, app_id: null }],
  reviewers: [160148718, 243772068, 317464155, 2900559, 127640032, 292102352].map((actor_id) => ({ actor_id, app_id: null })),
};
const ADR_005_LOGINS = ['gilosbornhello', 'gilberthello', 'Rubebun-Jadeem', 'Rubebun', 'maomaobdm', 'hyfwin', 'wsorange', 'linxinlan1980', 'linxinlan'];

function parseArgs(argv) {
  const out = { prs: [], append: false, out: join(root, 'packages', 'cli', 'src', '__fixtures__', 'bridge') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--pr') out.prs.push(Number(argv[++i]));
    else if (arg === '--append') out.append = true;
    else if (arg === '--out') out.out = resolve(argv[++i]);
    else if (arg === '--registry') out.registry = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(out.repo)) throw new Error('--repo owner/name is required');
  if (out.prs.length === 0 || out.prs.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error('at least one valid --pr is required');
  return out;
}

async function loadRegistry(path) {
  if (!path) return ADR_005;
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  return { publisher: parsed.publisher, reviewers: parsed.reviewers };
}

const LOGINS_QUERY = `query BridgeRecorderLogins($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    author { login }
    reviews(first: 100) { nodes { author { login } } }
    reviewThreads(first: 100) { nodes { comments(first: 100) { nodes { author { login } } } } }
  } }
}`;

/** Logins seen on the PR, in memory only, so the final scan can look for them. */
async function sourceLogins(transport, ref) {
  const found = new Set(ADR_005_LOGINS);
  try {
    const body = await transport(LOGINS_QUERY, { owner: ref.owner, name: ref.name, number: ref.number });
    const pr = body?.data?.repository?.pullRequest;
    const add = (a) => { if (a?.login) found.add(a.login); };
    add(pr?.author);
    for (const r of pr?.reviews?.nodes ?? []) add(r?.author);
    for (const t of pr?.reviewThreads?.nodes ?? []) for (const c of t?.comments?.nodes ?? []) add(c?.author);
  } catch {
    // The built-in list still applies; a failed lookup must not weaken the schema checks.
  }
  return [...found];
}

const args = parseArgs(process.argv.slice(2));
const [owner, name] = args.repo.split('/');
const registry = await loadRegistry(args.registry);
const transport = reader.ghGraphqlTransport();
await mkdir(args.out, { recursive: true });

let failed = 0;
for (const number of args.prs) {
  const label = `${args.repo}#${number}`;
  try {
    const ref = { owner, name, number };
    const read = await reader.readPullRequest(transport, ref);
    if (!read.complete) throw new Error(`incomplete read: ${read.reason}`);
    const snapshot = reader.normalizeSnapshot(read, registry, Date.now());
    const logins = await sourceLogins(transport, ref);
    const ids = new Set([...registry.publisher, ...registry.reviewers].flatMap((p) => [p.actor_id, p.app_id]));
    for (const r of snapshot.reviews) { ids.add(r.reviewer.actor_id); ids.add(r.reviewer.app_id); }
    ids.delete(null); ids.delete(0);
    const pseudonymised = fixture.pseudonymizeSnapshot(snapshot, registry);
    const path = join(args.out, `${owner}-${name}-${number}.json`);
    let existing;
    if (args.append && existsSync(path)) existing = JSON.parse(await readFile(path, 'utf8'));
    const text = `${JSON.stringify(fixture.fixtureWith(existing, pseudonymised), null, 2)}\n`;
    fixture.scanForLeaks(text, { logins, ids: [...ids] });
    await writeFile(path, text);
    console.log(`${label}: recorded (${snapshot.pr_state}, ${snapshot.reviews.length} reviews, ${read.pr.requests} requests)`);
  } catch (error) {
    failed += 1;
    console.error(`${label}: FAILED ${error instanceof Error ? error.message : 'error'}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
