import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import util from 'node:util';
import { ensureWindowsPrivateTree, modeIsPrivate, noFollowFlag, directoryFlag, ownerProblem } from './platform/privacy.ts';
import { nodeCommandRunner } from './platform/command-runner.ts';
import type { CommandRunner } from './platform/command-runner.ts';
import { isAtomicWriteTemporary } from './atomic-file.ts';
import type { LeftoverDirectory } from './leftover-sweep.ts';
import { hostKernelLock } from './platform/host-kernel-lock.ts';
import type { HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';
import { EntryLockHeldError, claimNewEntry } from './platform/lock-form.ts';
import { SocketPathUnsupportedError, assertSocketPathLength, isPipePath, pipePathFor, refuseUnbindableUnixSocketPath } from './socket-path.ts';

export interface MomongaPaths {
  home: string;
  root: string;
  settingsFile: string;
  keybindingsFile: string;
  run: string;
  current: string;
  generationLock: string;
  generationCounter: string;
  jobs: string;
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
  planCatalog: string;
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

export type GenerationProcessRole = 'gateway' | 'runtime' | 'supervisor';

export const GENERATION_ROLES: readonly GenerationProcessRole[] = ['gateway', 'runtime', 'supervisor'];

export type GenerationSockets = Record<GenerationProcessRole, string>;

export type GenerationLayout = {
  generation: number;
  dir: string;
  sockets: GenerationSockets;
  locks: Record<GenerationProcessRole, string>;
  settingsApplied: string;
  startRecord: string;
  startingLock: string;
  markers: string;
};

export const START_RECORD_FILE = 'start.json';

export const STARTING_LOCK_FILE = 'starting.lock';

export const GENERATION_JOBS_DIRECTORY = 'jobs';

export const MARKER_KINDS = ['tools', 'mcp', 'targets', 'daemons'] as const;

export type MarkerKind = (typeof MARKER_KINDS)[number];

const GENERATION_DIRECTORY_NAME = /^g[1-9][0-9]*$/;

export const generationOfDirectoryName = (name: string): number | undefined => {
  if (!GENERATION_DIRECTORY_NAME.test(name)) return undefined;
  const generation = Number(name.slice(1));
  return Number.isSafeInteger(generation) ? generation : undefined;
};

export const SETTINGS_APPLIED_FILE = 'settings-applied.json';

export const SETTINGS_APPLIED_ENV = 'MOMONGA_SETTINGS_APPLIED';

const byRole = (value: (role: GenerationProcessRole) => string): Record<GenerationProcessRole, string> => ({
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
    settingsApplied: join(dir, SETTINGS_APPLIED_FILE),
    startRecord: join(dir, START_RECORD_FILE),
    startingLock: join(dir, STARTING_LOCK_FILE),
    markers: join(home, '.momonga', 'run', 'markers', `g${generation}`),
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
    home,
    root,
    settingsFile: join(root, 'settings.json'),
    keybindingsFile: join(root, 'keybindings.json'),
    run,
    current: join(run, 'current'),
    generationLock: join(run, 'generation.lock'),
    generationCounter: join(run, 'generation.counter'),
    jobs: join(run, GENERATION_JOBS_DIRECTORY),
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
    planCatalog: join(state, 'plan-catalog'),
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

export type ManagedInstancePurpose = 'serve' | 'probe';

export type ManagedInstance =
  | { owner: 'gateway'; generation: number; purpose: 'serve'; provider: string; incarnation: number }
  | { owner: 'gateway'; generation: number; purpose: 'probe'; provider: string }
  | { owner: 'cli'; purpose: ManagedInstancePurpose; provider: string };

type GatewayInstance = Extract<ManagedInstance, { owner: 'gateway' }>;

export type ManagedInstancePaths = { socketPath: string; markerDirectory: string; lockPath: string };

const gatewayInstanceStem = (instance: GatewayInstance): string => {
  if (instance.purpose === 'probe') return `_probe-${instance.provider}`;
  if (!Number.isSafeInteger(instance.incarnation) || instance.incarnation < 1) throw new RangeError(`an incarnation number must be a positive integer, got ${instance.incarnation}`);
  return `${instance.provider}-${instance.incarnation}`;
};

const CLI_INSTANCE_STEM = (purpose: ManagedInstancePurpose, provider: string): string => `_cli-${purpose}-${provider}`;

export const GENERATION_TARGETS_DIRECTORY = 'targets';

const CLI_MARKER_DIRECTORY = 'cli';

const generationDirectoryName = (generation: number): string => {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new RangeError(`a generation number must be a positive integer, got ${generation}`);
  return `g${generation}`;
};

export const managedInstancePaths = (paths: MomongaPaths, instance: ManagedInstance): ManagedInstancePaths => {
  if (instance.owner === 'gateway') {
    const generation = generationDirectoryName(instance.generation);
    const stem = gatewayInstanceStem(instance);
    const targets = path.join(paths.run, generation, GENERATION_TARGETS_DIRECTORY);
    return {
      socketPath: path.join(targets, `${stem}.sock`),
      lockPath: path.join(targets, `${stem}.lock`),
      markerDirectory: path.join(paths.markers.root, generation, GENERATION_TARGETS_DIRECTORY, stem),
    };
  }
  const stem = CLI_INSTANCE_STEM(instance.purpose, instance.provider);
  return {
    socketPath: path.join(paths.run, `${stem}.sock`),
    lockPath: path.join(paths.run, `${stem}.lock`),
    markerDirectory: path.join(paths.markers.root, CLI_MARKER_DIRECTORY, `${instance.purpose}-${instance.provider}`),
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
  lock?: KernelLockMechanism;
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

export const roleEndpoint = (layout: GenerationLayout, role: GenerationProcessRole): RoleEndpoint => ({ socketPath: layout.sockets[role], lockPath: layout.locks[role] });

const refuseUnfitGenerationSockets = async (layout: GenerationLayout): Promise<void> => {
  const sockets = Object.values(layout.sockets);
  for (const socket of sockets) assertSocketPathLength(socket);
  await Promise.all(sockets.filter((socket) => !isPipePath(socket)).map((socket) => refuseUnbindableUnixSocketPath(socket)));
};

const createMomongaDirs = async (paths: MomongaPaths, ports: PlatformDirectoryPorts): Promise<void> => {
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

const STORE_BLOBS_DIRECTORY = 'blobs';

const everyName = (): boolean => true;

const retainedByItsOwnersRule = (): boolean => true;

export const leftoverDirectories = (paths: MomongaPaths): LeftoverDirectory[] => [
  { directory: paths.planSessions, isLeftover: isAtomicWriteTemporary },
  { directory: paths.planCatalog, isLeftover: isAtomicWriteTemporary },
  { directory: path.dirname(paths.gatewayKey), isLeftover: isAtomicWriteTemporary },
  { directory: paths.tmp.spawn, isLeftover: everyName },
  { directory: paths.tmp.sessions, isLeftover: everyName, retain: retainedByItsOwnersRule },
  { directory: path.join(path.dirname(paths.databases.runtime), STORE_BLOBS_DIRECTORY), isLeftover: isAtomicWriteTemporary },
  { directory: paths.probe, isLeftover: isAtomicWriteTemporary },
  { directory: paths.run, isLeftover: isAtomicWriteTemporary },
];

export const ensureMomongaDirs = async (paths: MomongaPaths, ports: PlatformDirectoryPorts = {}): Promise<void> => {
  await createMomongaDirs(paths, ports);
};

const homeOf = (paths: MomongaPaths): string => path.dirname(paths.root);

const longestOf = (sockets: readonly string[]): string => sockets.reduce((longest, socket) => (Buffer.byteLength(socket) > Buffer.byteLength(longest) ? socket : longest));

export const refuseUnfitGenerationSocketsBeforeCreation = async (paths: MomongaPaths, generation: number): Promise<void> => {
  const sockets = Object.values(generationLayout(homeOf(paths), generation).sockets);
  for (const socket of sockets) assertSocketPathLength(socket);
  const unixSockets = sockets.filter((socket) => !isPipePath(socket));
  if (unixSockets.length === 0) return;
  const longest = longestOf(unixSockets);
  const fillerLength = Buffer.byteLength(longest) - Buffer.byteLength(paths.run) - 1;
  const standIn = path.join(paths.run, 'g'.repeat(Math.max(1, fillerLength)));
  try {
    await refuseUnbindableUnixSocketPath(standIn);
  } catch (error) {
    if (error instanceof SocketPathUnsupportedError) throw new SocketPathUnsupportedError(error.message.replace(standIn, longest), { cause: error });
    throw error;
  }
};

export const generationMarkerDirectories = (paths: MomongaPaths, generation: number): Record<MarkerKind, string> => {
  const root = path.join(paths.markers.root, generationDirectoryName(generation));
  return { tools: path.join(root, 'tools'), mcp: path.join(root, 'mcp'), targets: path.join(root, 'targets'), daemons: path.join(root, 'daemons') };
};

export const scopeToGeneration = (paths: MomongaPaths, generation: number): MomongaPaths => {
  const name = generationDirectoryName(generation);
  const root = path.join(paths.markers.root, name);
  return {
    ...paths,
    markers: { root, ...generationMarkerDirectories(paths, generation) },
    jobs: path.join(paths.run, name, GENERATION_JOBS_DIRECTORY),
    tmp: { ...paths.tmp, spawn: path.join(paths.tmp.spawn, name) },
  };
};

export const createGenerationDirs = async (paths: MomongaPaths, generation: number, ports: PlatformDirectoryPorts = {}): Promise<void> => {
  const platform = ports.platform ?? process.platform;
  const scoped = scopeToGeneration(paths, generation);
  await fs.mkdir(path.join(paths.run, generationDirectoryName(generation)), { mode: 0o700 });
  for (const directory of [paths.markers.root, scoped.markers.root, ...MARKER_KINDS.map((kind) => scoped.markers[kind])]) {
    await ensurePrivateDirectory(directory, platform);
  }
};

export class GenerationDirectoryMissingError extends Error {
  readonly generation: number;
  readonly directory: string;

  constructor(generation: number, directory: string) {
    super(`the directory of generation ${generation} is missing: ${directory}`);
    this.name = 'GenerationDirectoryMissingError';
    this.generation = generation;
    this.directory = directory;
  }
}

export const requireGenerationDirs = async (paths: MomongaPaths, generation: number): Promise<void> => {
  const scoped = scopeToGeneration(paths, generation);
  for (const directory of [path.join(paths.run, generationDirectoryName(generation)), scoped.markers.root]) {
    const stat = await lstatIfPresent(directory);
    if (stat === undefined || !stat.isDirectory()) throw new GenerationDirectoryMissingError(generation, directory);
  }
};

export type GenerationMember = {
  readonly name: string;
  readonly kind: 'file' | 'directory';
  readonly removal: 'always' | 'when-empty';
  readonly hasAtomicTemporaries: boolean;
};

const SOCKET_LOCK_SUFFIX = '.lock';

const fileMember = (name: string, hasAtomicTemporaries = false): GenerationMember => ({ name, kind: 'file', removal: 'always', hasAtomicTemporaries });

export const GENERATION_MEMBERS: readonly GenerationMember[] = [
  ...GENERATION_ROLES.map((role) => fileMember(`${role}.lock`)),
  ...GENERATION_ROLES.map((role) => fileMember(`${role}.sock`)),
  ...GENERATION_ROLES.map((role) => fileMember(`${role}.sock${SOCKET_LOCK_SUFFIX}`)),
  fileMember(START_RECORD_FILE, true),
  fileMember(STARTING_LOCK_FILE),
  fileMember(SETTINGS_APPLIED_FILE, true),
  { name: GENERATION_TARGETS_DIRECTORY, kind: 'directory', removal: 'always', hasAtomicTemporaries: false },
  { name: GENERATION_JOBS_DIRECTORY, kind: 'directory', removal: 'when-empty', hasAtomicTemporaries: false },
];

const ATOMIC_TEMPORARY_OF = /^\.(.+)\.[0-9a-f]+\.tmp$/;

export const generationMemberOf = (name: string): GenerationMember | undefined => {
  const exact = GENERATION_MEMBERS.find((member) => member.name === name);
  if (exact !== undefined) return exact;
  const written = ATOMIC_TEMPORARY_OF.exec(name)?.[1];
  return GENERATION_MEMBERS.find((member) => member.hasAtomicTemporaries && member.name === written);
};

export const generationSpawnScratch = (paths: MomongaPaths, generation: number): string => scopeToGeneration(paths, generation).tmp.spawn;

export const ensureGenerationDirs = async (paths: MomongaPaths, generation: number, ports: PlatformDirectoryPorts = {}): Promise<void> => {
  const layout = generationLayout(path.dirname(paths.root), generation);
  await refuseUnfitGenerationSockets(layout);
  await createMomongaDirs(paths, ports);
  await ensurePrivateDirectory(layout.dir, ports.platform ?? process.platform);
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

const heldSessionScratch = new Map<string, HeldKernelLock>();

export type SessionScratchClaim = 'owned' | 'shared';

export type SessionScratch = { dir: string; claim: SessionScratchClaim };

const claimSessionScratch = async (directory: string, lock: KernelLockMechanism): Promise<{ claimedNow: boolean; claim: SessionScratchClaim }> => {
  if (heldSessionScratch.has(directory)) return { claimedNow: false, claim: 'owned' };
  try {
    heldSessionScratch.set(directory, await claimNewEntry(lock, directory, 'sidecar'));
  } catch (error) {
    if (error instanceof EntryLockHeldError) return { claimedNow: false, claim: 'shared' };
    throw error;
  }
  return { claimedNow: true, claim: 'owned' };
};

export const releaseSessionScratch = (directory: string): void => {
  const held = heldSessionScratch.get(directory);
  heldSessionScratch.delete(directory);
  held?.release();
};

const assertSessionsRootIsDirectory = async (root: string): Promise<void> => {
  const stat = await lstatIfPresent(root);
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new SessionTmpDirError(`${root} is missing, a link, or not a directory; refusing to use it`);
  }
};

export const ensureSessionTmpDir = async (paths: MomongaPaths, sessionId: string, ports: PlatformDirectoryPorts = {}): Promise<SessionScratch> => {
  assertSessionId(sessionId);
  const directory = path.join(paths.tmp.sessions, sessionId);
  await assertSessionsRootIsDirectory(paths.tmp.sessions);
  const { claimedNow, claim } = await claimSessionScratch(directory, ports.lock ?? hostKernelLock());
  try {
    return { dir: await ensureClaimedSessionTmpDir(paths, sessionId, ports), claim };
  } catch (error) {
    if (claimedNow) releaseSessionScratch(directory);
    throw error;
  }
};

const ensureClaimedSessionTmpDir = async (paths: MomongaPaths, sessionId: string, ports: PlatformDirectoryPorts): Promise<string> => {
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
