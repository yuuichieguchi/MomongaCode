import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TEST_RUN_ENV, tempDirPrefixFor, testTempBases } from '@momonga/testkit';

export const leakedTempDirs = (tmpRoot: string, token: string): string[] => {
  const prefix = tempDirPrefixFor(token);
  return fs
    .readdirSync(tmpRoot)
    .filter((entry) => entry.startsWith(prefix))
    .sort();
};

export const assertNoLeakedTempDirs = (tmpRoots: readonly string[], token: string): void => {
  const leaked = tmpRoots.flatMap((tmpRoot) => leakedTempDirs(tmpRoot, token).map((entry) => path.join(tmpRoot, entry)));
  if (leaked.length === 0) return;
  throw new Error(`test run ${token} left ${leaked.length} temp dir(s): ${leaked.join(', ')}`);
};

export const newRunToken = (): string => randomBytes(2).toString('hex');

export default function setup(): () => void {
  const token = newRunToken();
  process.env[TEST_RUN_ENV] = token;
  const tmpRoots = testTempBases();
  return () => assertNoLeakedTempDirs(tmpRoots, token);
}
