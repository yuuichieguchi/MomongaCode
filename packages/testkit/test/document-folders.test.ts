import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDir, documentEnvironmentOf, documentFolderOf, documentsLocationOf, mainCheckoutRootOf } from '../src/index.ts';

type Layout = { readonly root: string; readonly repository: string; readonly worktree: string; readonly documents: string };

const layout = (): Layout => {
  const root = createTempDir();
  const repository = path.join(root, 'MomongaCode');
  const worktree = path.join(repository, '.claude', 'worktrees', 'fix-a');
  const gitDir = path.join(repository, '.git', 'worktrees', 'fix-a');
  const documents = path.join(root, 'MomongaCode-docs');
  fs.mkdirSync(path.join(worktree, 'test'), { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  for (const part of ['design', 'constants']) fs.mkdirSync(path.join(documents, part), { recursive: true, mode: 0o700 });
  fs.chmodSync(documents, 0o700);
  return { root, repository, worktree, documents };
};

const within = (check: (paths: Layout) => void): void => {
  const paths = layout();
  try {
    check(paths);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
};

describe('the documents folder beside the main checkout', () => {
  it('resolves the main checkout of a worktree through its git common directory, and finds the folder from either', () => {
    within(({ repository, worktree, documents }) => {
      expect(mainCheckoutRootOf(path.join(worktree, 'test'))).toBe(repository);
      expect(mainCheckoutRootOf(repository)).toBe(repository);
      expect(documentsLocationOf(worktree)).toEqual({ kind: 'found', folder: documents });
      expect(documentsLocationOf(repository)).toEqual({ kind: 'found', folder: documents });
    });
  });

  it('never takes a folder planted beside another ancestor', () => {
    within(({ repository, worktree, documents }) => {
      fs.rmSync(documents, { recursive: true, force: true });
      fs.mkdirSync(path.join(repository, '.claude', 'worktrees', 'MomongaCode-docs', 'design'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(repository, '.claude', 'MomongaCode-docs', 'design'), { recursive: true, mode: 0o700 });
      expect(documentsLocationOf(worktree)).toEqual({ kind: 'absent' });
      expect(documentEnvironmentOf(worktree, {})).toEqual({});
    });
  });

  it('refuses a folder that group or others may write, and names why', () => {
    within(({ worktree, documents }) => {
      fs.chmodSync(path.join(documents, 'constants'), 0o777);
      expect(documentsLocationOf(worktree)).toEqual({ kind: 'refused', folder: path.join(documents, 'constants'), reason: 'group or others may write it (mode 777)' });
      expect(documentEnvironmentOf(worktree, {})).toEqual({});
      expect(documentFolderOf('MOMONGA_CONSTANTS_DOCUMENT', worktree, {})).toMatchObject({ kind: 'refused' });
    });
  });

  it('refuses a documents path that is not a directory', () => {
    within(({ worktree, documents }) => {
      fs.rmSync(documents, { recursive: true, force: true });
      fs.writeFileSync(documents, 'not a folder');
      expect(documentsLocationOf(worktree)).toEqual({ kind: 'refused', folder: documents, reason: 'it is not a directory' });
    });
  });

  it('names both folders for a run that names neither, and an explicit variable wins even over a refused folder', () => {
    within(({ worktree, documents }) => {
      expect(documentEnvironmentOf(worktree, {})).toEqual({ MOMONGA_CONSTANTS_DOCUMENT: path.join(documents, 'constants'), MOMONGA_DESIGN_DOCUMENTS: path.join(documents, 'design') });
      expect(documentFolderOf('MOMONGA_DESIGN_DOCUMENTS', worktree, {})).toEqual({ kind: 'unnamed', expected: path.join(documents, 'design') });
      fs.chmodSync(documents, 0o777);
      expect(documentFolderOf('MOMONGA_DESIGN_DOCUMENTS', worktree, { MOMONGA_DESIGN_DOCUMENTS: '/given' })).toEqual({ kind: 'named', folder: '/given' });
    });
  });
});
