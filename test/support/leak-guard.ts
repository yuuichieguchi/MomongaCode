import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

const TEST_RUN_ENV = 'MOMONGA_TEST_RUN';

export const leakedTempDirs = (tmpRoot: string, token: string): string[] => {
  const prefix = `mmt-${token}-`;
  return fs
    .readdirSync(tmpRoot)
    .filter((entry) => entry.startsWith(prefix))
    .sort();
};

export const assertNoLeakedTempDirs = (tmpRoot: string, token: string): void => {
  const leaked = leakedTempDirs(tmpRoot, token);
  if (leaked.length === 0) return;
  throw new Error(`test run ${token} left ${leaked.length} temp dir(s) in ${tmpRoot}: ${leaked.join(', ')}`);
};

export const newRunToken = (): string => randomBytes(2).toString('hex');

export default function setup(): () => void {
  const token = newRunToken();
  process.env[TEST_RUN_ENV] = token;
  const tmpRoot = os.tmpdir();
  return () => assertNoLeakedTempDirs(tmpRoot, token);
}
