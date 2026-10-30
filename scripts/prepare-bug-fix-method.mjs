#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const roles = ['builder', 'reviewer', 'verifier'];
const help = 'Usage: node scripts/prepare-bug-fix-method.mjs --input <request.json> --output <new-directory-in-workspace>\nCompiles data only; does not invoke an agent, authorize execution, or modify a board.\n';
function fail(code) { throw Object.assign(new Error(code), { code }); }
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_REQUEST');
}
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function child(root, path) { const r = relative(root, path); return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); }
async function readRequest(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 524288) fail('INPUT_UNAVAILABLE');
    const bytes = Buffer.alloc(524289); let count = 0;
    while (count < bytes.length) { const r = await file.read(bytes, count, bytes.length - count, null); if (!r.bytesRead) break; count += r.bytesRead; }
    const after = await file.stat();
    if (count > 524288 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('INPUT_UNAVAILABLE');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))); }
    catch { fail('INVALID_REQUEST'); }
  } finally { await file.close(); }
}

/** A project-local handoff, not admission. All data is validated before mkdir. */
export async function prepareBugFixMethod(request, outputPath) {
  closed(request, ['schema_version', 'compilation', 'host']);
  if (request.schema_version !== 1) fail('INVALID_REQUEST');
  const host = request.host;
  closed(host, ['workspace_path', 'package_version', 'capabilities', 'max_prompt_bytes', 'max_knowledge_bytes']);
  if (typeof host.workspace_path !== 'string' || !isAbsolute(host.workspace_path) ||
      typeof host.package_version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(host.package_version) ||
      !integer(host.max_prompt_bytes, 1, 1000000) || !integer(host.max_knowledge_bytes, 0, 1000000) ||
      !Array.isArray(host.capabilities) || host.capabilities.length < 3 || host.capabilities.length > 8) fail('INVALID_REQUEST');
  const ids = new Set(); const mapped = new Set();
  for (const row of host.capabilities) {
    closed(row, ['role', 'capability_id']);
    if (!roles.includes(row.role) || typeof row.capability_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(row.capability_id) || ids.has(row.capability_id)) fail('INVALID_CAPABILITY_MAPPING');
    ids.add(row.capability_id); mapped.add(row.role);
  }
  if (mapped.size !== 3) fail('INVALID_CAPABILITY_MAPPING');
  const workspace = await realpath(host.workspace_path);
  if (!(await lstat(workspace)).isDirectory() || typeof outputPath !== 'string' || !isAbsolute(outputPath)) fail('INVALID_OUTPUT');
  const output = resolve(outputPath); const parent = resolve(output, '..');
  if (!child(workspace, output) || await realpath(parent) !== parent) fail('OUTPUT_ESCAPE_OR_SYMLINK');
  let current = parent;
  while (current !== workspace) {
    if (!child(workspace, current) || !(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink()) fail('OUTPUT_ESCAPE_OR_SYMLINK');
    current = resolve(current, '..');
  }
  const { compileBugFix } = await import('../packages/skill-registry/dist/bug-fix-compiler.js');
  const compiled = compileBugFix(request.compilation);
  if (compiled.target_repository !== workspace) fail('REPOSITORY_MISMATCH');
  const prefix = relative(workspace, output).split(sep).join('/');
  const context = { schema_version: 1, mode: 'local', repo_path: workspace, default_tenant: true,
    max_prompt_bytes: host.max_prompt_bytes, max_knowledge_bytes: host.max_knowledge_bytes, packs: [],
    methods: { schema_version: 1, task_id: compiled.proposal.task_id, package_version: host.package_version,
      proposal_digest: compiled.proposal_digest, max_bytes: 65536,
      roles: host.capabilities.map(row => ({ ...row, materials: [{ path: `${prefix}/${row.role}.md`,
        sha256: compiled.materials.find(material => material.role === row.role).sha256 }] })) } };
  const outputs = [['compiled.json', `${JSON.stringify(compiled, null, 2)}\n`], ['context.json', `${JSON.stringify(context, null, 2)}\n`],
    ...compiled.materials.map(row => [`${row.role}.md`, row.text])];
  // Use the host schema; its final prompt budget is enforced again at invocation.
  const { validateMethodContextConfig } = await import('../packages/cli/dist/method-context.js');
  if (typeof validateMethodContextConfig !== 'function') fail('HOST_BUILD_UNAVAILABLE');
  validateMethodContextConfig(context.methods);
  await mkdir(output, { mode: 0o700 });
  for (const [name, bytes] of outputs) await writeFile(join(output, name), bytes, { flag: 'wx', mode: 0o600 });
  return { schema_version: 1, status: 'prepared', executable: false, output, context_path: join(output, 'context.json'),
    proposal_digest: context.methods.proposal_digest, task_id: context.methods.task_id,
    limitations: ['caller_supplied_source_and_check_registry', 'host_policy_still_required', 'not_installed_or_invoked', 'not_admitted_or_qualified'] };
}

export async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(help); return 0; }
  try {
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') fail('INVALID_ARGUMENTS');
    const result = await prepareBugFixMethod(await readRequest(args[1]), args[3]);
    process.stdout.write(`${JSON.stringify(result)}\n`); return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'rejected', code: typeof error?.code === 'string' ? error.code : 'PREPARATION_FAILED', executable: false })}\n`); return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
