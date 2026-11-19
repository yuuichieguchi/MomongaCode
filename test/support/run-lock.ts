import fs from 'node:fs';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { stateDirOf } from '../../scripts/support/dev-state.ts';
import { RUN_CLASS_KEY, classOfSelection } from '../../scripts/support/run-class.ts';
import { wholeRunRefusalOf } from './whole-run-guard.ts';
import { runRootRefusalOf, runRootsOf } from './run-root.ts';
import { gateDecisionOf, gateRecordPathOf, gitCommonDirWhenPresentOf, headOf, readGateRecordText, writeGateRecord } from './gate-once.ts';
import type { ProjectRunClass, SelectionProject } from '../../scripts/support/run-class.ts';
import { CPU_BUDGET_ENV, breachLine, killTree, usageLine, watchTree } from '../../scripts/support/cpu-budget.ts';
import { vitestProjectBudgetOf } from '../../scripts/support/run-budgets.ts';
import { tierRunPlanOf } from '../formal/tier-budget.ts';
import { reuseModeOf } from '../formal/reuse.ts';
import { RUN_LOCK_ENV, RUN_LOCK_WAIT_ENV, STOPPED_WHILE_WAITING_MESSAGE, acquireRunLock, causeOf, parseBudgetSeconds, parseWaitSeconds, runLockDirsOf, unusableMessage, untilStopped } from '../../scripts/support/run-lock.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const TIER_RUNNER = path.join(REPO_ROOT, 'test', 'formal', 'tier.ts');

const refusalOf = (message: string): Error => {
  const refusal = new Error(message);
  refusal.stack = `${refusal.name}: ${refusal.message}`;
  return refusal;
};

const waitSecondsOf = (text: string | undefined): number => {
  try {
    return parseWaitSeconds(text, 'env');
  } catch (error) {
    throw refusalOf(causeOf(error));
  }
};

const stateDir = (): string => {
  try {
    return stateDirOf(REPO_ROOT, process.env);
  } catch (error) {
    throw refusalOf(unusableMessage(REPO_ROOT, causeOf(error)));
  }
};

const declaredClassOf = (project: TestProject): ProjectRunClass | undefined => {
  const declared: unknown = project.getProvidedContext()[RUN_CLASS_KEY];
  if (declared === undefined || declared === 'heavy' || declared === 'heavy-when-whole') return declared;
  throw refusalOf(`run-lock: project ${project.name} declares the unknown ${RUN_CLASS_KEY} ${JSON.stringify(declared)}`);
};

const selectionProjectOf = async (project: TestProject): Promise<SelectionProject> => ({
  name: project.name,
  runClass: declaredClassOf(project),
  files: (await project.globTestFiles()).testFiles,
});

const budgetOf = (projectNames: readonly string[]): number => {
  const given = process.env[CPU_BUDGET_ENV];
  if (given !== undefined) {
    try {
      return parseBudgetSeconds(given, CPU_BUDGET_ENV);
    } catch (error) {
      throw refusalOf(causeOf(error));
    }
  }
  return projectNames.reduce((total, name) => {
    const budget = vitestProjectBudgetOf(name);
    if (budget === undefined) throw refusalOf(`run-lock: no CPU budget for project ${name}: record one in vitestProjects of specs/tla/manifest.json, or set ${CPU_BUDGET_ENV}`);
    return total + budget;
  }, 0);
};

const tierBudgetOf = async (selected: readonly string[], stateDirPath: string): Promise<number> => {
  if (process.env[CPU_BUDGET_ENV] !== undefined) return 0;
  if (!selected.some((file) => file.startsWith(path.join(REPO_ROOT, 'test', 'formal') + path.sep))) return 0;
  const plan = await tierRunPlanOf({
    tier: process.env['MOMONGA_TLC_TIER'] === 'deep' ? 'deep' : 'every-run',
    manifestPath: path.join(REPO_ROOT, 'specs', 'tla', 'manifest.json'),
    repoRoot: REPO_ROOT,
    stateDir: stateDirPath,
    env: process.env,
    reuse: reuseModeOf(process.env) === 'on',
  });
  return plan.budgetCpuSeconds;
};

const endTreeAt = (breach: Parameters<typeof breachLine>[0]): void => {
  process.stderr.write(`${breachLine(breach)}\n`);
  killTree(process.pid).then(
    () => process.kill(process.pid, 'SIGKILL'),
    (error: unknown) => {
      throw error;
    },
  );
};

const holdGate = (projectNames: readonly string[]): void => {
  const commonDir = gitCommonDirWhenPresentOf(REPO_ROOT);
  if (commonDir === undefined) return;
  const recordPath = gateRecordPathOf(commonDir);
  const recordText = readGateRecordText(recordPath);
  if (recordText === undefined) return;
  const decision = gateDecisionOf({ argv: process.argv, env: process.env, projects: projectNames, recordPath, recordText, head: headOf(REPO_ROOT), now: new Date() });
  if (decision.kind === 'refused') throw refusalOf(decision.message);
  if (decision.kind === 'record') writeGateRecord(recordPath, decision.record);
};

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { state, projects } = project.vitest;
  if (typeof state.getPaths !== 'function' || !Array.isArray(projects)) throw refusalOf('run-lock: this vitest no longer exposes the selected test files');
  const roots = runRootsOf(project.vitest.config.root, process.cwd());
  process.stderr.write(`test run root: ${roots.vitestRoot} (started in ${roots.startedIn ?? `${process.cwd()}, outside any repository`})\n`);
  const rootRefusal = runRootRefusalOf(roots);
  if (rootRefusal !== undefined) throw refusalOf(rootRefusal);
  const refusal = wholeRunRefusalOf({ argv: process.argv, env: process.env, projects: projects.map((selected) => selected.name) });
  if (refusal !== undefined) throw refusalOf(refusal);
  holdGate(projects.map((selected) => selected.name));
  const selected = state.getPaths();
  const selectionProjects = await Promise.all(projects.map(selectionProjectOf));
  const selectedSet = new Set(selected);
  const projectBudgetCpuSeconds = budgetOf(selectionProjects.filter(({ files }) => files.some((file) => selectedSet.has(file))).map(({ name }) => name));
  const waitSeconds = waitSecondsOf(process.env[RUN_LOCK_WAIT_ENV]);
  const dir = stateDir();
  const budgetCpuSeconds = projectBudgetCpuSeconds + (await tierBudgetOf(selected, dir));
  const runClass = await classOfSelection({
    selected,
    projects: selectionProjects,
    repoRoot: REPO_ROOT,
    tierRunner: TIER_RUNNER,
    readFile: (file) => fs.promises.readFile(file, 'utf8'),
  });

  const { result: outcome } = await untilStopped((signal) =>
    acquireRunLock({
      runClass,
      ...runLockDirsOf(dir),
      command: process.argv.slice(1).join(' '),
      cwd: process.cwd(),
      pid: process.pid,
      env: process.env,
      waitSeconds,
      signal,
      say: (line) => process.stderr.write(`${line}\n`),
    }),
  );

  if (outcome.kind === 'inherited') return async () => undefined;
  if (outcome.kind === 'aborted') throw refusalOf(STOPPED_WHILE_WAITING_MESSAGE);
  if (outcome.kind !== 'acquired') throw refusalOf(outcome.message);
  const { release } = outcome;
  process.env[RUN_LOCK_ENV] = outcome.token;
  const watch = watchTree(process.pid, budgetCpuSeconds, endTreeAt);
  return async () => {
    watch.stop();
    process.stderr.write(`${usageLine(watch.usedCpuSeconds(), budgetCpuSeconds)}\n`);
    await release();
    delete process.env[RUN_LOCK_ENV];
  };
}
