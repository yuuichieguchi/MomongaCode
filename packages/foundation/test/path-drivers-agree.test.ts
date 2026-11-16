import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostPaths, syncPaths } from '../src/index.ts';
import { withTempDir } from '@momonga/testkit';

const outcomeOf = <T>(answer: () => T): { value: T } | { error: string } => {
  try {
    return { value: answer() };
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
};

const settledOf = async <T>(answer: () => Promise<T>): Promise<{ value: T } | { error: string }> =>
  answer().then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
  );

const treeIn = (root: string): string => {
  const real = path.join(root, 'real');
  fs.mkdirSync(path.join(real, 'sub', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(real, 'target'));
  fs.writeFileSync(path.join(real, 'target', 'f'), 'x');
  fs.symlinkSync(path.join(real, 'target', 'f'), path.join(real, 'sub', 'link'));
  fs.symlinkSync(real, path.join(root, 'alias'));
  fs.symlinkSync('../target', path.join(real, 'sub', 'up'));
  fs.symlinkSync(path.join(root, 'loop-b'), path.join(root, 'loop-a'));
  fs.symlinkSync(path.join(root, 'loop-a'), path.join(root, 'loop-b'));
  return real;
};

describe('the asynchronous path driver and the synchronous one answer the same on the same tree (P-638)', () => {
  it('canonicalPath, realPath, comparablePath and canonicalDirectory agree for a file, a link, an alias, a dot segment, a missing tail and a loop', async (context) => {
    const root = fs.realpathSync(withTempDir(context));
    const real = treeIn(root);
    const asked = hostPaths(new AbortController().signal);
    const targets = [
      path.join(real, 'target', 'f'),
      path.join(real, 'sub', 'link'),
      path.join(root, 'alias', 'sub', 'link'),
      path.join(real, 'sub', 'up', 'f'),
      path.join(real, 'sub', 'deep', '..', '..', 'target', 'f'),
      path.join(real, 'sub', 'missing', 'tail'),
      path.join(root, 'loop-a', 'x'),
      path.join(real, 'sub', 'deep'),
    ];
    for (const target of targets) {
      for (const question of ['canonicalPath', 'realPath', 'comparablePath'] as const) {
        expect(await settledOf(() => asked[question](target)), `${question}(${target})`).toEqual(outcomeOf(() => syncPaths[question](target)));
      }
      expect(await settledOf(() => asked.canonicalDirectory(target)), `canonicalDirectory(${target})`).toEqual(outcomeOf(() => syncPaths.canonicalDirectory(target)));
    }
  });

  it('comparableContains agrees for a directory and a candidate reached through a link, an alias and a sibling', async (context) => {
    const root = fs.realpathSync(withTempDir(context));
    const real = treeIn(root);
    const asked = hostPaths(new AbortController().signal);
    const pairs: [string, string][] = [
      [path.join(real, 'target'), path.join(real, 'sub', 'link')],
      [path.join(root, 'alias'), path.join(real, 'target', 'f')],
      [path.join(real, 'sub'), path.join(real, 'target', 'f')],
      [path.join(real, 'sub'), path.join(real, 'sub', 'missing', 'tail')],
    ];
    for (const [directory, candidate] of pairs) {
      expect(await settledOf(() => asked.comparableContains(directory, candidate)), `${directory} ⊇ ${candidate}`).toEqual(outcomeOf(() => syncPaths.comparableContains(directory, candidate)));
    }
  });
});
