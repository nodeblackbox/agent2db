import * as path from 'node:path';

/**
 * Locate the repository root: the nearest ancestor of `startDir` that contains
 * `pnpm-workspace.yaml`. An explicit override (env AGENT2DB_REPO_ROOT) wins.
 * `exists` is injected so this stays unit-testable.
 */
export function findRepoRoot(
  startDir: string,
  exists: (p: string) => boolean,
  override?: string,
): string | null {
  if (override && override.trim().length > 0) return path.resolve(override.trim());
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (exists(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
