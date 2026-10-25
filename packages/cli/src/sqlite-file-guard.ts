import { lstatSync } from 'node:fs';

/** Existing SQLite files may not alias another home. Ancestor directory aliases
 * are a separate home policy. This check is not a same-UID race defense. */
export function assertSingleSqliteFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    const stat = lstatSync(candidate, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw Error('db_path_not_single_file');
  }
}
