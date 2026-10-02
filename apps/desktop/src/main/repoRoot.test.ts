import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from './repoRoot';

describe('findRepoRoot', () => {
  const root = path.resolve('/work/Agent2DB');
  const exists = (p: string): boolean => p === path.join(root, 'pnpm-workspace.yaml');

  it('walks up from the built main directory to the workspace root', () => {
    expect(findRepoRoot(path.join(root, 'apps', 'desktop', 'out', 'main'), exists)).toBe(root);
  });

  it('honours an explicit override', () => {
    expect(findRepoRoot('/anywhere', exists, '/custom/root')).toBe(path.resolve('/custom/root'));
  });

  it('returns null when no workspace file is found', () => {
    expect(findRepoRoot(path.resolve('/elsewhere/deep/dir'), exists)).toBeNull();
  });
});
