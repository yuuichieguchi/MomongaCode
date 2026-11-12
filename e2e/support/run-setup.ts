import { randomBytes } from 'node:crypto';
import { E2E_RUN_ENV, e2eTmpRoot } from './run-env.ts';
import { runE2eTeardown } from './teardown.ts';

export const claimE2eRun = (): { run: string; teardown: () => Promise<void> } => {
  const run = randomBytes(2).toString('hex');
  process.env[E2E_RUN_ENV] = run;
  const tmpRoot = e2eTmpRoot();
  return { run, teardown: () => runE2eTeardown({ tmpRoot, run }) };
};

export default function setup(): () => Promise<void> {
  return claimE2eRun().teardown;
}
