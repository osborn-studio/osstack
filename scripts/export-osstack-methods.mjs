#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportMethods, parseExportOptions } from './lib/osstack-method-export.mjs';

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseExportOptions(args);
    const sourceRoot = fileURLToPath(new URL('../osstack-methods-skill/', import.meta.url));
    const result = await exportMethods({ ...options, sourceRoot });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(JSON.stringify(error.result ?? { status: 'failed', exported: false, installed: false, error: error.message }) + '\n');
    return error.message.startsWith('usage:') ? 2 : 1;
  }
}

// Both argv and import URL must be canonicalized: /Users and /Volumes can alias.
if (process.argv[1] && await realpath(resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
