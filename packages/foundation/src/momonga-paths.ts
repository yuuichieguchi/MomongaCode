import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import util from 'node:util';
import { ensureWindowsPrivateTree, modeIsPrivate, noFollowFlag, directoryFlag, ownerProblem } from './platform/privacy.ts';
import { nodeCommandRunner } from './platform/command-runner.ts';
import type { CommandRunner } from './platform/command-runner.ts';
import { assertSocketPathLength, isPipePath, pipePathFor, refuseUnbindableUnixSocketPath } from './socket-path.ts';

export interface MomongaPaths {
  root: string;
  settingsFile: string;
  run: string;
  current: string;
  generationLock: string;
  callLocks: string;
  grepArguments: string;
  lockProof: string;
  markers: { root: string; tools: string; mcp: string; targets: string; daemons: string };
  state: string;
  databases: { runtime: string; gateway: string };
  traces: { dir: string; gateway: string; runtime: string };
  gatewayKey: string;
  probe: string;
  planSessions: string;
  planHost: string;
  planActive: string;
  logs: string;
  logFiles: { supervisor: string; gateway: string; runtime: string };
  projects: string;
  skills: string;
  agents: string;
  launcher: string;
  keychains: string;
  cacheBase: string;
  executables: string;
  tmp: { root: string; spawn: string; sessions: string };
}

const pathFor = (platform: NodeJS.Platform): path.PlatformPath => (platform === 'win32' ? path.win32 : path.posix);

const absoluteOrUndefined = (candidate: string | undefined, flavor: path.PlatformPath): string | undefined =>
  candidate === undefined || !flavor.isAbsolute(candidate) ? undefined : candidate;

const cacheBaseOf = (home: string, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): string => {
  const flavor = pathFor(platform);
  if (platform === 'darwin') return flavor.join(home, 'Library', 'Caches', 'momonga');
  if (platform === 'win32') return flavor.join(absoluteOrUndefined(env['LOCALAPPDATA'], flavor) ?? flavor.join(home, 'AppData', 'Local'), 'momonga');
  return flavor.join(absoluteOrUndefined(env['XDG_CACHE_HOME'], flavor) ?? flavor.join(home, '.cache'), 'momonga');
};

const keychainsOf = (home: string, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): string => {
  const flavor = pathFor(platform);
  if (platform === 'darwin') return flavor.join(home, 'Library', 'Keychains');
  if (platform === 'win32') return flavor.join(absoluteOrUndefined(env['APPDATA'], flavor) ?? flavor.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Credentials');
  return flavor.join(absoluteOrUndefined(env['XDG_DATA_HOME'], flavor) ?? flavor.join(home, '.local', 'share'), 'keyrings');
};

export const adapterSocketPath = (home: string, name: string, platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? pipePathFor(home, name) : pathFor(platform).join(home, '.momonga', 'run', `${name}.sock`);

export const FIRST_GENERATION = 1;

export type GenerationRole = 'gateway' | 'runtime' | 'supervisor';

export const GENERATION_ROLES: readonly GenerationRole[] = ['gateway', 'runtime', 'supervisor'];

export type GenerationSockets = Record<GenerationRole, string>;

export type GenerationLayout = {
  generation: number;
  dir: string;
  sockets: GenerationSockets;
  locks: Record<GenerationRole, string>;
};

const byRole = (value: (role: GenerationRole) => string): Record<GenerationRole, string> => ({
  gateway: value('gateway'),
  runtime: value('runtime'),
  supervisor: value('supervisor'),
});

export const generationLayout = (home: string, generation: number, platform: NodeJS.Platform = process.platform): GenerationLayout => {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new RangeError(`a generation number must be a positive integer, got ${generation}`);
  const join = pathFor(platform).join;
  const dir = join(home, '.momonga', 'run', `g${generation}`);
  return {
    generation,
    dir,
    sockets: byRole((role) => (platform === 'win32' ? pipePathFor(home, `g${generation}-${role}`) : join(dir, `${role}.sock`))),
    locks: byRole((role) => join(dir, `${role}.lock`)),
  };
};

export const momongaLayout = (
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): MomongaPaths => {
  const flavor = pathFor(platform);
  const join = flavor.join;
  const root = join(home, '.momonga');
  const run = join(root, 'run');
  const state = join(root, 'state');
  const markers = join(run, 'markers');
  const traces = join(state, 'traces');
  const cacheBase = cacheBaseOf(home, platform, env);
  const tmp = join(cacheBase, 'tmp');
  return {
    root,
    settingsFile: join(root, 'settings.json'),
    run,
    current: join(run, 'current'),
    generationLock: join(run, 'generation.lock'),
    callLocks: join(run, 'call-locks'),
    grepArguments: join(run, 'grep-arguments'),
    lockProof: join(run, 'lock-proof'),
    markers: {
      root: markers,
      tools: join(markers, 'tools'),
      mcp: join(markers, 'mcp'),
      targets: join(markers, 'targets'),
      daemons: join(markers, 'daemons'),
    },
    state,
    databases: { runtime: join(state, 'runtime.db'), gateway: join(state, 'gateway.db') },
    traces: { dir: traces, gateway: join(traces, 'gateway.db'), runtime: join(traces, 'runtime.db') },
    gatewayKey: join(state, 'gateway.key'),
    probe: join(state, 'probe'),
    planSessions: join(state, 'plan-sessions'),
    planHost: join(state, 'plan-host.json'),
    planActive: join(state, 'plan-active.json'),
    logs: join(root, 'logs'),
    logFiles: {
      supervisor: join(root, 'logs', 'supervisor.log'),
      gateway: join(root, 'logs', 'gateway.log'),
      runtime: join(root, 'logs', 'runtime.log'),
    },
    projects: join(root, 'projects'),
    skills: join(root, 'skills'),
    agents: join(root, 'agents'),
    launcher: platform === 'win32' ? join(home, 'AppData', 'Local', 'Programs', 'momonga', 'momonga.exe') : join(home, '.local', 'bin', 'momonga'),
    keychains: keychainsOf(home, platform, env),
    cacheBase,
    executables: join(cacheBase, 'executables'),
    tmp: { root: tmp, spawn: join(tmp, 'spawn'), sessions: join(tmp, 'sessions') },
  };
};

export const rotatedLogPath = (file: string, generation: number): string => `${file}.${generation}`;

export const momongaPaths = (
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): MomongaPaths => momongaLayout(home, platform, env);

export type PlatformDirectoryPorts = {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal | undefined;
};

export class MomongaDirectoryError extends Error {
  readonly directory: string;

  constructor(directory: string, cause: NodeJS.ErrnoException) {
    super(`The directory ${directory} could not be created: ${reasonOf(cause)}`, { cause });
    this.directory = directory;
  }
}

const reasonOf = (error: NodeJS.ErrnoException): string =>
  error.errno === undefined || error.code === undefined ? error.message : `${util.getSystemErrorMessage(error.errno)} (${error.code})`;

const createDirectory = async (directory: string, options: { mode: number } | { recursive: true }): Promise<void> => {
  try {
    await fs.mkdir(directory, options);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'EEXIST' && !('recursive' in options)) return;
    throw new MomongaDirectoryError(failure.path ?? directory, failure);
  }
};

const ensurePrivateDirectory = async (directory: string, platform: NodeJS.Platform): Promise<void> => {
  let stat = await lstatIfPresent(directory);
  if (stat === undefined) {
    await createDirectory(directory, { mode: 0o700 });
    stat = await fs.lstat(directory);
  }
  if (stat.isSymbolicLink()) throw new Error(`${directory} is a symlink; refusing to use it`);
  if (!stat.isDirectory()) throw new Error(`${directory} exists and is not a directory`);
  const owner = ownerProblem(stat, platform);
  if (owner !== undefined) {
    throw new Error(`${directory} is owned by uid ${owner.found}, but the current user is uid ${owner.expected}; the directory must be owned by the current user`);
  }
  if (!modeIsPrivate(stat, 'directory', platform)) await fs.chmod(directory, 0o700);
};

export type RoleEndpoint = { socketPath: string; lockPath: string };

export const roleEndpoint = (layout: GenerationLayout, role: GenerationRole): RoleEndpoint => ({ socketPath: layout.sockets[role], lockPath: layout.locks[role] });

export const ensureMomongaDirs = async (paths: MomongaPaths, ports: PlatformDirectoryPorts = {}): Promise<void> => {
  const platform = ports.platform ?? process.platform;
  await createDirectory(path.dirname(paths.root), { recursive: true });
  for (const directory of [
    paths.root,
    paths.run,
    paths.callLocks,
    paths.lockProof,
    paths.markers.root,
    paths.markers.tools,
    paths.markers.mcp,
    paths.markers.targets,
    paths.markers.daemons,
    paths.state,
    paths.traces.dir,
    paths.probe,
    paths.logs,
    paths.projects,
    paths.skills,
  ]) {
    await ensurePrivateDirectory(directory, platform);
  }
  await createDirectory(path.dirname(paths.cacheBase), { recursive: true });
  for (const directory of [paths.cacheBase, paths.tmp.root, paths.tmp.spawn, paths.tmp.sessions]) {
    await ensurePrivateDirectory(directory, platform);
  }
  if (platform === 'win32') {
    const windows = { run: ports.run ?? nodeCommandRunner, env: ports.env ?? process.env, signal: ports.signal };
    await ensureWindowsPrivateTree(paths.root, windows);
    await ensureWindowsPrivateTree(paths.cacheBase, windows);
  }
};

export const ensureGenerationDirs = async (paths: MomongaPaths, generation: number): Promise<void> => {
  const layout = generationLayout(path.dirname(paths.root), generation);
  await ensurePrivateDirectory(layout.dir, process.platform);
  const sockets = Object.values(layout.sockets);
  for (const socket of sockets) assertSocketPathLength(socket);
  await Promise.all(sockets.filter((socket) => !isPipePath(socket)).map((socket) => refuseUnbindableUnixSocketPath(socket)));
};

export class SessionTmpDirError extends Error {}

const assertSessionId = (sessionId: string): void => {
  if (sessionId === '' || sessionId === '.' || sessionId === '..' || /[/\\\0]/.test(sessionId)) {
    throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  }
};

const assertOwnedDirectory = (directory: string, stat: fsSync.Stats, uid: number): void => {
  if (stat.isSymbolicLink()) throw new SessionTmpDirError(`${directory} is a symlink; refusing to use it`);
  if (!stat.isDirectory()) throw new SessionTmpDirError(`${directory} exists and is not a directory`);
  if (stat.uid !== uid) {
    throw new SessionTmpDirError(`${directory} is owned by uid ${stat.uid}, but the current user is uid ${uid}; the directory must be owned by the current user`);
  }
};

const sameInode = (left: fsSync.Stats, right: fsSync.Stats): boolean => left.dev === right.dev && left.ino === right.ino;

const openDirectoryNoFollow = async (target: string, flags: number): Promise<fs.FileHandle> => {
  try {
    return await fs.open(target, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new SessionTmpDirError(`${target} is a symlink or not a directory; refusing to use it`, { cause: error });
    }
    throw error;
  }
};

const ensureSessionTmpDirWindows = async (paths: MomongaPaths, sessionId: string): Promise<string> => {
  const directory = path.join(paths.tmp.sessions, sessionId);
  const root = await lstatIfPresent(paths.tmp.sessions);
  if (root === undefined || root.isSymbolicLink() || !root.isDirectory()) {
    throw new SessionTmpDirError(`${paths.tmp.sessions} is missing, a link, or not a directory; refusing to use it`);
  }
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const child = await fs.lstat(directory);
  if (child.isSymbolicLink() || !child.isDirectory()) {
    throw new SessionTmpDirError(`${directory} is a link or not a directory; refusing to use it`);
  }
  const canonicalRoot = await fs.realpath(paths.tmp.sessions);
  const canonicalDirectory = await fs.realpath(directory);
  if (path.dirname(canonicalDirectory).toLowerCase() !== canonicalRoot.toLowerCase()) {
    throw new SessionTmpDirError(`${directory} does not live directly in the sessions root ${paths.tmp.sessions}`);
  }
  return directory;
};

export const ensureSessionTmpDir = async (paths: MomongaPaths, sessionId: string, ports: PlatformDirectoryPorts = {}): Promise<string> => {
  assertSessionId(sessionId);
  const platform = ports.platform ?? process.platform;
  if (platform === 'win32') return ensureSessionTmpDirWindows(paths, sessionId);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('process.getuid is required to verify directory ownership');
  const openFlags = fsSync.constants.O_RDONLY | directoryFlag(platform) | noFollowFlag(platform);
  const directory = path.join(paths.tmp.sessions, sessionId);
  let rootHandle: fs.FileHandle | undefined;
  let childHandle: fs.FileHandle | undefined;
  try {
    rootHandle = await openDirectoryNoFollow(paths.tmp.sessions, openFlags);
    const rootStat = await rootHandle.stat();
    assertOwnedDirectory(paths.tmp.sessions, rootStat, uid);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    childHandle = await openDirectoryNoFollow(directory, openFlags);
    const childStat = await childHandle.stat();
    assertOwnedDirectory(directory, childStat, uid);
    if (!sameInode(await fs.lstat(paths.tmp.sessions), rootStat)) {
      throw new SessionTmpDirError(`${paths.tmp.sessions} was replaced while preparing ${directory}`);
    }
    const canonicalDirectory = await fs.realpath(directory);
    if (!sameInode(await fs.stat(canonicalDirectory), childStat)) {
      throw new SessionTmpDirError(`${directory} was replaced while it was being prepared`);
    }
    if (!sameInode(await fs.stat(path.dirname(canonicalDirectory)), rootStat)) {
      throw new SessionTmpDirError(`${directory} does not live directly in the sessions root ${paths.tmp.sessions}`);
    }
    if ((childStat.mode & 0o777) !== 0o700) await childHandle.chmod(0o700);
  } finally {
    await childHandle?.close();
    await rootHandle?.close();
  }
  return directory;
};

const lstatIfPresent = async (target: string): Promise<fsSync.Stats | undefined> => {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};
