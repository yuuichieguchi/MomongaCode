import { parseFlags } from '@momonga/foundation';
import type { EntryIo } from '@momonga/foundation';
import type { SelfExecutable, SpawnDetached } from '../ports.ts';
import { superviseInvocation } from './launcher.ts';

type SupervisorModule = typeof import('@momonga/supervisor');

type EntryDeps = Parameters<SupervisorModule['runSupervisorEntry']>[1];

export type SuperviseDeps = Omit<EntryDeps, 'launcher' | 'spawn' | 'successorLauncher'>;

export type SuccessorSpawn = { self: SelfExecutable; spawnDetached: SpawnDetached };

export type SuperviseOptions = {
  launcher: EntryDeps['launcher'];
  deps: SuperviseDeps;
  successor: SuccessorSpawn;
};

export const runSupervise = async (io: EntryIo, options: SuperviseOptions): Promise<number> => {
  const { runSupervisorEntry, createSpawnPort, SUPERVISE_ENTRY_FLAGS } = await import('@momonga/supervisor');
  const successorLauncher: NonNullable<EntryDeps['successorLauncher']> = {
    launch: (generation) => {
      const home = parseFlags(io.argv, SUPERVISE_ENTRY_FLAGS).home ?? io.home;
      const invocation = superviseInvocation(options.successor.self, home, generation, undefined);
      options.successor.spawnDetached({ command: invocation.command, args: invocation.args, env: io.env, cwd: home });
      return { pid: undefined };
    },
  };
  return runSupervisorEntry(io, { ...options.deps, launcher: options.launcher, spawn: createSpawnPort(), successorLauncher });
};
