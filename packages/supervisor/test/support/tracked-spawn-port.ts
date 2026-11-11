import { groupAlive } from '@momonga/foundation';
import { killGroupsForCleanup, registerCleanup } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import type { ChildHandle, SpawnPort } from '../../src/child-manager.ts';
import { createSpawnPort } from '../../src/spawn-port.ts';

export type TrackedSpawnPort = SpawnPort & {
  readonly spawned: readonly ChildHandle[];
  trackGroup(pgid: number): void;
};

const killGroupAndAssertDead = async (pgid: number): Promise<void> => {
  await killGroupsForCleanup([pgid]);
  if (await groupAlive(pgid)) throw new Error(`tracked process ${pgid} is still alive after its group was killed`);
};

export const trackedSpawnPort = (context: CleanupContext, platform?: NodeJS.Platform): TrackedSpawnPort => {
  const realPort = createSpawnPort(platform === undefined ? {} : { platform });
  const spawned: ChildHandle[] = [];
  const port: SpawnPort = (command, args, options) => {
    const handle = realPort(command, args, options);
    spawned.push(handle);
    const pid = handle.pid;
    if (pid !== undefined) registerCleanup(context, () => killGroupAndAssertDead(pid));
    return handle;
  };
  return Object.assign(port, {
    spawned,
    trackGroup: (pgid: number): void => {
      registerCleanup(context, () => killGroupAndAssertDead(pgid));
    },
  });
};
