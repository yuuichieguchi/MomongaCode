import fs from 'node:fs';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { stateDirOf } from '../../scripts/support/dev-state.ts';
import { RUN_CLASS_KEY, classOfSelection } from '../../scripts/support/run-class.ts';
import type { ProjectRunClass, SelectionProject } from '../../scripts/support/run-class.ts';
import { RUN_LOCK_ENV, RUN_LOCK_WAIT_ENV, STOPPED_WHILE_WAITING_MESSAGE, acquireRunLock, causeOf, parseWaitSeconds, unusableMessage } from '../../scripts/support/run-lock.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const TIER_RUNNER = path.join(REPO_ROOT, 'test', 'formal', 'tier.ts');
const STOPPING_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

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

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { state, projects } = project.vitest;
  if (typeof state.getPaths !== 'function' || !Array.isArray(projects)) throw refusalOf('run-lock: this vitest no longer exposes the selected test files');
  const waitSeconds = waitSecondsOf(process.env[RUN_LOCK_WAIT_ENV]);
  const dir = stateDir();
  const runClass = await classOfSelection({
    selected: state.getPaths(),
    projects: await Promise.all(projects.map(selectionProjectOf)),
    repoRoot: REPO_ROOT,
    tierRunner: TIER_RUNNER,
    readFile: (file) => fs.promises.readFile(file, 'utf8'),
  });

  const stopping = new AbortController();
  const stop = (): void => stopping.abort();
  for (const signal of STOPPING_SIGNALS) process.on(signal, stop);
  let outcome: Awaited<ReturnType<typeof acquireRunLock>>;
  try {
    outcome = await acquireRunLock({
      runClass,
      dir: path.join(dir, 'run-lock'),
      proofDir: path.join(dir, 'run-lock-proof'),
      command: process.argv.slice(1).join(' '),
      cwd: process.cwd(),
      pid: process.pid,
      env: process.env,
      waitSeconds,
      signal: stopping.signal,
      say: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    for (const signal of STOPPING_SIGNALS) process.off(signal, stop);
  }

  if (outcome.kind === 'inherited') return async () => undefined;
  if (outcome.kind === 'aborted') throw refusalOf(STOPPED_WHILE_WAITING_MESSAGE);
  if (outcome.kind !== 'acquired') throw refusalOf(outcome.message);
  const { release } = outcome;
  process.env[RUN_LOCK_ENV] = outcome.token;
  return async () => {
    await release();
    delete process.env[RUN_LOCK_ENV];
  };
}
