import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { LocalFailureRepositorySchema, VerificationProfileIdSchema } from '@osstack/core';
import { canonicalJson } from '@osstack/protocol/source';
import { z } from 'zod';

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
// biome-ignore lint/suspicious/noControlCharactersInRegex: argv must not contain control bytes or lone surrogates.
const control = /[\u0000-\u001f\u007f-\u009f]/;
const utf8 = (value: string) => Buffer.from(value).toString('utf8') === value;
const argument = z.string().max(4096).refine(value => !control.test(value) && utf8(value));
const trustedPath = z.string().max(512).regex(/^\/osstack-trusted\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/);
const file = z.object({ path: trustedPath, content: z.string().refine(value => utf8(value) && Buffer.byteLength(value) <= 256 * 1024) }).strict();
// Success is exit 0. Reserved timeout/runtime/signal exits never authorize repair.
const exits = z.array(z.number().int().min(1).max(123)).min(1).max(32).refine(values => new Set(values).size === values.length);
const check = z.object({ check_id: identifier.max(64), category: z.enum(['test', 'build', 'static_analysis']), failure_exit_codes: exits }).strict();
const bounded = (max: number) => z.number().int().positive().max(max);
const profileSchema = z.object({
  version: z.literal(1), profile_id: VerificationProfileIdSchema,
  harness: file, fixtures: z.array(file).max(128),
  argv: z.array(argument).min(2).max(128),
  image: z.string().max(512).regex(/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/),
  checks: z.array(check).min(1).max(64),
  limits: z.object({ timeout_seconds: bounded(3600), memory_mb: bounded(16384), cpus: bounded(16), pids: bounded(512), stdout_bytes: bounded(16 * 1024 * 1024), stderr_bytes: bounded(16 * 1024 * 1024) }).strict(),
  network: z.literal('none'), read_only_rootfs: z.literal(true), no_new_privileges: z.literal(true),
  // Symbolic: only the host image assembler can resolve its generated candidate workspace.
  working_directory: z.literal('candidate'),
}).strict().superRefine((value, ctx) => {
  const executable = value.argv[0]!;
  const paths = [value.harness.path, ...value.fixtures.map(entry => entry.path)];
  if (!/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(executable)
    || !value.argv.includes(value.harness.path) || Buffer.byteLength(canonicalJson(value.argv)) > 32768
    || new Set(paths).size !== paths.length || paths.some(path => paths.some(other => other.startsWith(`${path}/`)))
    || new Set(value.checks.map(entry => entry.check_id)).size !== value.checks.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid verification contract' });
  }
});
const sourceSchema = z.object({ repository: LocalFailureRepositorySchema, commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }).strict();
const bindingSchema = z.object({ profile_id: VerificationProfileIdSchema, profile_digest: digest, trusted_source: sourceSchema.extend({ artifact_digest: digest }).strict() }).strict();
const artifactSchema = z.object({ version: z.literal(1), trusted_source: sourceSchema, profile: profileSchema }).strict();

/** Profile v1 is a self-contained UTF-8 harness/fixture payload, with no host file references. */
export type ContainedVerificationProfile = z.infer<typeof profileSchema>;
export type VerificationProfileBinding = z.infer<typeof bindingSchema>;
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export interface InstalledVerificationProfileHost {
  /** Canonical absolute host-installed directory; never candidate or CI supplied. */
  installedRoot: string;
  ownerUid: number;
  /** Whole argv arrays, chosen by host configuration; no prefix matching or extra arguments. */
  allowedArgv: readonly (readonly string[])[];
}
export interface VerificationProfileLaunch {
  readonly binding: Immutable<VerificationProfileBinding>;
  readonly profile: Immutable<ContainedVerificationProfile>;
}
export interface InstalledVerificationProfile extends VerificationProfileLaunch {
  /** Call inside the launch fence. Does not check grants, owner leases or cancellation. */
  readonly revalidateForLaunch: () => VerificationProfileLaunch;
}
const capabilities = new WeakMap<object, () => VerificationProfileLaunch>();
/** Host preparation accepts only the original capability issued by this loader. */
export function revalidateInstalledVerificationProfile(value: InstalledVerificationProfile): VerificationProfileLaunch {
  const revalidate = capabilities.get(value);
  if (!revalidate) throw Error('VERIFICATION_PROFILE_CAPABILITY_REQUIRED');
  return revalidate();
}
function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw Error(code);
  return result.data;
}
/** SHA-256 of protocol canonicalJson(profile), with no digest fields in that payload.
 * The grant's artifact_digest separately covers the exact complete installed JSON bytes. */
export function verificationProfileDigest(profile: unknown): string {
  return sha(canonicalJson(parse(profileSchema, profile, 'VERIFICATION_PROFILE_PAYLOAD_INVALID')));
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function rootStat(host: InstalledVerificationProfileHost): Stats {
  if (!Number.isSafeInteger(host.ownerUid) || host.ownerUid < 0 || !isAbsolute(host.installedRoot)
    || normalize(host.installedRoot) !== host.installedRoot || realpathSync(host.installedRoot) !== host.installedRoot) throw Error('VERIFICATION_PROFILE_ROOT_INVALID');
  const stat = lstatSync(host.installedRoot);
  if (!stat.isDirectory() || stat.uid !== host.ownerUid || (stat.mode & 0o022) !== 0) throw Error('VERIFICATION_PROFILE_ROOT_INVALID');
  return stat;
}
function validFile(stat: Stats, ownerUid: number): void {
  if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o022) !== 0 || stat.nlink !== 1 || stat.size > MAX_ARTIFACT_BYTES) throw Error('VERIFICATION_PROFILE_FILE_INVALID');
}
function readInstalled(host: InstalledVerificationProfileHost, binding: VerificationProfileBinding) {
  const root = rootStat(host);
  // The only selection is a validated grant pin under a host-configured directory.
  const path = join(host.installedRoot, `${binding.trusted_source.artifact_digest}.json`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd); validFile(before, host.ownerUid);
    // Stat alone cannot bound growth; read at most limit + 1 from this same open handle.
    const buffer = Buffer.alloc(MAX_ARTIFACT_BYTES + 1); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset > MAX_ARTIFACT_BYTES) throw Error('VERIFICATION_PROFILE_FILE_INVALID');
    const after = fstatSync(fd); validFile(after, host.ownerUid);
    const selected = lstatSync(path); validFile(selected, host.ownerUid);
    if (!sameFile(before, selected) || !sameFile(root, rootStat(host)) || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('VERIFICATION_PROFILE_INSTALLATION_CHANGED');
    const bytes = buffer.subarray(0, offset);
    if (sha(bytes) !== binding.trusted_source.artifact_digest) throw Error('VERIFICATION_PROFILE_ARTIFACT_MISMATCH');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw Error('VERIFICATION_PROFILE_PAYLOAD_INVALID');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw Error('VERIFICATION_PROFILE_PAYLOAD_INVALID'); }
    const artifact = parse(artifactSchema, value, 'VERIFICATION_PROFILE_PAYLOAD_INVALID');
    if (artifact.profile.profile_id !== binding.profile_id || sha(canonicalJson(artifact.profile)) !== binding.profile_digest
      || artifact.trusted_source.repository !== binding.trusted_source.repository || artifact.trusted_source.commit !== binding.trusted_source.commit) throw Error('VERIFICATION_PROFILE_IDENTITY_MISMATCH');
    if (!host.allowedArgv.some(argv => canonicalJson(argv) === canonicalJson(artifact.profile.argv))) throw Error('VERIFICATION_PROFILE_ARGV_NOT_ALLOWED');
    return { root, file: after, profile: artifact.profile };
  } finally { closeSync(fd); }
}
/** Offline, default-unwired foundation. No discovery, subprocess, candidate read or execution.
 * The caller supplies a verified grant binding and host-only installation policy. Same-UID
 * write access is NOT immutability. Execute only returned frozen UTF-8 content and argv;
 * never reopen installation paths as harness authority. Future image assembly must install
 * these exact bytes read-only outside candidate authority, resolve the symbolic cwd, enforce
 * every declared limit and independently classify results/stop proof. This module does none
 * of those operations. Path checks are defense in depth, not a portable openat/TOCTOU proof.
 */
export function loadInstalledVerificationProfile(host: InstalledVerificationProfileHost, binding: VerificationProfileBinding): InstalledVerificationProfile {
  const fixedBinding = parse(bindingSchema, binding, 'VERIFICATION_PROFILE_BINDING_INVALID');
  const fixedHost = structuredClone(host);
  const initial = readInstalled(fixedHost, fixedBinding);
  const launch: VerificationProfileLaunch = freeze({ binding: fixedBinding, profile: initial.profile });
  const capability = Object.freeze({ ...launch, revalidateForLaunch: () => {
    const current = readInstalled(fixedHost, fixedBinding);
    if (!sameFile(initial.root, current.root) || !sameFile(initial.file, current.file)) throw Error('VERIFICATION_PROFILE_INSTALLATION_CHANGED');
    return launch;
  } });
  capabilities.set(capability, capability.revalidateForLaunch);
  return capability;
}
