import { execFile, spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { reapMarkedProcesses, reapMarkerDirectory, signalGroup } from '@momonga/foundation';
import type { ExecResult, ExecFn, FmChild, SpawnFn } from './fm-serve.ts';

export type ChildEnv = Readonly<Record<string, string>>;

const envOption = (env: ChildEnv | undefined): { env?: Record<string, string> } => (env === undefined ? {} : { env: { ...env } });

export const createExecFn =
  (env: ChildEnv | undefined): ExecFn =>
  (file, args) =>
    new Promise((resolve, reject) => {
      execFile(file, [...args], envOption(env), (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, stdout, stderr });
          return;
        }
        reject(error);
      });
    });

export { createExecWithStdin } from '@momonga/foundation';

export const createPlainSpawn =
  (env: ChildEnv | undefined): SpawnFn =>
  (file, args) => {
    const child = nodeSpawn(file, [...args], { ...envOption(env), stdio: 'ignore' });
    return {
      kill: async (signal) => child.kill(signal),
      once: child.once.bind(child) as FmChild['once'],
    };
  };

const MARKER_FD_INDEX = 3;

export type WarningSink = (message: string) => void;

const groupChildOf = (child: ChildProcess, marker: string, onWarning: WarningSink): FmChild => {
  const removeMarker = (): void => fs.rmSync(marker, { force: true });
  child.once('error', removeMarker);
  if (child.pid !== undefined) fs.writeFileSync(marker, `${child.pid}\n`);
  return {
    kill: async (signal = 'SIGTERM', stop) => {
      if (child.pid === undefined) return false;
      await signalGroup(child.pid, signal, undefined, stop);
      return true;
    },
    finalize: async (graceMs) => {
      await reapMarkedProcesses({ marker, pgid: child.pid, killGraceMs: graceMs, label: 'fm', onWarning });
    },
    once: child.once.bind(child) as FmChild['once'],
  };
};

export type GroupSpawnOptions = { env: ChildEnv | undefined; markerDirectory: string; onWarning: WarningSink };

export const createGroupSpawn =
  ({ env, markerDirectory, onWarning }: GroupSpawnOptions): SpawnFn =>
  (file, args) => {
    const marker = path.join(markerDirectory, randomUUID());
    const markerFd = fs.openSync(marker, 'w', 0o600);
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

export type ReapStaleGroupsOptions = { markerDirectory: string; graceMs: number; onWarning: WarningSink };

export const reapStaleFmGroups = async ({ markerDirectory, graceMs, onWarning }: ReapStaleGroupsOptions): Promise<void> => {
  await reapMarkerDirectory({ dir: markerDirectory, killGraceMs: graceMs, label: 'fm', onWarning });
};
