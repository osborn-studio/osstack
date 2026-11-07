// Publishes a JSON marker so a polling reader never observes a partial file:
// write to a temp file in the same directory, then rename (atomic on POSIX).
import { renameSync, writeFileSync } from 'node:fs';

export function writeJsonAtomic(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, file);
}
