#!/usr/bin/env node
// CI-only preparation for node-gyp --nodedir; no runtime or package installation.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OFFICIAL_ORIGIN = 'https://nodejs.org/download/release';
class PermanentError extends Error {}

function downloadAttempt(url, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = parsed.protocol === 'https:' ? httpsRequest : parsed.protocol === 'http:' ? httpRequest : null;
    if (!request) { reject(new PermanentError('unsupported download protocol')); return; }
    let response;
    let settled = false;
    let req;
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Explicitly dispose both socket owners, including body-stall/error paths.
      response?.destroy();
      req?.destroy();
      if (error) reject(error); else resolve(bytes);
    };
    const timer = setTimeout(() => finish(new Error(`download deadline ${timeoutMs}ms`)), timeoutMs);
    req = request(parsed, { agent: false }, (res) => {
      response = res;
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        const message = `HTTP ${status} for ${url}`;
        finish(status !== 429 && status < 500 ? new PermanentError(message) : new Error(message));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { finish(new PermanentError(`download byte limit ${maxBytes} for ${url}`)); return; }
        chunks.push(chunk);
      });
      res.on('end', () => finish(null, Buffer.concat(chunks)));
      res.on('error', (error) => finish(error));
      res.on('aborted', () => finish(new Error('response body aborted')));
    });
    req.on('error', (error) => finish(error));
    req.end();
  });
}

async function download(url, { timeoutMs, attempts, retryDelayMs, maxBytes, log }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    log(`download ${url} attempt ${attempt}/${attempts}`);
    try {
      return { bytes: await downloadAttempt(url, timeoutMs, maxBytes), attempts: attempt };
    } catch (error) {
      log(`download failed: ${error.message}`);
      if (error instanceof PermanentError || attempt === attempts) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

// baseUrl/deadline/limits are test injection only. The CLI exposes no mirror or runtime override.
export async function prepareNodeHeaders({ output, baseUrl = OFFICIAL_ORIGIN, timeoutMs = 60000,
  attempts = 3, retryDelayMs = 1000, maxSumsBytes = 1024 * 1024,
  maxArchiveBytes = 32 * 1024 * 1024, log = (line) => process.stderr.write(`${line}\n`) }) {
  if (!output || !isAbsolute(output)) throw new Error('--output must be an absolute new directory');
  if (!(await lstat(dirname(output))).isDirectory()) throw new Error('output parent must be an existing directory');
  // mkdir without recursive/exist-ok refuses existing files, directories and symlinks.
  await mkdir(output);
  try {
    const version = process.versions.node;
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('only stable runtime versions are supported');
    const name = `node-v${version}`;
    const archiveName = `${name}-headers.tar.gz`;
    const releaseUrl = `${baseUrl}/v${version}`;
    const policy = { timeoutMs, attempts, retryDelayMs, log };
    const sums = await download(`${releaseUrl}/SHASUMS256.txt`, { ...policy, maxBytes: maxSumsBytes });
    await writeFile(join(output, 'SHASUMS256.txt'), sums.bytes, { flag: 'wx' });
    const matches = sums.bytes.toString('utf8').split(/\r?\n/).map((line) => /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line))
      .filter((match) => match?.[2] === archiveName);
    if (matches.length !== 1) throw new Error('official SHASUMS must contain exactly one archive entry');
    const expected = matches[0][1];
    const archive = await download(`${releaseUrl}/${archiveName}`, { ...policy, maxBytes: maxArchiveBytes });
    const actual = createHash('sha256').update(archive.bytes).digest('hex');
    await writeFile(join(output, archiveName), archive.bytes, { flag: 'wx' });
    if (actual !== expected) throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
    // Only official checksum-verified bytes reach tar. Both listing and extraction are bounded.
    const archivePath = join(output, archiveName);
    const tarOptions = { timeout: 30000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' };
    const members = execFileSync('tar', ['-tzf', archivePath], tarOptions).trim().split('\n');
    if (!members.length || members.some((member) => !member.startsWith(`${name}/`) || member.split('/').includes('..'))) {
      throw new Error('archive contains an unexpected path');
    }
    execFileSync('tar', ['-xzf', archivePath, '-C', output], tarOptions);
    const nodedir = join(output, name);
    const headerPath = join(nodedir, 'include', 'node', 'node_version.h');
    const configPath = join(nodedir, 'include', 'node', 'config.gypi');
    if (!(await lstat(headerPath)).isFile() || !(await lstat(configPath)).isFile()) throw new Error('missing regular header/config.gypi');
    const header = await readFile(headerPath, 'utf8');
    const value = (key) => {
      const found = [...header.matchAll(new RegExp(`^#define\\s+${key}\\s+(\\d+)\\s*$`, 'gm'))];
      if (found.length !== 1) throw new Error(`ambiguous or absent ${key}`);
      return found[0][1];
    };
    const headerVersion = ['NODE_MAJOR_VERSION', 'NODE_MINOR_VERSION', 'NODE_PATCH_VERSION'].map(value).join('.');
    if (headerVersion !== version || value('NODE_MODULE_VERSION') !== process.versions.modules) {
      throw new Error('runtime version/ABI mismatch in downloaded headers');
    }
    const receipt = { status: 'verified', runtime_version: version, runtime_abi: process.versions.modules,
      runtime_arch: process.arch, runtime_platform: process.platform, nodedir, sha256: actual,
      sums_url: `${releaseUrl}/SHASUMS256.txt`, archive_url: `${releaseUrl}/${archiveName}`,
      attempts: { sums: sums.attempts, archive: archive.attempts }, policy: { attempts, timeout_ms: timeoutMs, max_archive_bytes: maxArchiveBytes } };
    await writeFile(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    return receipt;
  } catch (error) {
    // Retain only our newly-owned directory for diagnosis; never fall back to unverified headers.
    log(`preparation failed; retained ${output}: ${error.message}`);
    throw error;
  }
}

const invoked = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (invoked === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') {
    process.stderr.write('Usage: node scripts/prepare-node-headers.mjs --output ABSOLUTE_NEW_DIRECTORY\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(`${JSON.stringify(await prepareNodeHeaders({ output: args[1] }))}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
