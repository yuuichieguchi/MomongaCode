import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { TEMP_DIR_PREFIX } from '@momonga/testkit';
import { CLAIM_FILE_SUFFIX, E2E_RUN_ENV, createHarnessFile, e2eEntryPrefix, e2eTmpRoot, harnessFilePath, sharedTempBase } from './run-env.ts';
import { runE2eTeardown } from './teardown.ts';

const RUN_TOKEN_DRAWS = 64;

export type E2eRunClaimOptions = { readonly tmpRoot?: string; readonly sharedBase?: string; readonly draw?: () => string };

const carriedBy = (listing: readonly string[], prefix: string): boolean => listing.some((entry) => entry.startsWith(prefix));

const claimed = (tmpRoot: string, run: string): boolean => {
  try {
    createHarnessFile(harnessFilePath(tmpRoot, run, CLAIM_FILE_SUFFIX), `${process.pid}\n`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
};

export const claimE2eRun = (options: E2eRunClaimOptions = {}): { run: string; teardown: () => Promise<void> } => {
  const { tmpRoot = e2eTmpRoot(), sharedBase = sharedTempBase(), draw = () => randomBytes(2).toString('hex') } = options;
  const tried: string[] = [];
  for (let draws = 0; draws < RUN_TOKEN_DRAWS; draws += 1) {
    const run = draw();
    tried.push(run);
    const inUse = carriedBy(fs.readdirSync(tmpRoot), e2eEntryPrefix(run)) || carriedBy(fs.readdirSync(sharedBase), `${TEMP_DIR_PREFIX}${run}-`);
    if (inUse || !claimed(tmpRoot, run)) continue;
    process.env[E2E_RUN_ENV] = run;
    return { run, teardown: () => runE2eTeardown({ tmpRoot, run, sharedBase }) };
  }
  throw new Error(`no free e2e run token after ${RUN_TOKEN_DRAWS} draws: ${[...new Set(tried)].join(', ')}`);
};

export default function setup(): () => Promise<void> {
  return claimE2eRun().teardown;
}
