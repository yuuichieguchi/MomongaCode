import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncPaths } from '../src/index.ts';
import { createTempDir } from '@momonga/testkit';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = createTempDir();
  tempDirs.push(dir);
  return dir;
};

describe('canonicalPath with a dangling relative symlink', () => {
  const fixture = () => {
    const p = makeDir();
    fs.mkdirSync(path.join(p, 'real', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(p, 'real', 'target'));
    fs.symlinkSync(path.join(p, 'real', 'sub'), path.join(p, 'alias'));
    fs.symlinkSync(path.join('..', 'target', 'f'), path.join(p, 'real', 'sub', 'link'));
    return p;
  };

  it('resolves the link against its real parent directory', () => {
    const p = fixture();
    expect(syncPaths.canonicalPath(path.join(p, 'real', 'sub', 'link'))).toBe(path.join(p, 'real', 'target', 'f'));
  });

  it('gives the same result when the link is reached through a directory symlink', () => {
    const p = fixture();
    expect(syncPaths.canonicalPath(path.join(p, 'alias', 'link'))).toBe(path.join(p, 'real', 'target', 'f'));
    expect(syncPaths.canonicalPath(path.join(p, 'alias', 'link'))).toBe(syncPaths.canonicalPath(path.join(p, 'real', 'sub', 'link')));
  });
});
