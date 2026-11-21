import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOCAL_EXCLUDE_PATH = "info/exclude";

export function updateLocalExclude(
  commonDir: string,
  createMode: number,
  update: (before: Buffer) => readonly (Buffer | string)[] | null,
): boolean {
  const path = join(commonDir, LOCAL_EXCLUDE_PATH);
  const parent = dirname(path);
  try { mkdirSync(parent); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (realpathSync(parent) !== parent) throw new Error(`${parent} is not a canonical directory`);

  const lock = `${path}.lock`;
  const fd = openSync(lock, "wx", createMode);
  let renamed = false;
  try {
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error(`${path} is not a regular file`);
    const next = update(existing ? readFileSync(path) : Buffer.alloc(0));
    if (next === null) return false;
    for (const part of next) writeFileSync(fd, part);
    if (existing) fchmodSync(fd, existing.mode & 0o7777);
    fsyncSync(fd);
    renameSync(lock, path);
    renamed = true;
    return true;
  } finally {
    try {
      closeSync(fd);
    } finally {
      // After rename the lock name can already belong to the next writer.
      if (!renamed) rmSync(lock, { force: true });
    }
  }
}
