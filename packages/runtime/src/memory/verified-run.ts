import { isVerifiedSuccess } from '@momonga/memory';
import type { RuntimeStore } from '@momonga/store';
import type { SettingsPort } from '../ports.ts';
import { readAllRunEvents } from '../process/run-events.ts';

export type VerifiedRunDeps = {
  store: Pick<RuntimeStore, 'getRun' | 'getSession' | 'readRunEvents'>;
  settings: Pick<SettingsPort, 'verification'>;
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
