import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyWorkspaceStep } from '@momonga/eval';
import { ensureMomongaDirs, inspectProcessLock, isProcessAlive } from '@momonga/foundation';
import { DAEMON_POLL_INTERVAL_MS } from '../constants.ts';
import { daemonStopBoundMs, ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime, environmentSnapshot } from '../run/open-session.ts';
import { pathsOf } from '../paths.ts';
import { OWNER_FILE, ROOT_PREFIX } from './context-host.ts';
import type { ContextHostEffects } from './context-host.ts';

export const SHORT_TEMP_BASE = '/tmp';

export const MAX_TIMER_MS = 2_147_483_647;

const KILL_WAIT_MS = 5_000;

const isMissingProcess = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ESRCH';

const signalProcess = (pid: number, signal: NodeJS.Signals, group: boolean): void => {
  try {
    process.kill(group ? -pid : pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
};

export const shortTempBase = (platform: NodeJS.Platform): string => (platform === 'win32' ? os.tmpdir() : SHORT_TEMP_BASE);

const gone = async (ports: Pick<CliPorts, 'clock'>, pid: number, boundMs: number): Promise<boolean> => {
  const until = ports.clock.now() + boundMs;
  while (isProcessAlive(pid)) {
    if (ports.clock.now() >= until) return false;
    await ports.clock.sleep(DAEMON_POLL_INTERVAL_MS);
  }
  return true;
};

const PRIVATE_DIRECTORY_MODE = 0o700;

export const copyProbeRecord = async (files: Pick<CliPorts['files'], 'readTextIfPresent' | 'writeText'>, from: string, to: string, target: string): Promise<boolean> => {
  const text = await files.readTextIfPresent(path.join(from, `${target}.json`));
  if (text === undefined) return false;
  await fs.mkdir(to, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await files.writeText(path.join(to, `${target}.json`), text);
  return true;
};

const ownerOf = (text: string | undefined): number | undefined => (text !== undefined && /^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined);

export const nodeContextEffects = (ports: CliPorts): ContextHostEffects => ({
  platform: ports.platform,
  env: ports.env,
  ownerPid: process.pid,
  isAlive: isProcessAlive,
  readSecret: (name, signal) => ports.secretStore().read(name, signal),
  copyProbeRecord: async (target, paths) => void (await copyProbeRecord(ports.files, pathsOf(ports).probe, paths.probe, target)),
  listRoots: async () => {
    const base = shortTempBase(ports.platform);
    return (await ports.files.listFiles(base)).filter((entry) => path.basename(entry).startsWith(ROOT_PREFIX));
  },
  readOwner: async (root) => ownerOf(await ports.files.readTextIfPresent(path.join(root, OWNER_FILE))),
  sessionEnv: () => environmentSnapshot(ports),
  makeRoot: () => ports.files.makeTempDirectory(ROOT_PREFIX, shortTempBase(ports.platform)),
  prepare: (paths) => ensureMomongaDirs(paths),
  writeFile: async (file, text) => {
    await ports.files.ensureDirectory(path.dirname(file));
    await ports.files.writeText(file, text);
  },
  makeDirectory: (directory) => ports.files.ensureDirectory(directory),
  canonical: (directory) => fs.realpath(directory),
  startDaemon: async (root, paths, env) => (await ensureDaemon({ ...ports, home: root, env }, paths, { lifeline: true })).pid,
  daemonHolder: async (paths) => {
    const lock = await inspectProcessLock(paths.locks.supervisor);
    return lock.state === 'held' ? lock.pid : undefined;
  },
  terminate: async (pid) => {
    signalProcess(pid, 'SIGTERM', false);
    if (await gone(ports, pid, daemonStopBoundMs())) return;
    signalProcess(pid, 'SIGKILL', true);
    signalProcess(pid, 'SIGKILL', false);
    if (!(await gone(ports, pid, KILL_WAIT_MS))) throw new Error(`the daemon with pid ${pid} did not stop after SIGTERM and SIGKILL`);
  },
  remove: (directory) => ports.files.removeTree(directory),
  connect: (paths) => connectRuntime(paths),
  applyStep: (cwd, step) => applyWorkspaceStep(cwd, step),
  after: (milliseconds, signal) =>
    new Promise<void>((resolve) => {
      if (milliseconds > MAX_TIMER_MS) return;
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    }),
});
