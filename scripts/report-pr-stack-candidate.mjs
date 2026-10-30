#!/usr/bin/env node
import { constants, realpathSync } from 'node:fs';
import { open, mkdir, realpath, writeFile, readFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scratchRoot } from './lib/scratch.mjs';

const help = `Read one caller-ordered stack of 1–3 PRs. This is not a merge authorization.
Usage: node scripts/report-pr-stack-candidate.mjs --plan PATH --output ABSOLUTE_NEW_ROOT
Plan: schema_version 1, repo, target_base, prs [{pr, expectedHead?, expectedBase?, requiredChecks?}].
The plan must be a regular UTF-8 JSON file (no terminal symlink), at most 64 KiB.
The new output must be under OSSTACK_SCRATCH_ROOT, with an existing parent.
Exit 0: report written, not Ready. Exit 2: preflight refused, no forge calls.
Exit 3: identity/observation unavailable or report write failed; keep partial evidence.
No watcher, retry, candidate execution, database access, retarget, approval or merge.
`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
function parse(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--plan', '--output'].includes(key) || options.has(key) || typeof value !== 'string' || value.startsWith('--')) throw new Error('invalid_arguments');
    options.set(key, value);
  }
  if (options.size !== 2) throw new Error('missing_arguments');
  return { plan: options.get('--plan'), output: options.get('--output') };
}
async function readPlan(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error('invalid_plan_file');
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > 65536) throw new Error('plan_size');
    const bytes = Buffer.from(buffer.subarray(0, length));
    return { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } finally { await handle.close(); }
}
// Forge strings are display data. Do not let them add Markdown structure or links.
const escape = value => [...String(value ?? 'unknown')].map(c => {
  const code = c.codePointAt(0);
  return code < 32 || code === 127 || '&<>"\'`\\[]()#*_|!'.includes(c) ? `&#${code};` : c;
}).join('');
function markdown(report) {
  const lines = [
    '# PR stack observation', '', `Repository: ${escape(report.repo)}. Declared order: ${report.order.join(' → ')}.`,
    `Observed: ${report.started_at} to ${report.finished_at}.`,
    `Result: ${report.status}. Frontier: ${report.frontier_pr ?? 'none'}.`,
    'This is not Ready or merge authorization. Observations are sequential, not atomic.',
    `Target base: ${escape(report.target_base)}. Branch names are not ancestry proof.`, '',
  ];
  for (const row of report.rows) {
    lines.push(`## PR ${row.pr} (${row.role})`,
      `Observation: ${row.observation_status}; candidate summary: ${row.candidate_summary ?? 'unavailable'}; issue: ${row.issue ?? 'none'}.`,
      `Relation: ${row.relation.status}; expected base: ${escape(row.relation.expected_base)}; observed base: ${escape(row.relation.observed_base)}.`,
      `Blockers: ${row.blockers.map(escape).join(', ') || 'none observed'}.`,
      `Waiting: ${row.waiting.map(escape).join(', ') || 'none observed'}.`,
      `Unknowns: ${row.unknowns.map(escape).join(', ') || 'none reported'}.`,
      row.observation_status === 'observed' ? `[Snapshot and original policy limits](prs/${row.pr}/snapshot.json); [query receipts](prs/${row.pr}/queries.json).` : 'No per-PR observation was collected.', '');
  }
  lines.push('## Limits', ...report.limitations.map(line => `- ${escape(line)}`), '');
  return lines.join('\n');
}

/** The optional runner/clock are offline seams, not authenticated forge observations. */
export async function runPrStackCandidateReport(args, dependencies = {}) {
  if (args.length === 1 && args[0] === '--help') return { exitCode: 0, help };
  let plan, library, output;
  try {
    const options = parse(args);
    plan = await readPlan(options.plan);
    library = await import('../packages/github/dist/pr-stack-candidate.js');
    plan.validated = library.validatePrStackCandidateInput(plan.value);
    if (!isAbsolute(options.output)) throw new Error('absolute_output_required');
    const root = await realpath(scratchRoot()), parent = await realpath(dirname(resolve(options.output)));
    output = join(parent, resolve(options.output).split(sep).at(-1));
    if (!within(root, output)) throw new Error('output_outside_scratch');
    await mkdir(output, { mode: 0o700 });
  } catch { return { exitCode: 2, error: 'input_or_output_refused' }; }
  try {
    const result = await library.inspectPrStackCandidate(plan.validated, dependencies.runner, dependencies.clock);
    const files = [];
    const write = async (path, content) => {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      await writeFile(join(output, path), bytes, { flag: 'wx', mode: 0o600 });
      if (!(await readFile(join(output, path))).equals(bytes)) throw new Error('write_verification_failed');
      files.push({ path, bytes: bytes.length, sha256: digest(bytes), mode: (await lstat(join(output, path))).mode & 0o777 });
    };
    await write('plan.json', plan.bytes);
    await write('report.json', `${JSON.stringify(result.report, null, 2)}\n`);
    await write('report.md', markdown(result.report));
    await write('dispatches.json', `${JSON.stringify(result.dispatches, null, 2)}\n`);
    await mkdir(join(output, 'prs'), { mode: 0o700 });
    for (const row of result.observations) {
      if (!row.observation) continue;
      const prefix = `prs/${row.pr}`;
      await mkdir(join(output, prefix), { mode: 0o700 });
      await mkdir(join(output, prefix, 'raw'), { mode: 0o700 });
      await write(`${prefix}/snapshot.json`, `${JSON.stringify(row.observation.snapshot, null, 2)}\n`);
      await write(`${prefix}/queries.json`, `${JSON.stringify(row.observation.queries, null, 2)}\n`);
      for (const raw of row.observation.raw) {
        if (!/^(initial|final|checks-[1-3]|threads-[1-3])$/.test(raw.label)) throw new Error('invalid_raw_label');
        await write(`${prefix}/raw/${raw.label}.stdout`, raw.stdout);
        await write(`${prefix}/raw/${raw.label}.stderr`, raw.stderr);
      }
    }
    const manifest = {
      schema_version: 1, kind: 'pr_stack_candidate', repo: result.report.repo, order: result.report.order,
      execution_path: dependencies.runner ? 'injected_runner' : 'default_delivery_runner', clock_path: dependencies.clock ? 'injected_clock' : 'wall_clock',
      files, merge_authorized: false,
      limitations: 'Hashes bind retained bytes, not forge authenticity. Raw is UTF-8 decoded runner output. No atomic stack transaction or merge authority.',
    };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(output, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
    if (!(await readFile(join(output, 'manifest.json'))).equals(bytes)) throw new Error('manifest_write_failed');
    const unavailable = result.observations.some(row => !row.observation?.snapshot.initial || !row.observation?.snapshot.final || row.issue !== null);
    return { exitCode: unavailable ? 3 : 0, output, status: result.report.status, frontier_pr: result.report.frontier_pr, merge_authorized: false, manifest_sha256: digest(bytes) };
  } catch { return { exitCode: 3, error: 'report_failed', output }; }
}
let direct = false;
try { direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* Imports do not execute the command. */ }
if (direct) {
  const result = await runPrStackCandidateReport(process.argv.slice(2));
  process.stdout.write(result.help ?? `${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
