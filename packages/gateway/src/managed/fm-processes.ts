import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createHostExec, groupRecordOutcome, recordMarkerGroup, reapMarkedProcesses, reapMarkerDirectory, signalGroup } from '@momonga/foundation';
import type { ExecFn } from './preconditions.ts';
import type { ManagedChild, SpawnFn } from './server.ts';

export type ChildEnv = Readonly<Record<string, string>>;

export const MANAGED_SERVER_LABEL = 'managed server';

const envOption = (env: ChildEnv | undefined): { env?: Record<string, string> } => (env === undefined ? {} : { env: { ...env } });

export const createExecFn = (env: ChildEnv | undefined): ExecFn => createHostExec(env);

export { createExecWithStdin } from '@momonga/foundation';

const MARKER_FD_INDEX = 3;

export type WarningSink = (message: string) => void;

const groupChildOf = (child: ChildProcess, marker: string, onWarning: WarningSink): ManagedChild => {
  const removeMarker = (): void => fs.rmSync(marker, { force: true });
  child.once('error', removeMarker);
  const recorded =
    child.pid === undefined
      ? Promise.resolve()
      : groupRecordOutcome(recordMarkerGroup(marker, child.pid), marker).then((notice) => {
          if (notice !== undefined) onWarning(notice);
        });
  return {
    kill: async (signal = 'SIGTERM', stop) => {
      if (child.pid === undefined) return false;
      await signalGroup(child.pid, signal, undefined, stop);
      return true;
    },
    finalize: async (graceMs) => {
      await recorded;
      await reapMarkedProcesses({ marker, pgid: child.pid, killGraceMs: graceMs, label: MANAGED_SERVER_LABEL, onWarning });
    },
    once: child.once.bind(child) as ManagedChild['once'],
  };
};

export type GroupSpawnOptions = { env: ChildEnv | undefined; markerDirectory: string; onWarning: WarningSink };

export const createGroupSpawn =
  ({ env, markerDirectory, onWarning }: GroupSpawnOptions): SpawnFn =>
  (file, args) => {
    const marker = path.join(markerDirectory, randomUUID());
    const creator = fs.openSync(marker, 'w', 0o600);
    let markerFd: number;
    try {
      markerFd = fs.openSync(marker, 'r');
    } catch (error) {
      fs.rmSync(marker, { force: true });
      throw error;
    } finally {
      fs.closeSync(creator);
    }
    const stdio: Array<'ignore' | number> = ['ignore', 'ignore', 'ignore'];
    stdio[MARKER_FD_INDEX] = markerFd;
    let child: ChildProcess;
    try {
      child = nodeSpawn(file, [...args], { ...envOption(env), detached: true, stdio });
    } catch (error) {
      fs.rmSync(marker, { force: true });
      throw error;
    } finally {
      fs.closeSync(markerFd);
    }
    return groupChildOf(child, marker, onWarning);
  };

export type ReapStaleGroupsOptions = { markerDirectory: string; graceMs: number; onWarning: WarningSink; signal: AbortSignal };

export const reapStaleGroups = async ({ markerDirectory, graceMs, onWarning, signal }: ReapStaleGroupsOptions): Promise<void> => {
  await reapMarkerDirectory({ dir: markerDirectory, killGraceMs: graceMs, label: MANAGED_SERVER_LABEL, onWarning, signal, occasion: 'startup' });
};
