#!/usr/bin/env node
// Read-only check that a repository's rulesets match .github/rulesets (bridge plan task 2.2).
//
//   node scripts/rulesets-check.mjs --repo <owner/name> --target sandbox|main-repo-interim [--actors <apps.json>] [--json]
//   node scripts/rulesets-check.mjs --print-body <ruleset> [--actors <apps.json>]
//
// --actors maps App names to numeric App ids, e.g. { "osstack-publisher": 123, "osstack-merger": 456 }.
// --print-body writes the resolved request body for the admin to apply with `gh api`; this script never applies it.
// Exit codes: 0 all match, 1 mismatch or GitHub error, 2 usage or unresolved input.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { APPLY_TARGETS, RULESET_NAMES, RulesetError, applyBody, checkRulesets, loadRulesetFiles, readLiveRulesets, resolveActors } from './lib/rulesets.mjs';

const RULESET_DIR = fileURLToPath(new URL('../.github/rulesets/', import.meta.url));
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseArgs(argv) {
  const opts = { json: false };
  const take = (flag, i) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new RulesetError('USAGE', `${flag} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { opts.json = true; continue; }
    const key = { '--repo': 'repo', '--target': 'target', '--actors': 'actors', '--print-body': 'printBody', '--dir': 'dir' }[arg];
    if (!key) throw new RulesetError('USAGE', `unknown argument ${arg}`);
    if (key in opts) throw new RulesetError('USAGE', `${arg} given twice`);
    opts[key] = take(arg, i); i += 1;
  }
  if (opts.printBody !== undefined) {
    if (!RULESET_NAMES.includes(opts.printBody)) throw new RulesetError('USAGE', `--print-body must be one of ${RULESET_NAMES.join(', ')}`);
    if (opts.repo || opts.target) throw new RulesetError('USAGE', '--print-body takes no --repo or --target');
    return opts;
  }
  if (!opts.repo || !REPO.test(opts.repo)) throw new RulesetError('USAGE', '--repo <owner/name> is required');
  if (!APPLY_TARGETS.includes(opts.target)) throw new RulesetError('USAGE', `--target must be one of ${APPLY_TARGETS.join(', ')}`);
  return opts;
}

/** GET through the gh CLI. The method is fixed: this script must never change GitHub state. */
export async function ghGet(path) {
  const { stdout } = await promisify(execFile)('gh', ['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', path], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function readActors(path) {
  if (!path) return {};
  const actors = JSON.parse(await readFile(path, 'utf8'));
  if (!actors || typeof actors !== 'object' || Array.isArray(actors)) throw new RulesetError('USAGE', '--actors must be a JSON object of App name to App id');
  return actors;
}

export async function main(argv, { get = ghGet, out = process.stdout } = {}) {
  const opts = parseArgs(argv);
  const files = await loadRulesetFiles(opts.dir ?? RULESET_DIR);
  const actors = await readActors(opts.actors);
  if (opts.printBody !== undefined) {
    const doc = files.find(f => f.name === opts.printBody);
    out.write(`${JSON.stringify(applyBody(resolveActors(doc, actors)), null, 2)}\n`);
    return 0;
  }
  // Resolve before touching GitHub so a missing App id is a usage error, not a mismatch.
  for (const f of files) if (f._osstack.apply_to.includes(opts.target)) resolveActors(f, actors);
  const report = checkRulesets(files, await readLiveRulesets(opts.repo, get), opts.target, actors);
  if (opts.json) out.write(`${JSON.stringify({ repo: opts.repo, ...report }, null, 2)}\n`);
  else {
    for (const r of report.results) {
      out.write(`${r.status.padEnd(10)} ${r.name}${r.id ? ` (id ${r.id})` : ''}\n`);
      for (const d of r.diffs) out.write(`  - ${d}\n`);
      for (const n of r.notes) out.write(`  note: ${n}\n`);
    }
    if (report.ok && !report.complete) out.write('INTERIM: only main-quality is checked; the main-update merge allowlist is not decided, so who may merge is not verified\n');
    out.write(report.ok ? `OK: ${opts.repo} matches .github/rulesets for ${opts.target}\n` : `MISMATCH: ${opts.repo} does not match .github/rulesets for ${opts.target}\n`);
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof RulesetError ? error.exitCode : 1;
  });
}
