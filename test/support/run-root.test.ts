import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from '@momonga/testkit/child-process';
import { createTempRoot, removeTempRoot } from '../../scripts/support/temp.ts';
import { repositoryRootOf, runRootRefusalOf } from './run-root.ts';

describe('the root of a test run', () => {
  let root = '';

  beforeEach(() => {
    root = fs.realpathSync(createTempRoot());
  });

  afterEach(async () => {
    await removeTempRoot(root);
  });

  it('refuses a run whose vitest root is not the repository the command was started in', () => {
    expect(runRootRefusalOf({ startedIn: '/work/a', vitestRoot: '/work/b/packages', vitestRepository: '/work/b' })).toBe(
      'test run: started in the repository /work/a but vitest runs the code of /work/b/packages; start the run from /work/b, or run the vitest of /work/a',
    );
  });

  it('accepts a run started outside any repository', () => {
    expect(runRootRefusalOf({ startedIn: undefined, vitestRoot: '/work/a', vitestRepository: '/work/a' })).toBeUndefined();
  });

  it('accepts a vitest root outside any repository, as a fixture under a temporary directory', () => {
    expect(runRootRefusalOf({ startedIn: '/work/a', vitestRoot: '/tmp/fixture', vitestRepository: undefined })).toBeUndefined();
  });

  it('accepts a run whose vitest root is in the repository it was started in', () => {
    expect(runRootRefusalOf({ startedIn: '/work/a', vitestRoot: '/work/a/sub', vitestRepository: '/work/a' })).toBeUndefined();
  });

  it('finds the repository of a directory inside a worktree, and none outside a repository', () => {
    execFileSync('git', ['init', '-q', root]);
    fs.mkdirSync(path.join(root, 'deep', 'er'), { recursive: true });
    expect(repositoryRootOf(path.join(root, 'deep', 'er'))).toBe(root);
    const outside = createTempRoot();
    expect(repositoryRootOf(outside)).toBeUndefined();
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
