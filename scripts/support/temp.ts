import fs from 'node:fs';
import path from 'node:path';
import { TEST_RUN_ENV, assertHomeSocketBudget, tempDirBase, tempDirPrefixFor } from '../../packages/testkit/src/test-support.ts';
import type { TempDirOptions } from '../../packages/testkit/src/test-support.ts';

export const createTempRoot = (options: TempDirOptions = {}): string => {
  const token = process.env[TEST_RUN_ENV];
  if (token === undefined) throw new Error(`${TEST_RUN_ENV} is not set; run through a vitest project with the leak-guard global setup`);
  const asHome = options.asHome === true;
  const root = fs.mkdtempSync(path.join(tempDirBase(asHome), tempDirPrefixFor(token)));
  if (asHome) assertHomeSocketBudget(fs.realpathSync(root));
  return root;
};

export const removeTempRoot = (root: string): void => {
  fs.rmSync(root, { recursive: true, force: true });
};
