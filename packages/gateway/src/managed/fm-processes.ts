import { execFile, spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MINIMAL_CHILD_ENV_LC_PREFIX, MINIMAL_CHILD_ENV_NAMES, findHolders, holderGroups, reconcileProcessGroup, signalGroup } from '@momonga/foundation';
import type { ExecResult, ExecFn, FmChild, SpawnFn } from './fm-serve.ts';
import type { ExecWithStdinFn } from './fm-target.ts';

export const MINIMAL_CHILD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export type ChildEnv = Readonly<Record<string, string>>;

export const minimalChildEnv = (source: Readonly<Record<string, string | undefined>>): ChildEnv => {
  const env: Record<string, string> = {};
  for (const name of MINIMAL_CHILD_ENV_NAMES) {
    const value = name === 'PATH' ? MINIMAL_CHILD_PATH : source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith(MINIMAL_CHILD_ENV_LC_PREFIX) && value !== undefined) env[name] = value;
  }
  return env;
};

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

export const createExecWithStdin =
  (env: ChildEnv | undefined): ExecWithStdinFn =>
  (file, args, stdin, signal) =>
    new Promise<ExecResult>((resolve, reject) => {
      const child = nodeSpawn(file, [...args], { ...envOption(env), stdio: ['pipe', 'pipe', 'pipe'], signal });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.stdin.on('error', reject);
      child.once('error', reject);
      child.once('close', (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      child.stdin.end(stdin);
    });

export const createPlainSpawn =
  (env: ChildEnv | undefined): SpawnFn =>
  (file, args) =>
    nodeSpawn(file, [...args], { ...envOption(env), stdio: 'ignore' });

const MARKER_FD_INDEX = 3;

const SIGNAL_POLL_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ownGroupOf = async (): Promise<number | undefined> => (await holderGroups([process.pid]))[0];

const signalHolders = async (marker: string, graceMs: number): Promise<void> => {
  const signalAll = (holders: readonly number[], signal: NodeJS.Signals): void => {
    for (const pid of holders) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  };
  signalAll(await findHolders(marker), 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while ((await findHolders(marker)).length > 0 && Date.now() < deadline) await sleep(SIGNAL_POLL_MS);
  signalAll(await findHolders(marker), 'SIGKILL');
};

export type WarningSink = (message: string) => void;

type MarkedGroup = {
  marker: string;
  recorded: number | undefined;
  graceMs: number;
  ownGroup: number | undefined;
  onWarning: WarningSink;
};

const reapMarkedGroup = async ({ marker, recorded, graceMs, ownGroup, onWarning }: MarkedGroup): Promise<void> => {
  if (recorded !== undefined && recorded > 1 && recorded !== ownGroup) {
    const result = await reconcileProcessGroup({ pgid: recorded, marker }, { killGraceMs: graceMs });
    if (result.leftAloneGroup !== undefined) {
      onWarning(`fm marker ${marker}: group ${result.leftAloneGroup} is still alive but no marker holder is in it, so it was left alone`);
    }
    if (result.leftAlonePids.length > 0) {
      onWarning(`fm marker ${marker}: process ${result.leftAlonePids.join(', ')} dropped the marker but is still alive, so it was left alone`);
    }
    if (result.unsignalledPids.length > 0) {
      onWarning(`fm marker ${marker}: could not signal process ${result.unsignalledPids.join(', ')}`);
    }
  } else {
    await signalHolders(marker, graceMs);
  }
  const deadline = Date.now() + graceMs;
  let remaining = await findHolders(marker);
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(SIGNAL_POLL_MS);
    remaining = await findHolders(marker);
  }
  if (remaining.length > 0) {
    onWarning(`fm marker ${marker} kept: process ${remaining.join(', ')} still hold it after cleanup; the next start will retry`);
    return;
  }
  await fs.promises.rm(marker, { force: true });
};

const groupChildOf = (child: ChildProcess, marker: string, onWarning: WarningSink): FmChild => {
  const removeMarker = (): void => fs.rmSync(marker, { force: true });
  child.once('error', removeMarker);
  if (child.pid !== undefined) fs.writeFileSync(marker, `${child.pid}\n`);
  return {
    kill: (signal = 'SIGTERM') => {
      if (child.pid === undefined) return false;
      signalGroup(child.pid, signal);
      return true;
    },
    finalize: async (graceMs) => {
      await reapMarkedGroup({ marker, recorded: child.pid, graceMs, ownGroup: await ownGroupOf(), onWarning });
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

const recordedGroupOf = async (marker: string): Promise<number | undefined> => {
  const text = (await fs.promises.readFile(marker, 'utf8')).trim();
  return /^\d+$/.test(text) ? Number(text) : undefined;
};

export const reapStaleFmGroups = async ({ markerDirectory, graceMs, onWarning }: ReapStaleGroupsOptions): Promise<void> => {
  const ownGroup = await ownGroupOf();
  for (const name of await fs.promises.readdir(markerDirectory)) {
    const marker = path.join(markerDirectory, name);
    await reapMarkedGroup({ marker, recorded: await recordedGroupOf(marker), graceMs, ownGroup, onWarning });
  }
};
