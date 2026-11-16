import { execFileSync } from '@momonga/testkit/child-process';
import { TEST_RUN_ENV } from '@momonga/testkit';
import { E2E_CASES } from './support/cases.ts';
import { CLI_FAKES_BUNDLE, CLI_FAKES_ENTRY } from './support/cli-bundles.ts';
import { BUNDLE_SCRIPT } from './support/launcher.ts';
import { claimE2eRun } from './support/run-setup.ts';
import { SANDBOX_ENV, encodeSandboxProbe, runSandboxProbe, sandboxLine } from './support/sandbox.ts';

export const BOTH_PROJECTS_REFUSAL = 'the unit and the e2e projects cannot share one run; run e2e only through npm run test:e2e';

const bothProjectsSelected = (argv: readonly string[]): boolean => {
  const projects: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === '--project') projects.push(argv[index + 1] ?? '');
    else if (arg.startsWith('--project=')) projects.push(arg.slice('--project='.length));
  });
  return projects.length === 0 || (projects.includes('unit') && projects.includes('e2e'));
};

export const refusedSelection = (argv: readonly string[]): string | undefined => (bothProjectsSelected(argv) ? BOTH_PROJECTS_REFUSAL : undefined);

export default function setup(): () => Promise<void> {
  const refusal = refusedSelection(process.argv);
  if (refusal !== undefined) throw new Error(refusal);
  const { run, teardown } = claimE2eRun();
  process.env[TEST_RUN_ENV] = run;
  execFileSync(process.execPath, [BUNDLE_SCRIPT], { stdio: 'inherit' });
  execFileSync(process.execPath, [BUNDLE_SCRIPT, '--entry', CLI_FAKES_ENTRY, '--outfile', CLI_FAKES_BUNDLE], { stdio: 'inherit' });
  const probe = runSandboxProbe();
  process.env[SANDBOX_ENV] = encodeSandboxProbe(probe);
  console.log(sandboxLine(probe, E2E_CASES));
  return teardown;
}
