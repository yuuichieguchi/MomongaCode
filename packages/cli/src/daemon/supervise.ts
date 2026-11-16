import { hostProcessGroupPort, parseFlags } from '@momonga/foundation';
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

export type SuccessorStart = { home: string; env: EntryIo['env'] };

export const successorLauncherOf = (start: SuccessorStart, successor: SuccessorSpawn): NonNullable<EntryDeps['successorLauncher']> => ({
  launch: (generation) => {
    const invocation = superviseInvocation(successor.self, start.home, generation, undefined);
    const { exit } = successor.spawnDetached({ command: invocation.command, args: invocation.args, env: start.env, cwd: start.home });
    return { pid: undefined, exit };
  },
});

export const runSupervise = async (io: EntryIo, options: SuperviseOptions): Promise<number> => {
  const { runSupervisorEntry, createSpawnPort, SUPERVISE_ENTRY_FLAGS } = await import('@momonga/supervisor');
  const home = parseFlags(io.argv, SUPERVISE_ENTRY_FLAGS).home ?? io.home;
  const port = hostProcessGroupPort();
  return runSupervisorEntry(io, { ...options.deps, markerPorts: { ...options.deps.markerPorts, groupPort: port }, launcher: options.launcher, spawn: createSpawnPort({ port }), successorLauncher: successorLauncherOf({ home, env: io.env }, options.successor) });
};
