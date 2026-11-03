import { isVerifiedSuccess } from '@momonga/memory';
import type { RuntimeStore } from '@momonga/store';
import type { SettingsPort } from '../ports.ts';
import { readAllRunEvents } from '../process/run-events.ts';

export type VerifiedRunDeps = {
  store: Pick<RuntimeStore, 'getRun' | 'getSession' | 'readRunEvents'>;
  settings: Pick<SettingsPort, 'verification'>;
};

export type EnqueueReflectionDeps = {
  store: VerifiedRunDeps['store'] & Pick<RuntimeStore, 'reflection'>;
  settings: Pick<SettingsPort, 'verification' | 'memory'>;
};

const sessionOfRun = (store: VerifiedRunDeps['store'], runId: string) => {
  const run = store.getRun(runId);
  if (run === undefined) throw new Error(`run ${runId} does not exist`);
  const session = store.getSession(run.sessionId);
  if (session === undefined) throw new Error(`session ${run.sessionId} of run ${runId} does not exist`);
  return { run, session };
};

export const isRunVerified = async ({ store, settings }: VerifiedRunDeps, runId: string): Promise<boolean> => {
  const { run, session } = sessionOfRun(store, runId);
  const verification = await settings.verification(session);
  return isVerifiedSuccess({ status: run.status, events: readAllRunEvents(store, runId), commands: verification.commands, manifests: verification.manifests });
};

export const enqueueReflection = async (deps: EnqueueReflectionDeps, runId: string): Promise<boolean> => {
  if (deps.store.reflection.runOrigin(runId) !== 'trusted') return false;
  const { session } = sessionOfRun(deps.store, runId);
  if (!(await deps.settings.memory(session)).reflection.enabled) return false;
  if (!(await isRunVerified(deps, runId))) return false;
  return deps.store.reflection.enqueue(runId);
};
