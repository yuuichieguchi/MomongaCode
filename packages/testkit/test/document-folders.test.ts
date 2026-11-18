import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDir, documentEnvironmentOf, documentFolderOf, siblingDocumentsOf } from '../src/index.ts';

const layout = (): { readonly root: string; readonly repository: string; readonly worktree: string; readonly documents: string } => {
  const root = createTempDir();
  const repository = path.join(root, 'MomongaCode');
  const worktree = path.join(repository, '.claude', 'worktrees', 'fix-a');
  const documents = path.join(root, 'MomongaCode-docs');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(documents, 'design'), { recursive: true });
  fs.mkdirSync(path.join(documents, 'constants'), { recursive: true });
  return { root, repository, worktree, documents };
};

describe('the documents folder beside the repository', () => {
  it('is found from the repository and from any of its worktrees', () => {
    const { root, repository, worktree, documents } = layout();
    try {
      expect(siblingDocumentsOf(repository)).toBe(documents);
      expect(siblingDocumentsOf(worktree)).toBe(documents);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('names both folders for a run that names neither, and keeps a folder the run names', () => {
    const { root, worktree, documents } = layout();
    try {
      expect(documentEnvironmentOf(worktree, {})).toEqual({ MOMONGA_CONSTANTS_DOCUMENT: path.join(documents, 'constants'), MOMONGA_DESIGN_DOCUMENTS: path.join(documents, 'design') });
      expect(documentEnvironmentOf(worktree, { MOMONGA_DESIGN_DOCUMENTS: '/elsewhere' })).toEqual({ MOMONGA_CONSTANTS_DOCUMENT: path.join(documents, 'constants') });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a folder that exists but is not named, so a check that needs it fails instead of being skipped', () => {
    const { root, worktree, documents } = layout();
    try {
      expect(documentFolderOf('MOMONGA_DESIGN_DOCUMENTS', worktree, {})).toEqual({ kind: 'unnamed', expected: path.join(documents, 'design') });
      expect(documentFolderOf('MOMONGA_DESIGN_DOCUMENTS', worktree, { MOMONGA_DESIGN_DOCUMENTS: '/given' })).toEqual({ kind: 'named', folder: '/given' });
      fs.rmSync(documents, { recursive: true, force: true });
      expect(documentFolderOf('MOMONGA_DESIGN_DOCUMENTS', worktree, {})).toEqual({ kind: 'absent' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
