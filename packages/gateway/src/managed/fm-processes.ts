import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createHostExec, groupRecordOutcome, hostProcessGroupPort, launchGroupLeader, recordMarkerGroup, reapMarkedProcesses, reapMarkerDirectory, signalGroup } from '@momonga/foundation';
import type { GroupLaunch, GroupLaunchHost, ProcessGroupPort, ProcessInspector } from '@momonga/foundation';
import type { ExecFn } from './preconditions.ts';
import type { ManagedChild, SpawnFn } from './server.ts';

export type ChildEnv = Readonly<Record<string, string>>;

export const MANAGED_SERVER_LABEL = 'managed server';

const envOption = (env: ChildEnv | undefined): { env?: Record<string, string> } => (env === undefined ? {} : { env: { ...env } });

export const createExecFn = (env: ChildEnv | undefined): ExecFn => createHostExec(env);

export { createExecWithStdin } from '@momonga/foundation';

const MARKER_FD_INDEX = 3;

export type WarningSink = (message: string) => void;

const groupChildOf = ({ child, pgid, onExit }: GroupLaunch, marker: string, onWarning: WarningSink, inspector: ProcessInspector, port: ProcessGroupPort): ManagedChild => {
  const removeMarker = (): void => fs.rmSync(marker, { force: true });
  child.once('error', removeMarker);
  const recorded =
    pgid === undefined
      ? Promise.resolve()
      : groupRecordOutcome(recordMarkerGroup(marker, pgid, { names: port.names }), marker).then((notice) => {
          if (notice !== undefined) onWarning(notice);
        });
  return {
    kill: async (signal = 'SIGTERM', stop) => {
      if (pgid === undefined) return false;
      await signalGroup(pgid, signal, port, stop);
      return true;
    },
    finalize: async (graceMs) => {
      await recorded;
      await reapMarkedProcesses({ marker, pgid, killGraceMs: graceMs, label: MANAGED_SERVER_LABEL, onWarning, inspector, groupPort: port });
    },
    once: ((event: 'error' | 'exit', listener: (...values: never[]) => void): void => {
      if (event === 'error') {
        const failed = listener as unknown as (error: Error) => void;
        child.once('error', failed);
        onExit(() => undefined, failed);
        return;
      }
      const exited = listener as unknown as (code: number | null, signal: NodeJS.Signals | null) => void;
      onExit(({ code, signal }) => exited(code, signal), () => undefined);
    }) as ManagedChild['once'],
  };
};

export type GroupSpawnOptions = GroupLaunchHost & { env: ChildEnv | undefined; markerDirectory: string; onWarning: WarningSink; inspector: ProcessInspector };

export const createGroupSpawn =
  ({ env, markerDirectory, onWarning, inspector, port: given, spawnProcess }: GroupSpawnOptions): SpawnFn =>
  async (file, args, protection) => {
    const port = given ?? hostProcessGroupPort();
    const marker = path.join(markerDirectory, randomUUID());
    fs.closeSync(fs.openSync(marker, 'w', 0o600));
    let launched: GroupLaunch;
    try {
      launched = await launchGroupLeader({ file, args, ...envOption(env), stdio: ['ignore', 'ignore', 'ignore'], protection, marker: { slot: MARKER_FD_INDEX, file: marker }, port, ...(spawnProcess === undefined ? {} : { spawnProcess }) });
    } catch (error) {
      fs.rmSync(marker, { force: true });
      throw error;
    }
    return groupChildOf(launched, marker, onWarning, inspector, port);
  };

export type ReapStaleGroupsOptions = { markerDirectory: string; graceMs: number; onWarning: WarningSink; signal: AbortSignal; inspector: ProcessInspector };

export const reapStaleGroups = async ({ markerDirectory, graceMs, onWarning, signal, inspector }: ReapStaleGroupsOptions): Promise<void> => {
  await reapMarkerDirectory({ dir: markerDirectory, killGraceMs: graceMs, label: MANAGED_SERVER_LABEL, onWarning, signal, inspector, occasion: 'startup' });
};
