import { createHash } from 'node:crypto';
import path from 'node:path';

export const TEST_REUSE_ENV = 'MOMONGA_TEST_REUSE';

export const REUSE_STORE = path.join('.cache', 'test-reuse');

export const OBSERVED_DIR = 'observed';

type Env = Readonly<Record<string, string | undefined>>;

export const testReuseModeOf = (env: Env): 'on' | 'off' => {
  const value = env[TEST_REUSE_ENV];
  if (value === undefined || value === '0') return 'off';
  if (value === '1') return 'on';
  throw new Error(`${TEST_REUSE_ENV} must be 1 or 0, got "${value}"`);
};

export const observedNameOf = (file: string): string => createHash('sha256').update(file).digest('hex');

export const observedFileOf = (root: string, file: string, pid: number): string => path.join(root, REUSE_STORE, OBSERVED_DIR, `${observedNameOf(file)}.${pid}.json`);
