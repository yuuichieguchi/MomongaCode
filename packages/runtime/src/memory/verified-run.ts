import type { RuntimeStore } from '@momonga/store';
import type { SettingsPort } from '../ports.ts';

export type VerifiedRunDeps = {
  store: Pick<RuntimeStore, 'getRun' | 'getSession' | 'journalFacts'>;
  settings: Pick<SettingsPort, 'verification'>;
};

const sessionOfRun = (store: VerifiedRunDeps['store'], runId: string) => {
  const run = store.getRun(runId);
  if (run === undefined) throw new Error(`run ${runId} does not exist`);
  const session = store.getSession(run.sessionId);
  if (session === undefined) throw new Error(`session ${run.sessionId} of run ${runId} does not exist`);
  return { run, session };
};

export const isRunVerified = async ({ store, settings }: VerifiedRunDeps, runId: string, signal: AbortSignal): Promise<boolean> => {
  const { session } = sessionOfRun(store, runId);
  const verification = await settings.verification(session, signal);
  const { verified } = await store.journalFacts.verdict({ runId, commands: verification.commands, manifests: verification.manifests });
  return verified;
};
