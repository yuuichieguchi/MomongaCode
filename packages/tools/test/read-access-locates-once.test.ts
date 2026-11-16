import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir } from '@momonga/testkit';
import { EMPTY_FILE_RULES, createPathResolver, nodeFileSystem } from '@momonga/foundation';
import type { PathFileSystem } from '@momonga/foundation';
import { createReadAccessMatcher } from '../src/read-access.ts';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const countingFiles = (): { files: PathFileSystem; asked: () => number } => {
  let count = 0;
  const counted = <Args extends unknown[], Result>(call: (...args: Args) => Promise<Result>) => (...args: Args): Promise<Result> => {
    count += 1;
    return call(...args);
  };
  return {
    files: { stat: counted(nodeFileSystem.stat), lstat: counted(nodeFileSystem.lstat), readlink: counted(nodeFileSystem.readlink), realpath: counted(nodeFileSystem.realpath), openDirectory: nodeFileSystem.openDirectory, access: nodeFileSystem.access },
    asked: () => count,
  };
};

const questionsForOneFile = async (guards: number): Promise<number> => {
  const root = createTempDir();
  made.push(root);
  const denied = Array.from({ length: guards }, (_, index) => path.join(root, `denied-${index}`));
  for (const directory of denied) fs.mkdirSync(directory);
  const file = path.join(root, 'project', 'deep', 'er', 'still', 'notes.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  const counting = countingFiles();
  const matcher = await createReadAccessMatcher({ readDenied: denied, fileRules: EMPTY_FILE_RULES }, createPathResolver(counting.files, new AbortController().signal));
  const before = counting.asked();
  expect(await matcher.blocksResolved(file)).toBe(false);
  return counting.asked() - before;
};

describe('the read access check of one path', () => {
  it('locates the path once, however many denied folders it is compared with', async () => {
    const withTwo = await questionsForOneFile(2);
    const withForty = await questionsForOneFile(40);
    expect(withForty).toBe(withTwo);
  });
});
