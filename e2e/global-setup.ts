import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { TEST_RUN_ENV } from '@momonga/testkit';
import { E2E_CASES } from './support/cases.ts';
import { BUNDLE_SCRIPT } from './support/launcher.ts';
import { E2E_RUN_ENV } from './support/run-env.ts';
import { SANDBOX_ENV, encodeSandboxProbe, runSandboxProbe, sandboxLine } from './support/sandbox.ts';
import { runE2eTeardown } from './support/teardown.ts';

export const BOTH_PROJECTS_WARNING = 'e2e warning: both projects are selected; run e2e only through npm run test:e2e';

export const bothProjectsSelected = (argv: readonly string[]): boolean => {
  const projects: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === '--project') projects.push(argv[index + 1] ?? '');
    else if (arg.startsWith('--project=')) projects.push(arg.slice('--project='.length));
  });
  return projects.length === 0 || (projects.includes('unit') && projects.includes('e2e'));
};

export default function setup(): () => Promise<void> {
  const run = randomBytes(2).toString('hex');
  process.env[E2E_RUN_ENV] = run;
  process.env[TEST_RUN_ENV] = run;
  execFileSync(process.execPath, [BUNDLE_SCRIPT], { stdio: 'inherit' });
  const probe = runSandboxProbe();
  process.env[SANDBOX_ENV] = encodeSandboxProbe(probe);
  console.log(sandboxLine(probe, E2E_CASES));
  if (bothProjectsSelected(process.argv)) console.warn(BOTH_PROJECTS_WARNING);
  const tmpRoot = fs.realpathSync(os.tmpdir());
  return () => runE2eTeardown({ tmpRoot, run });
}
