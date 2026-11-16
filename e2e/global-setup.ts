import { execFileSync } from '@momonga/testkit/child-process';
import { TEST_RUN_ENV } from '@momonga/testkit';
import { E2E_CASES } from './support/cases.ts';
import { CLI_FAKES_BUNDLE, CLI_FAKES_ENTRY } from './support/cli-bundles.ts';
import { BUNDLE_SCRIPT } from './support/launcher.ts';
import { claimE2eRun } from './support/run-setup.ts';
import { SANDBOX_ENV, encodeSandboxProbe, runSandboxProbe, sandboxLine } from './support/sandbox.ts';

export const NO_PROJECT_REFUSAL = 'this run names no project and would include the calibration project; name the projects, as npm test and npm run test:reuse do';

const namesAProject = (argv: readonly string[]): boolean => argv.some((arg) => arg === '--project' || arg.startsWith('--project='));

export const refusedSelection = (argv: readonly string[]): string | undefined => (namesAProject(argv) ? undefined : NO_PROJECT_REFUSAL);

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
