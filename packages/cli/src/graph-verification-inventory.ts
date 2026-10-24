import { closeSync, constants, fstatSync, openSync, opendirSync, readSync, type Stats } from 'node:fs';

// Host-side admission limits, not promises of constant latency. Each raw tree
// pass has its own bound; a review compares both tracked and complete inventory.
export const verificationInventoryLimits = Object.freeze({
  candidateBytes: 128 * 1024 * 1024, candidateEntries: 10_000,
  repositoryBytes: 256 * 1024 * 1024, repositoryEntries: 20_000,
});
export class VerificationInventoryBudget {
  private bytes = 0;
  private entries = 0;
  constructor(private readonly maxBytes: number = verificationInventoryLimits.candidateBytes,
    private readonly maxEntries: number = verificationInventoryLimits.candidateEntries) {}
  entry(bytes = 0): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || ++this.entries > this.maxEntries
      || (this.bytes += bytes) > this.maxBytes) throw Error('verification inventory budget exceeded');
  }
}
/** Cap allocation and reads on the opened inode, not a potentially stale pathname
 * stat. Growth after stat is rejected after at most one extra byte is read. */
export function readVerificationFile(path: string, expected: Stats, budget: VerificationInventoryBudget): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== expected.dev || actual.ino !== expected.ino
      || actual.size !== expected.size || actual.mode !== expected.mode) throw Error('candidate file changed during observation');
    budget.entry(actual.size);
    const bytes = Buffer.allocUnsafe(actual.size); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error('candidate file changed during observation'); offset += count;
    }
    if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, offset) !== 0) throw Error('candidate file grew during observation');
    return bytes;
  } finally { closeSync(fd); }
}

/** Avoid allocating an unbounded directory listing before applying entry limits. */
export function readVerificationDirectory(path: string, maxEntries: number = verificationInventoryLimits.candidateEntries): string[] {
  const directory = opendirSync(path); const names: string[] = [];
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (names.length >= maxEntries) throw Error('verification inventory budget exceeded');
      names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return names.sort();
}
