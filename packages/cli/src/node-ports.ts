import { syncPaths } from '@momonga/foundation';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';
import { isSea } from 'node:sea';
import { loadSettings } from '@momonga/config';
import type { CredentialRules, ResolvedModels, ResolvedSettings, SandboxSetting } from '@momonga/config';
import { createWorkspaceProbe, nodeEvalFiles, nodeWorkspaceFiles } from '@momonga/eval';
import type { CommandSandbox, WorkspaceProbe } from '@momonga/eval';
import {
  EntryLockHeldError,
  LIFELINE_FD,
  claimNewEntrySync,
  createBrowserOpener,
  createExecWithStdin,
  createHostExec,
  createPlatformSecretStore,
  ensureBundledLinuxSocketGuard,
  guardStandardStreams,
  momongaLayout,
  resolveLayoutLocks,
  minimalChildEnv,
  nodeFileSystem,
  pidNamespaceOf,
  nodeFileSystemSync,
  systemClock,
  systemRandom,
  systemTiming,
  writeFileAtomically,
  writeFileAtomicallySync,
  hostProcessGroupPort,
  launchApart,
  personCapabilityOf,
  endpointScopeOf,
} from '@momonga/foundation';
import type { FileSystem, GuardedStandardStreams, HeldKernelLock, HelperHost, LaunchProgram, ProcessGroupPort, SandboxNetworkSetting, ProcessPort, KernelLockMechanism, EndpointScope } from '@momonga/foundation';
import { prebuiltLinuxSocketGuard, sourceBuiltWindowsKeeper } from './keeper/source.ts';
import type { SourceKeeperFiles } from './keeper/source.ts';
import { createHandoverHost } from './handover/host.ts';
import type { RecordFiles } from './handover/host.ts';
import { HANDOVER_RECORD_MAX_BYTES } from './handover/record.ts';
import type { AcpInput, CliClock, CliFiles, CliPorts, SelfExecutable, SpawnDetached } from './ports.ts';

export const launchProgramThrough =
  (start: typeof launchApart): LaunchProgram =>
  (file, args) =>
    new Promise((resolve, reject) => {
      const child = start(file, args, { stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
      child.unref();
    });

export const launchProgram: LaunchProgram = launchProgramThrough(launchApart);

export type WorkspaceSandboxInput = {
  home: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  sandbox: SandboxSetting;
  network: SandboxNetworkSetting;
  warn(text: string): void;
  credentialNaming: { models: Pick<ResolvedModels, 'connections'>; forges?: ResolvedSettings['forges']; credentials: CredentialRules };
};

export const nodeWorkspaceSandbox = (input: WorkspaceSandboxInput | (() => Promise<WorkspaceSandboxInput>)): CommandSandbox => {
  let sandbox: Promise<CommandSandbox> | undefined;
  return {
    start: async (command, workspace, env, signal) => {
      sandbox ??= Promise.all([import('@momonga/runtime'), typeof input === 'function' ? input() : input]).then(([{ workspaceCommandSandbox }, resolved]) => workspaceCommandSandbox(resolved));
      return (await sandbox).start(command, workspace, env, signal);
    },
  };
};

const settingsWorkspaceSandbox = (home: string, cwd: string, signal: AbortSignal, warn: (text: string) => void) => async (): Promise<WorkspaceSandboxInput> => {
  const { settings } = await loadSettings({ env: process.env, home, projectDir: cwd, cli: {}, trust: { isTrusted: () => false }, signal });
  return { home, platform: process.platform, env: process.env, signal, sandbox: settings.sandbox, network: settings.sandboxNetwork, warn, credentialNaming: { models: settings.models, forges: settings.forges, credentials: settings.credentials } };
};

export const nodeWorkspaceProbeOf =
  (sandbox: CommandSandbox, groups: ProcessGroupPort) =>
  (env: Readonly<Record<string, string>>): WorkspaceProbe =>
    createWorkspaceProbe({ env, sandbox, files: nodeWorkspaceFiles, timing: systemTiming, groups });

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

type LockSource = () => KernelLockMechanism;

const layoutLockOf = (home: string, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): LockSource => {
  let resolved: KernelLockMechanism | undefined;
  return () => (resolved ??= resolveLayoutLocks(momongaLayout(home, platform, env)).mechanism);
};

export const nodeFiles: Omit<CliFiles, 'writeTextAtomically'> = {
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
};

export const nodeFilesLockedBy = (lock: LockSource): CliFiles => ({
  ...nodeFiles,
  writeTextAtomically: async (file, text, mode) => {
    await writeFileAtomically(nodeFileSystem, systemRandom, file, text, { mode, lock: lock() });
  },
});

export const WINDOWS_KEEPER_BUILD_SCRIPT = path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'windows-keeper.ts');

export const nodeSourceKeeperFiles: SourceKeeperFiles = {
  ...nodeFileSystem,
  exists: (file) => existsSync(file),
  read: (file) => readFileSync(file),
};

export const runKeeperBuild = (script: string, workDir: string): number | null => {
  const run = spawnSync(process.execPath, [script, '--work-dir', workDir], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  if (run.error !== undefined) throw run.error;
  return run.status;
};

export const hostSourceBuiltWindowsKeeper = (executablesRoot: string, lock: KernelLockMechanism): (() => Promise<() => string>) =>
  sourceBuiltWindowsKeeper({ script: WINDOWS_KEEPER_BUILD_SCRIPT, executablesRoot, build: runKeeperBuild, files: nodeSourceKeeperFiles, random: systemRandom, lock });

export const LINUX_SOCKET_GUARD_BUILD_SCRIPT = path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'linux-socket-guard.ts');

export const LINUX_SOCKET_GUARD_BUILT_DIRECTORY = path.resolve(import.meta.dirname, '..', '..', '..', 'dist', 'linux-socket-guard');

export const hostPlatform = (): NodeJS.Platform => process.platform;

export const hostExtractedLinuxSocketGuard = (asset: (name: string) => Uint8Array, executablesRoot: string, lock: KernelLockMechanism): Promise<string> =>
  ensureBundledLinuxSocketGuard({ asset, executablesRoot, random: systemRandom, files: nodeFileSystem, lock });

export const hostPrebuiltLinuxSocketGuard = (executablesRoot: string, lock: KernelLockMechanism): (() => Promise<() => string>) =>
  prebuiltLinuxSocketGuard({ builtDirectory: LINUX_SOCKET_GUARD_BUILT_DIRECTORY, builder: LINUX_SOCKET_GUARD_BUILD_SCRIPT, executablesRoot, files: nodeSourceKeeperFiles, random: systemRandom, lock });

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

const claimRecord = (lock: KernelLockMechanism, file: string): HeldKernelLock | undefined => {
  const mine = heldRecords.get(file);
  if (mine !== undefined) return mine;
  try {
    return claimNewEntrySync(lock, file, 'sidecar');
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

export const nodeRecordFiles = (lock: LockSource): RecordFiles => ({
  read: (file) => {
    if (statSync(file).size > HANDOVER_RECORD_MAX_BYTES) throw new Error('it is larger than 1 MiB');
    return readFileSync(file, 'utf8');
  },
  write: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const held = claimRecord(lock(), file);
    if (held === undefined) throw new EntryLockHeldError(file);
    heldRecords.set(file, held);
    try {
      writeFileAtomicallySync(nodeFileSystemSync, systemRandom, file, text, { mode: PRIVATE_FILE_MODE, lock: lock() });
    } catch (error) {
      heldRecords.delete(file);
      held.dispose();
      throw error;
    }
  },
  remove: (file) => {
    dropRecord(file, claimRecord(lock(), file));
  },
  handOver: (file) => {
    const held = heldRecords.get(file);
    if (held === undefined) throw new Error(`this process holds no record ${file} to hand over`);
    heldRecords.delete(file);
    held.release();
  },
});

type Arrival = { resolve(kind: 'bytes' | 'end'): void; reject(error: unknown): void };

export const acpInputOf = (stdin: Readable): AcpInput => {
  let ended = false;
  let failure: { error: unknown } | undefined;
  let waiting: Arrival[] = [];
  let queued: Uint8Array[] = [];
  const settle = (): void => {
    if (failure === undefined && queued.length === 0 && !ended) return;
    const arrivals = waiting;
    waiting = [];
    for (const arrival of arrivals) {
      if (failure !== undefined) arrival.reject(failure.error);
      else arrival.resolve(queued.length > 0 ? 'bytes' : 'end');
    }
  };
  const onData = (chunk: unknown): void => {
    if (!(chunk instanceof Uint8Array)) {
      failure = { error: new Error('standard input gave text where the Agent Client Protocol reads bytes') };
    } else queued.push(chunk);
    settle();
  };
  const onEnd = (): void => {
    ended = true;
    settle();
  };
  const onError = (error: unknown): void => {
    failure = { error };
    settle();
  };
  stdin.on('data', onData);
  stdin.on('end', onEnd);
  stdin.on('error', onError);
  return {
    take: () => {
      if (queued.length === 0) return undefined;
      const whole = Buffer.concat(queued);
      queued = [];
      return whole;
    },
    arrival: () =>
      new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        settle();
      }),
    pause: () => void stdin.pause(),
    resume: () => void stdin.resume(),
    release: () => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      stdin.pause();
    },
  };
};

export const processHome = (): string => process.env['HOME'] ?? os.homedir();

export const daemonFileSystem: FileSystem = nodeFileSystem;

export const nodePorts = (version: string, interrupt: AbortSignal, home: string, streams: GuardedStandardStreams = guardStandardStreams(process)): CliPorts => {
  const self = nodeSelf(process.argv, isSea);
  const lock = layoutLockOf(home, process.platform, process.env);
  const endpointScopes = new Map<string, Promise<EndpointScope>>();
  return {
    version,
    interrupt,
    platform: process.platform,
    env: process.env,
    cwd: process.cwd(),
    home,
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
    handover: createHandoverHost({ version, parties: async () => ({ writer: process.pid, reader: process.pid, namespace: await pidNamespaceOf(nodeFileSystem) }), self, argv: process.argv.slice(2), env: process.env, execArgv: process.execArgv, files: nodeRecordFiles(lock) }),
    spawnDetached: nodeSpawnDetached,
    terminal: process.stdin.isTTY && process.stdout.isTTY ? { stdin: process.stdin, stdout: process.stdout, colourOff: () => Reflect.set(process.env, 'FORCE_COLOR', '0') } : undefined,
    files: nodeFilesLockedBy(lock),
    exec: createHostExec(minimalChildEnv(process.env)),
    probe: nodeWorkspaceProbeOf(nodeWorkspaceSandbox(settingsWorkspaceSandbox(home, process.cwd(), interrupt, (text) => streams.stderr.write(`${text}\n`))), hostProcessGroupPort()),
    openUrl: createBrowserOpener({ env: process.env, launch: launchProgram, files: nodeFileSystem }),
    secretStore: () => createPlatformSecretStore(createExecWithStdin(undefined), process.env, { platform: process.platform, uid: process.getuid?.(), realPathOf: (file) => syncPaths.canonicalPath(file) }),
    personCapability: (of) => personCapabilityOf({ files: nodeFileSystem, random: systemRandom, lock: lock() }, of),
    endpointScope: (paths) => {
      const known = endpointScopes.get(paths.run);
      if (known !== undefined) return known;
      const read = endpointScopeOf(paths, process.platform, { files: nodeFileSystem, random: systemRandom, lock: lock() });
      endpointScopes.set(paths.run, read);
      return read;
    },
    acpStdio: () => ({ input: acpInputOf(process.stdin), output: Writable.toWeb(process.stdout) }),
  };
};
