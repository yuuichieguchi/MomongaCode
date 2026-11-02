import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const createTempRoot = (): string => {
  const token = process.env['MOMONGA_TEST_RUN'];
  if (token === undefined) throw new Error('MOMONGA_TEST_RUN is not set; run through a vitest project with the leak-guard global setup');
  return fs.mkdtempSync(path.join(os.tmpdir(), `mmt-${token}-`));
};

export const removeTempRoot = (root: string): void => {
  fs.rmSync(root, { recursive: true, force: true });
};
