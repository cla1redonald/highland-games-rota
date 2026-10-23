/**
 * Where things are. The repo's own files (the agent ids, the committed recordings) are read from the repo root, found
 * by walking up from the working directory, so the same code runs under `next dev` and in a Vercel function. Anything
 * written goes under the temporary directory: a function's only writable disk.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const marker = join('packages', 'agent-managed', 'resources', 'ids.json');

function findRoot(): string {
  if (process.env.GHILLIE_ROOT) return process.env.GHILLIE_ROOT;
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, marker))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`cannot find the repo root (no ${marker} above ${process.cwd()})`);
    dir = up;
  }
}

export const repoRoot = findRoot();
export const idsPath = join(repoRoot, marker);
export const committedRecordings = join(repoRoot, 'recordings', 'managed-live');

/** A fresh directory for one request's files. */
export function scratch(name: string): string {
  const dir = join(tmpdir(), 'ghillie', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
