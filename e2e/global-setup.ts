import fs from 'node:fs';
import path from 'node:path';
import { LINUX_SOCKET_GUARD_MANIFEST_ASSET } from '@momonga/foundation';
import { execFileSync } from '@momonga/testkit/child-process';
import { LINUX_SOCKET_GUARD_BUILD_SCRIPT, LINUX_SOCKET_GUARD_BUILT_DIRECTORY } from '../packages/cli/src/node-ports.ts';
import { TEST_RUN_ENV } from '@momonga/testkit';
import { E2E_CASES } from './support/cases.ts';
import { CLI_FAKES_BUNDLE, CLI_FAKES_ENTRY } from './support/cli-bundles.ts';
import { INJECTION_REPORT_ENV, assembleInjectionReport, openInjectionParts } from './support/inject-report.ts';
import { BUNDLE_SCRIPT } from './support/launcher.ts';
import { E2E_FILE_STACK_RATIONALE, hostE2eFileWorkers } from './support/parallelism.ts';
import { claimE2eRun } from './support/run-setup.ts';
import { SANDBOX_ENV, encodeSandboxProbe, runSandboxProbe, sandboxLine } from './support/sandbox.ts';

export const NO_PROJECT_REFUSAL = 'this run names no project and would include the calibration project; name the projects, as npm test and npm run test:reuse do';

const linuxSocketGuardManifest = path.join(LINUX_SOCKET_GUARD_BUILT_DIRECTORY, 'linux-socket-guard', LINUX_SOCKET_GUARD_MANIFEST_ASSET);

const provideLinuxSocketGuard = (): void => {
  if (process.platform !== 'linux' || fs.existsSync(linuxSocketGuardManifest)) return;
  execFileSync(process.execPath, [LINUX_SOCKET_GUARD_BUILD_SCRIPT, '--compiler', 'host'], { stdio: 'inherit' });
};

const namesAProject = (argv: readonly string[]): boolean => argv.some((arg) => arg === '--project' || arg.startsWith('--project='));

export const refusedSelection = (argv: readonly string[]): string | undefined => (namesAProject(argv) ? undefined : NO_PROJECT_REFUSAL);

export default function setup(): () => Promise<void> {
  const refusal = refusedSelection(process.argv);
  if (refusal !== undefined) throw new Error(refusal);
  const { run, teardown } = claimE2eRun();
  process.env[TEST_RUN_ENV] = run;
  execFileSync(process.execPath, [BUNDLE_SCRIPT], { stdio: 'inherit' });
  execFileSync(process.execPath, [BUNDLE_SCRIPT, '--entry', CLI_FAKES_ENTRY, '--outfile', CLI_FAKES_BUNDLE], { stdio: 'inherit' });
  provideLinuxSocketGuard();
  const probe = runSandboxProbe();
  process.env[SANDBOX_ENV] = encodeSandboxProbe(probe);
  console.log(sandboxLine(probe, E2E_CASES));
  console.log(`e2e files at once: ${hostE2eFileWorkers()}, the smaller of the processors and the memory share over one stack (${E2E_FILE_STACK_RATIONALE.join('; ')})`);
  const report = process.env[INJECTION_REPORT_ENV];
  if (report === undefined) return teardown;
  openInjectionParts(report);
  return async () => {
    await assembleInjectionReport(report);
    await teardown();
  };
}
