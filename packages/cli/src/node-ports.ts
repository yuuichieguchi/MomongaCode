import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';
import { isSea } from 'node:sea';
import { nodeEvalFiles, nodeWorkspaceFiles } from '@momonga/eval';
import type { WorkspaceProbe } from '@momonga/eval';
import {
  EntryLockHeldError,
  LIFELINE_FD,
  claimNewEntrySync,
  createBrowserOpener,
  createExecWithStdin,
  createHostExec,
  createPlatformSecretStore,
  guardStandardStreams,
  hostKernelLock,
  minimalChildEnv,
  nodeFileSystem,
  nodeFileSystemSync,
  systemClock,
  systemRandom,
  systemTiming,
  writeFileAtomically,
  writeFileAtomicallySync,
  launchApart,
} from '@momonga/foundation';
import type { GuardedStandardStreams, HeldKernelLock, HelperHost, LaunchProgram, ProcessPort } from '@momonga/foundation';
import { sourceBuiltWindowsKeeper } from './keeper/source.ts';
import type { SourceKeeperFiles } from './keeper/source.ts';
import { createHandoverHost } from './handover/host.ts';
import type { RecordFiles } from './handover/host.ts';
import { HANDOVER_RECORD_MAX_BYTES } from './handover/record.ts';
import type { AcpInput, CliClock, CliFiles, CliPorts, SelfExecutable, SpawnDetached } from './ports.ts';

const ABSENT_FILE = '\u0001absent';

const probedContentOf = async (file: string): Promise<Buffer | null> => {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const probedFilesUnder = async (root: string, relative = ''): Promise<string[]> => {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      return entry.isDirectory() ? probedFilesUnder(root, child) : Promise.resolve([child]);
    }),
  );
  return nested.flat();
};

const sortedNames = (names: Iterable<string>): string[] => [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

export const createWorkspaceProbe = (env: Readonly<Record<string, string>>): WorkspaceProbe => ({
  run: (command, timeoutMs, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, { shell: true, cwd, env: { ...env }, stdio: 'ignore', windowsHide: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, timedOut });
      });
    }),

  digest: async (cwd, paths) => {
    const hash = crypto.createHash('sha256');
    for (const relative of sortedNames(paths)) {
      const content = await probedContentOf(path.join(cwd, relative));
      hash.update(`${relative}\0`);
      hash.update(content ?? ABSENT_FILE);
      hash.update('\0');
    }
    return hash.digest('hex');
  },

  changedPaths: async (cwd, baseDir) => {
    const changed: string[] = [];
    for (const relative of sortedNames(new Set([...(await probedFilesUnder(cwd)), ...(await probedFilesUnder(baseDir))]))) {
      const [here, there] = await Promise.all([probedContentOf(path.join(cwd, relative)), probedContentOf(path.join(baseDir, relative))]);
      if (here === null || there === null ? here !== there : !here.equals(there)) changed.push(relative);
    }
    return changed;
  },
});

export const launchProgram: LaunchProgram = (file, args) =>
  new Promise((resolve, reject) => {
    const child = launchApart(file, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    child.unref();
  });

const LONGEST_HOST_TIMER_MS = 2_147_483_647;

const sleepOnce = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  let left = ms;
  for (; left > LONGEST_HOST_TIMER_MS; left -= LONGEST_HOST_TIMER_MS) await sleepOnce(LONGEST_HOST_TIMER_MS, signal);
  await sleepOnce(left, signal);
};

export const nodeClock: CliClock = { now: () => systemClock.now(), sleep };

export const nodeProcess: ProcessPort = { pid: process.pid, uid: () => process.getuid?.(), kill: (pid, signal) => void process.kill(pid, signal) };

export const nodeHelperHost = (): Omit<HelperHost, 'args'> => ({ env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });

export const nodeFiles: CliFiles = {
  ...nodeEvalFiles,
  ...nodeWorkspaceFiles,
  copyTreeVerbatim: (from, to) => fs.cp(from, to, { recursive: true, verbatimSymlinks: true }),
  readFile: nodeFileSystem.readFile,
  readTextFile: nodeFileSystem.readTextFile,
  stat: nodeFileSystem.stat,
  mkdir: nodeFileSystem.mkdir,
  mkdirPrivate: nodeFileSystem.mkdirPrivate,
  mkdtemp: nodeFileSystem.mkdtemp,
  rm: nodeFileSystem.rm,
  rename: nodeFileSystem.rename,
  readTextIfPresent: async (file) => {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  appendText: async (file, text, modes) => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: modes.directory });
    await fs.appendFile(file, text, { mode: modes.file });
  },
  exists: async (file) => {
    try {
      await nodeFileSystem.stat(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  writeTextAtomically: async (file, text, mode) => {
    await writeFileAtomically(nodeFileSystem, systemRandom, file, text, { mode });
  },
};

export const WINDOWS_KEEPER_BUILD_SCRIPT = path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'windows-keeper.ts');

export const nodeSourceKeeperFiles: SourceKeeperFiles = {
  exists: (file) => existsSync(file),
  read: (file) => readFileSync(file),
  mkdirPrivate: (directory) => void mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
  write: (file, bytes) => writeFileSync(file, bytes, { mode: PRIVATE_DIRECTORY_MODE }),
  rename: (from, to) => renameSync(from, to),
  remove: (target) => rmSync(target, { recursive: true, force: true }),
};

export const runKeeperBuild = (script: string, workDir: string): number | null => {
  const run = spawnSync(process.execPath, [script, '--work-dir', workDir], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  if (run.error !== undefined) throw run.error;
  return run.status;
};

export const hostSourceBuiltWindowsKeeper = (executablesRoot: string): (() => string) =>
  sourceBuiltWindowsKeeper({ script: WINDOWS_KEEPER_BUILD_SCRIPT, executablesRoot, build: runKeeperBuild, files: nodeSourceKeeperFiles, random: systemRandom });

export const nodeSpawnDetached: SpawnDetached = (spec) => {
  const child = launchApart(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.lifeline === true ? ['ignore', 'ignore', 'ignore', 'pipe'] : 'ignore',
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.unref();
  const lifeline = spec.lifeline === true ? child.stdio[LIFELINE_FD] : undefined;
  if (lifeline instanceof net.Socket) {
    lifeline.unref();
    lifeline.on('error', () => undefined);
    return { exit, releaseLifeline: () => void lifeline.destroy() };
  }
  return { exit };
};

export const nodeSelf = (argv: readonly string[], singleBinary: () => boolean): SelfExecutable => {
  if (singleBinary()) return { kind: 'single-binary', execPath: process.execPath };
  const script = argv[1];
  if (script === undefined) throw new Error('cannot locate the momonga entry script: process.argv[1] is empty');
  return { kind: 'script', execPath: process.execPath, script: path.resolve(script) };
};

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const heldRecords = new Map<string, HeldKernelLock>();

const claimRecord = (file: string): HeldKernelLock | undefined => {
  const mine = heldRecords.get(file);
  if (mine !== undefined) return mine;
  try {
    return claimNewEntrySync(hostKernelLock(), file, 'sidecar');
  } catch (error) {
    if (error instanceof EntryLockHeldError) return undefined;
    throw error;
  }
};

const dropRecord = (file: string, held: HeldKernelLock | undefined): void => {
  heldRecords.delete(file);
  try {
    rmSync(file, { force: true });
  } catch (error) {
    held?.release();
    throw error;
  }
  held?.dispose();
};

export const nodeRecordFiles: RecordFiles = {
  read: (file) => {
    if (statSync(file).size > HANDOVER_RECORD_MAX_BYTES) throw new Error('it is larger than 1 MiB');
    return readFileSync(file, 'utf8');
  },
  write: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const held = claimRecord(file);
    if (held === undefined) throw new EntryLockHeldError(file);
    heldRecords.set(file, held);
    try {
      writeFileAtomicallySync(nodeFileSystemSync, systemRandom, file, text, { mode: PRIVATE_FILE_MODE });
    } catch (error) {
      heldRecords.delete(file);
      held.dispose();
      throw error;
    }
  },
  remove: (file) => {
    dropRecord(file, claimRecord(file));
  },
};

type Arrival = { resolve(kind: 'bytes' | 'end'): void; reject(error: unknown): void };

export const acpInputOf = (stdin: Readable): AcpInput => {
  let ended = false;
  let failure: { error: unknown } | undefined;
  let waiting: Arrival[] = [];
  const settle = (): void => {
    if (failure === undefined && stdin.readableLength === 0 && !ended) return;
    const arrivals = waiting;
    waiting = [];
    for (const arrival of arrivals) {
      if (failure !== undefined) arrival.reject(failure.error);
      else arrival.resolve(stdin.readableLength > 0 ? 'bytes' : 'end');
    }
  };
  stdin.on('readable', () => {
    if (stdin.readableLength === 0) stdin.read();
    settle();
  });
  stdin.on('end', () => {
    ended = true;
    settle();
  });
  stdin.on('error', (error) => {
    failure = { error };
    settle();
  });
  return {
    take: () => {
      const chunk: unknown = stdin.read();
      if (chunk === null) return undefined;
      if (!(chunk instanceof Uint8Array)) throw new Error('standard input gave text where the Agent Client Protocol reads bytes');
      return chunk;
    },
    arrival: () =>
      new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        settle();
      }),
  };
};

export const nodePorts = (version: string, interrupt: AbortSignal, streams: GuardedStandardStreams = guardStandardStreams(process)): CliPorts => {
  const self = nodeSelf(process.argv, isSea);
  return {
    version,
    interrupt,
    platform: process.platform,
    env: process.env,
    cwd: process.cwd(),
    home: process.env['HOME'] ?? os.homedir(),
    stdin: { isTerminal: process.stdin.isTTY === true, bytes: () => process.stdin },
    stdout: streams.stdout,
    stderr: streams.stderr,
    clock: nodeClock,
    timers: systemTiming,
    random: Math.random,
    uuid: systemRandom.uuid,
    process: nodeProcess,
    tmpdir: os.tmpdir(),
    self,
    handover: createHandoverHost({ version, pid: process.pid, self, argv: process.argv.slice(2), env: process.env, execArgv: process.execArgv, files: nodeRecordFiles }),
    spawnDetached: nodeSpawnDetached,
    terminal: process.stdin.isTTY && process.stdout.isTTY ? { stdin: process.stdin, stdout: process.stdout } : undefined,
    files: nodeFiles,
    exec: createHostExec(minimalChildEnv(process.env)),
    probe: createWorkspaceProbe(minimalChildEnv(process.env)),
    openUrl: createBrowserOpener({ env: process.env, launch: launchProgram }),
    secretStore: () => createPlatformSecretStore(createExecWithStdin(undefined), process.env),
    acpStdio: () => ({ input: acpInputOf(process.stdin), output: Writable.toWeb(process.stdout) }),
  };
};
