import type { EntryIo } from '@momonga/foundation';

type SupervisorModule = typeof import('@momonga/supervisor');

export type SuperviseDeps = Omit<Parameters<SupervisorModule['runSupervisorEntry']>[1], 'launcher' | 'spawn'>;

export type SuperviseOptions = {
  launcher: Parameters<SupervisorModule['runSupervisorEntry']>[1]['launcher'];
  deps: SuperviseDeps;
};

export const runSupervise = async (io: EntryIo, options: SuperviseOptions): Promise<number> => {
  const { runSupervisorEntry, createSpawnPort } = await import('@momonga/supervisor');
  return runSupervisorEntry(io, { ...options.deps, launcher: options.launcher, spawn: createSpawnPort() });
};
