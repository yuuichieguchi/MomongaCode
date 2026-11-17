import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { componentCountOf, createOwnedDirectory, fileRuleBlocks, hostPaths, mapAsync, matchDepthOf, procGroupMembers, settledOrAborted, signalGroup, signalGroupExceptLeader, systemTiming } from '@momonga/foundation';
import type { Awaitable, FileRuleEntry, FileRuleSet, GroupMembersReader, OwnedDirectory, PlaceholderForm, KernelLockMechanism, Timing } from '@momonga/foundation';
import type { Duplex } from 'node:stream';
import { MARKER_SLOT, SANDBOX_STOP_BOUND_MS, SOCKET_FILTER_SLOT, launch } from './process.ts';
import { RELAY_CHANNEL_SLOT, relayCommandOf, serveRelayToProxy } from './relay.ts';
import type { LaunchOptions } from './process.ts';
import { SandboxPolicyError } from './policy-error.ts';
import { assertLoopbackPort, validateSandboxPolicy } from './profile.ts';
import { EMPTY_FILE_FORM, identityOf, isStillThePlaceholder, recoverPlaceholders, removePlaceholderEntry } from './placeholder-journal.ts';
import type { PlaceholderIdentity, PlaceholderJournal } from './placeholder-journal.ts';
import { assertExistingDirectory } from './scratch.ts';
import { socketFilter, socketFilterArchitectureOf } from './seccomp.ts';
import type { SocketFilterKind } from './seccomp.ts';
import type { DirectoryPort } from './scratch.ts';
import type { Sandbox, SandboxCommand, SandboxDescriptors, SandboxPolicy, SandboxedProcess } from './types.ts';

export const DEFAULT_BWRAP_PATH = '/usr/bin/bwrap';

export const BWRAP_MAX_ARGS = 9000;

export const DEVICE_NODE_ARGUMENTS: readonly string[] = ['--dev', '/dev'];

export const BWRAP_SANDBOX_FIXED_ARGUMENTS = 16;

export const MASK_ARGUMENT_CEILING = BWRAP_MAX_ARGS - BWRAP_SANDBOX_FIXED_ARGUMENTS;

export const KERNEL_ARGUMENT_BYTES = 1048576;

const MOUNT_OPTIONS: ReadonlySet<string> = new Set(['--bind', '--ro-bind', '--tmpfs']);

const assertWithinArgumentCeiling = (args: readonly string[]): void => {
  const bytes = args.reduce((sum, value) => sum + Buffer.byteLength(value) + 1, 0);
  if (args.length <= MASK_ARGUMENT_CEILING && bytes <= KERNEL_ARGUMENT_BYTES) return;
  const masks = args.filter((value) => MOUNT_OPTIONS.has(value)).length;
  throw new SandboxPolicyError(
    'deny_set_exceeds_argument_ceiling',
    `the denied paths need ${masks} mounts (${args.length} bubblewrap arguments, ${bytes} bytes), and the sandbox can pass at most ${MASK_ARGUMENT_CEILING} arguments (${KERNEL_ARGUMENT_BYTES} bytes) to bubblewrap for them, so the command was not started`,
  );
};

export type EntryKind = 'file' | 'directory';

export type Unreachable = 'unreachable';

export type DirectoryEntry = { path: string; kind: EntryKind | 'other' };

export type FilesystemPort = {
  kindOf(target: string): Awaitable<EntryKind | undefined | Unreachable>;
  isSymbolicLink(target: string): Awaitable<boolean>;
  realpath(target: string): Awaitable<string>;
  children(directory: string): Awaitable<DirectoryEntry[] | Unreachable>;
  createPlaceholder(target: string, form: PlaceholderForm): Awaitable<PlaceholderIdentity>;
  removePlaceholder(target: string, identity: PlaceholderIdentity, form: PlaceholderForm): Awaitable<void>;
  requireExecutable(file: string): Awaitable<void>;
  makeScratchDirectory(parent: string, prefix: string): Awaitable<OwnedDirectory>;
};

const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['ELOOP', 'EACCES']);

const inspected = async <T>(absent: T, read: () => Promise<T>): Promise<T | Unreachable> => {
  try {
    return await read();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (ABSENT_CODES.has(code)) return absent;
    if (UNREACHABLE_CODES.has(code)) return 'unreachable';
    throw error;
  }
};

const writePlaceholderFile = async (target: string, bytes: string): Promise<void> => {
  const handle = await fs.promises.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, PLACEHOLDER_MODE);
  try {
    await handle.writeFile(Buffer.from(bytes, 'latin1'));
  } finally {
    await handle.close();
  }
};

export const nodeFilesystemPort = (lock: KernelLockMechanism): FilesystemPort => ({
  requireExecutable: (file) => fs.promises.access(file, fs.constants.X_OK),
  makeScratchDirectory: (parent, prefix) => createOwnedDirectory({ parent, prefix, lock }),
  kindOf: (target) => inspected<EntryKind | undefined>(undefined, async () => ((await fs.promises.stat(target)).isDirectory() ? 'directory' : 'file')),
  isSymbolicLink: async (target) => (await inspected(false, async () => (await fs.promises.lstat(target)).isSymbolicLink())) === true,
  realpath: (target) => fs.promises.realpath(target),
  createPlaceholder: async (target, form) => {
    if (form.kind === 'directory') await fs.promises.mkdir(target, { mode: PLACEHOLDER_DIRECTORY_MODE });
    else await writePlaceholderFile(target, form.bytes);
    return identityOf(target);
  },
  removePlaceholder: async (target, identity, form) => {
    if (await isStillThePlaceholder(target, identity, form)) await removePlaceholderEntry(target, form);
  },
  children: (directory) =>
    inspected<DirectoryEntry[]>([], async () =>
      (await fs.promises.readdir(directory, { withFileTypes: true })).map((entry) => ({
        path: path.join(directory, entry.name),
        kind: entry.isSymbolicLink() ? 'other' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      })),
    ),
});

export type BubblewrapOptions = { tmpDir?: string; scratchDir?: string; cwd?: string; heldPlaceholders?: ReadonlySet<string> };

export type SocketPlan = { kind: 'no-unix-sockets' } | { kind: 'named-unix-sockets'; allowed: readonly string[]; denied: readonly string[] };

export type BubblewrapPlan = { args: string[]; relay?: { port: number }; placeholders: string[]; forms: Readonly<Record<string, PlaceholderForm>>; sockets: SocketPlan };

export const SOCKET_GUARD_CHANNEL_SLOT = SOCKET_FILTER_SLOT + 1;

export type BubblewrapCommand = { file: string; args: string[]; socketFilter: SocketFilterKind };

export const bubblewrapCommandOf = (bwrapPath: string, plan: BubblewrapPlan, argv: readonly string[], socketGuard: string | undefined): BubblewrapCommand => {
  const { sockets } = plan;
  if (sockets.kind === 'no-unix-sockets') {
    return { file: bwrapPath, args: [...plan.args, '--seccomp', String(SOCKET_FILTER_SLOT), '--', ...argv], socketFilter: sockets.kind };
  }
  if (socketGuard === undefined) {
    throw new SandboxPolicyError(
      'socket_guard_missing',
      `the command may reach the Unix sockets under ${sockets.allowed.join(', ')}, which the Linux sandbox allows only through its socket guard, and this installation has no socket guard, so the command was not started`,
    );
  }
  return {
    file: socketGuard,
    args: [
      'supervise',
      String(SOCKET_GUARD_CHANNEL_SLOT),
      ...sockets.allowed.flatMap((entry) => ['--allow', entry]),
      ...sockets.denied.flatMap((entry) => ['--deny', entry]),
      '--',
      bwrapPath,
      ...plan.args,
      '--',
      socketGuard,
      'enter',
      String(SOCKET_FILTER_SLOT),
      String(SOCKET_GUARD_CHANNEL_SLOT),
      '--',
      ...argv,
    ],
    socketFilter: sockets.kind,
  };
};

type Ownership = { form: PlaceholderForm; identity?: PlaceholderIdentity };

type Mount = { depth: number; args: string[] };

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const depthOf = (target: string): number => target.split('/').filter((part) => part !== '').length;

const byDepth = (mounts: readonly Mount[]): string[] => [...mounts].sort((left, right) => left.depth - right.depth).flatMap((mount) => mount.args);

const PLACEHOLDER_MODE = 0o644;

const PLACEHOLDER_DIRECTORY_MODE = 0o755;

const MODULE_PINNED_ENTRIES = ['hooks', 'config', 'config.worktree'] as const;

const SYSTEMD_RESOLVE_DIRECTORY = '/run/systemd/resolve';

const isUserDeny = (entry: FileRuleEntry): boolean =>
  entry.effect === 'deny' && entry.unresolved === null && (entry.tool === 'Read' || entry.tool === 'Edit');

const directoriesOf = (entry: FileRuleEntry): Array<{ directory: string }> => [
  { directory: entry.anchorDirectory },
  ...(entry.denyLexical === null ? [] : [{ directory: entry.lexicalDirectory }]),
];

type Inspector = {
  kindOf(target: string): Promise<EntryKind | undefined>;
  children(directory: string): Promise<DirectoryEntry[]>;
};

const depthBoundOf = (entry: FileRuleEntry): number | undefined => {
  const bounds = [matchDepthOf(entry.exact), matchDepthOf(entry.exactLexical ?? entry.exact)];
  return bounds.includes(undefined) ? undefined : Math.max(...(bounds as number[]));
};

const blockedPaths = async (set: FileRuleSet, entry: FileRuleEntry, port: Inspector, signal: AbortSignal): Promise<string[]> => {
  const found: string[] = [];
  const depthBound = depthBoundOf(entry);
  const visit = async (candidate: string, kind: EntryKind | 'other'): Promise<void> => {
    signal.throwIfAborted();
    const blocked = fileRuleBlocks(set, entry, candidate, candidate);
    if (blocked) found.push(candidate);
    if (kind !== 'directory') return;
    const wholeDirectoryBlocked = blocked && (entry.exceptions.length === 0 || entry.blockedAsWhole);
    if (wholeDirectoryBlocked) return;
    if (!blocked && depthBound !== undefined && componentCountOf(candidate) >= depthBound) return;
    for (const child of await port.children(candidate)) await visit(child.path, child.kind);
  };
  for (const { directory } of directoriesOf(entry)) {
    const kind = await port.kindOf(directory);
    if (kind !== 'directory') continue;
    await visit(directory, 'directory');
  }
  return unique(found);
};

type ReadDenyEntry = { set: FileRuleSet; entry: FileRuleEntry };

type Cover = { whole: boolean; masks: string[] };

const withoutCovered = (paths: readonly string[]): string[] => paths.filter((candidate) => !paths.some((other) => other !== candidate && candidate.startsWith(`${other}/`)));

const denialMasks = async (entries: readonly ReadDenyEntry[], port: Inspector, keptMounts: readonly string[], signal: AbortSignal): Promise<string[]> => {
  const blocked = (candidate: string): boolean => entries.some(({ set, entry }) => fileRuleBlocks(set, entry, candidate, candidate));
  const blockedWhole = (candidate: string): boolean =>
    entries.some(({ set, entry }) => (entry.exceptions.length === 0 || entry.blockedAsWhole) && fileRuleBlocks(set, entry, candidate, candidate));
  const depthBounds = entries.map(({ entry }) => depthBoundOf(entry));
  const depthBound = depthBounds.includes(undefined) ? undefined : Math.max(...(depthBounds as number[]));
  const foldable = (directory: string): boolean => !keptMounts.some((kept) => kept === directory || kept.startsWith(`${directory}/`));
  const visit = async (candidate: string, kind: EntryKind | 'other'): Promise<Cover> => {
    signal.throwIfAborted();
    const isBlocked = blocked(candidate);
    if (kind !== 'directory') return { whole: isBlocked, masks: [] };
    if (blockedWhole(candidate) && foldable(candidate)) return { whole: true, masks: [] };
    if (!isBlocked && depthBound !== undefined && componentCountOf(candidate) >= depthBound) return { whole: false, masks: [] };
    const covers: Array<[string, Cover]> = [];
    for (const child of await port.children(candidate)) covers.push([child.path, await visit(child.path, child.kind)]);
    const complete = covers.length === 0 ? isBlocked : covers.every(([, cover]) => cover.whole);
    if (complete && foldable(candidate)) return { whole: true, masks: [] };
    return { whole: false, masks: covers.flatMap(([childPath, cover]) => (cover.whole ? [childPath] : cover.masks)) };
  };
  const roots = unique(entries.flatMap(({ entry }) => directoriesOf(entry).map(({ directory }) => directory)));
  const masks: string[] = [];
  for (const root of roots) {
    if ((await port.kindOf(root)) !== 'directory') continue;
    const cover = await visit(root, 'directory');
    masks.push(...(cover.whole ? [root] : cover.masks));
  }
  return withoutCovered(unique(masks));
};

export async function planBubblewrap(policy: SandboxPolicy, options: BubblewrapOptions, signal: AbortSignal, port: FilesystemPort): Promise<BubblewrapPlan> {
  const paths = hostPaths(signal);
  const ask = <T>(question: () => Awaitable<T>): Promise<T> => {
    signal.throwIfAborted();
    return settledOrAborted((async () => question())(), signal);
  };
  const realpath = (target: string): Promise<string> => ask(() => port.realpath(target));
  await validateSandboxPolicy(policy, options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir }, paths);
  const relayPort = typeof policy.network === 'object' ? assertLoopbackPort(policy.network.loopbackPort) : undefined;
  const heldPlaceholders = options.heldPlaceholders ?? new Set<string>();
  const canonicalize = async (target: string): Promise<string> => {
    const placeholder = [...heldPlaceholders].find((held) => target.startsWith(`${held}/`));
    if (placeholder === undefined) return paths.canonicalPath(target);
    return path.join(await paths.canonicalPath(path.dirname(placeholder)), path.basename(placeholder), path.relative(placeholder, target));
  };
  const roots = unique(await mapAsync(policy.writableRoots, paths.canonicalPath));
  const writeDenied = unique(await mapAsync(policy.writeDenied, canonicalize));
  const readDenied = unique(await mapAsync(policy.readDenied, canonicalize));
  const readAllowed = unique(await mapAsync(policy.readAllowed ?? [], canonicalize));
  const unixSocketAllow = unique(await mapAsync(policy.unixSocketAllow ?? [], paths.canonicalPath));
  const sessionTmpDir = options.tmpDir === undefined ? undefined : await paths.canonicalPath(options.tmpDir);
  const scratchDir = options.scratchDir === undefined ? undefined : await paths.canonicalPath(options.scratchDir);
  const placeholders: string[] = [];

  const base: string[] = ['--ro-bind', '/', '/', ...DEVICE_NODE_ARGUMENTS, '--proc', '/proc', '--tmpfs', '/run'];
  if (policy.network === 'allow' && (await ask(() => port.kindOf(SYSTEMD_RESOLVE_DIRECTORY))) === 'directory') {
    base.push('--ro-bind', SYSTEMD_RESOLVE_DIRECTORY, SYSTEMD_RESOLVE_DIRECTORY);
  }

  const writableBinds: string[] = roots.flatMap((root) => ['--bind', root, root]);
  const wideningAreas: string[] = [];
  for (const entry of policy.fileRules.entries) {
    if (!entry.widening) continue;
    const closure = entry.subset.closure;
    const closureKind = closure.kind === 'subpath' ? await ask(() => port.kindOf(closure.path)) : undefined;
    if (closure.kind === 'subpath' && (closureKind === 'directory' || closureKind === 'file')) {
      writableBinds.push('--bind', closure.path, closure.path);
      wideningAreas.push(closure.path);
    }
  }
  const writableAreas = unique([...roots, ...wideningAreas]);

  const insideRoots = (target: string): boolean => writableAreas.some((area) => target.startsWith(`${area}/`));

  const changeable = (target: string): boolean => insideRoots(target) || writableAreas.some((area) => area === target || area.startsWith(`${target}/`));

  const refuseUnreachable = (target: string): void => {
    if (changeable(target)) {
      throw new SandboxPolicyError('protected_path_unreadable', `bubblewrap cannot inspect ${target}, so it cannot plan the mounts that protect the workspace`, { path: target });
    }
  };

  const inspector: Inspector = {
    kindOf: async (target) => {
      const kind = await ask(() => port.kindOf(target));
      if (kind !== 'unreachable') return kind;
      refuseUnreachable(target);
      return undefined;
    },
    children: async (directory) => {
      const found = await ask(() => port.children(directory));
      if (found !== 'unreachable') return found;
      refuseUnreachable(directory);
      return [];
    },
  };
  const kindOf = inspector.kindOf;

  const firstMissingComponent = async (target: string): Promise<string | undefined> => {
    let missing = target;
    for (let parent = path.dirname(missing); parent !== missing; parent = path.dirname(missing)) {
      const kind = await kindOf(parent);
      if (kind === 'directory') return heldPlaceholders.has(parent) ? parent : missing;
      if (kind === 'file') return heldPlaceholders.has(parent) ? parent : undefined;
      missing = parent;
    }
    return undefined;
  };

  const reserve = async (target: string, mounts: Mount[]): Promise<void> => {
    const missing = await firstMissingComponent(target);
    if (missing === undefined || !insideRoots(missing) || placeholders.includes(missing)) return;
    placeholders.push(missing);
    mounts.push({ depth: depthOf(missing), args: ['--ro-bind', missing, missing] });
  };

  const mounted: string[] = [];

  const refuseLinkName = async (target: string): Promise<void> => {
    if (insideRoots(target) && (await ask(() => port.isSymbolicLink(target)))) {
      throw new SandboxPolicyError('protected_link_not_pinnable', `bubblewrap cannot pin the symbolic link ${target}: a mount cannot sit on a link name, so the link could be replaced from inside the sandbox`, { path: target });
    }
  };

  const protect = async (target: string, mounts: Mount[]): Promise<void> => {
    await refuseLinkName(target);
    const kind = await kindOf(target);
    if (kind === undefined) {
      await reserve(target, mounts);
      return;
    }
    const resolved = await realpath(target);
    if (heldPlaceholders.has(resolved) && !placeholders.includes(resolved)) placeholders.push(resolved);
    mounted.push(resolved);
    mounts.push({ depth: depthOf(resolved), args: ['--ro-bind', resolved, resolved] });
  };

  const writeMounts: Mount[] = [];
  const literals = unique([...policy.writeDeniedLiterals, ...policy.protectedSet.literals]);
  for (const target of literals) await refuseLinkName(target);
  for (const target of [...writeDenied, ...literals]) await protect(target, writeMounts);
  const userDenies = [...policy.fileRules.entries, ...policy.protectedSet.patterns.entries].filter(isUserDeny);
  for (const entry of userDenies.filter((candidate) => candidate.access === 'write')) {
    const set = policy.protectedSet.patterns.entries.includes(entry) ? policy.protectedSet.patterns : policy.fileRules;
    for (const target of await blockedPaths(set, entry, inspector, signal)) await protect(target, writeMounts);
  }
  const readOnlyDirectories = new Set<string>();
  const isGitDirectory = async (directory: string): Promise<boolean> =>
    (await kindOf(path.join(directory, 'HEAD'))) === 'file' && (await kindOf(path.join(directory, 'objects'))) === 'directory' && (await kindOf(path.join(directory, 'refs'))) === 'directory';
  const anchorModules = async (anchor: string): Promise<void> => {
    if (!insideRoots(anchor)) return;
    if ((await kindOf(anchor)) !== 'directory') {
      await protect(anchor, writeMounts);
      return;
    }
    readOnlyDirectories.add(anchor);
    writeMounts.push({ depth: depthOf(anchor), args: ['--ro-bind', anchor, anchor] });
    await walkModules(anchor);
  };
  const walkModules = async (directory: string): Promise<void> => {
    for (const child of await inspector.children(directory)) {
      if (child.kind !== 'directory') continue;
      if (!(await isGitDirectory(child.path))) {
        readOnlyDirectories.add(child.path);
        await walkModules(child.path);
        continue;
      }
      writeMounts.push({ depth: depthOf(child.path), args: ['--bind', child.path, child.path] });
      for (const name of MODULE_PINNED_ENTRIES) await protect(path.join(child.path, name), writeMounts);
      await anchorModules(path.join(child.path, 'modules'));
      await pinWorktrees(path.join(child.path, 'worktrees'));
    }
  };
  const pinWorktrees = async (anchor: string): Promise<void> => {
    if (!insideRoots(anchor) || (await kindOf(anchor)) !== 'directory') return;
    for (const child of await inspector.children(anchor)) if (child.kind === 'directory') await protect(path.join(child.path, 'config.worktree'), writeMounts);
  };
  for (const anchor of policy.protectedSet.moduleAnchors) await anchorModules(anchor);
  for (const anchor of policy.protectedSet.worktreeAnchors) await pinWorktrees(anchor);
  const pinMounts: Mount[] = [];
  const pinned = [...unique(mounted), ...unique(placeholders)];
  const pinnedAncestors = new Set<string>();
  for (const target of pinned) {
    for (let ancestor = path.dirname(target); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
      const inside = insideRoots(ancestor);
      if (!inside || pinnedAncestors.has(ancestor)) continue;
      if (!writableAreas.includes(ancestor) && !readOnlyDirectories.has(ancestor) && (await kindOf(ancestor)) === 'directory') {
        pinnedAncestors.add(ancestor);
        pinMounts.push({ depth: depthOf(ancestor), args: ['--bind', ancestor, ancestor] });
      }
    }
  }

  const readMounts: Mount[] = [];
  const maskedDirectories: string[] = [];
  const mask = async (target: string): Promise<void> => {
    const kind = await kindOf(target);
    if (kind === undefined) return;
    const resolved = await realpath(target);
    if (kind === 'directory') maskedDirectories.push(resolved);
    readMounts.push({ depth: depthOf(resolved), args: kind === 'directory' ? ['--tmpfs', resolved] : ['--ro-bind', '/dev/null', resolved] });
  };
  for (const target of readDenied) await mask(target);
  const readDenyEntries: ReadDenyEntry[] = userDenies
    .filter((candidate) => candidate.access === 'read')
    .map((entry) => ({ set: policy.protectedSet.patterns.entries.includes(entry) ? policy.protectedSet.patterns : policy.fileRules, entry }));
  const keptMounts = unique([
    ...writableAreas,
    ...[...writeMounts, ...pinMounts].filter((mount) => mount.args[0] === '--bind').map((mount) => mount.args[1] as string),
    ...placeholders,
    ...readAllowed,
    ...(sessionTmpDir === undefined ? [] : [sessionTmpDir]),
    ...(scratchDir === undefined ? [] : [scratchDir]),
  ]);
  for (const target of await denialMasks(readDenyEntries, inspector, keptMounts, signal)) await mask(target);
  const reallow: string[] = [];
  for (const target of readAllowed) if ((await kindOf(target)) !== undefined) reallow.push('--ro-bind', target, target);

  const scratch: string[] = [...new Set([...(sessionTmpDir === undefined ? [] : [sessionTmpDir]), ...(scratchDir === undefined ? [] : [scratchDir])])].flatMap((dir) => [
    '--bind',
    dir,
    dir,
  ]);

  const args = [
    '--unshare-pid',
    '--unshare-ipc',
    ...(policy.network === 'allow' ? [] : ['--unshare-net']),
    '--die-with-parent',
    ...base,
    ...writableBinds,
    ...byDepth([...pinMounts, ...writeMounts]),
    ...byDepth(readMounts),
    ...reallow,
    ...scratch,
    ...unique(maskedDirectories).flatMap((directory) => ['--remount-ro', directory]),
    ...(options.cwd === undefined ? [] : ['--chdir', options.cwd]),
  ];
  assertWithinArgumentCeiling(args);
  const reserved = unique(placeholders);
  return {
    args,
    ...(relayPort === undefined ? {} : { relay: { port: relayPort } }),
    placeholders: reserved,
    forms: Object.fromEntries(reserved.map((placeholder): [string, PlaceholderForm] => [placeholder, policy.protectedSet.forms[placeholder] ?? EMPTY_FILE_FORM])),
    sockets: unixSocketAllow.length === 0 ? { kind: 'no-unix-sockets' } : { kind: 'named-unix-sockets', allowed: unixSocketAllow, denied: readDenied },
  };
}

export const planProtection = (denied: readonly string[], scratch: readonly string[], readable: readonly string[]): string[] => [
  '--bind',
  '/',
  '/',
  ...DEVICE_NODE_ARGUMENTS,
  ...denied.flatMap((area) => ['--tmpfs', area]),
  ...scratch.flatMap((folder) => ['--bind', folder, folder]),
  ...readable.flatMap((entry) => ['--ro-bind', entry, entry]),
];

export const bwrapProbeArguments = (shell: string): string[] => [
  '--unshare-pid',
  '--unshare-ipc',
  '--unshare-net',
  '--die-with-parent',
  '--ro-bind',
  '/',
  '/',
  ...DEVICE_NODE_ARGUMENTS,
  '--proc',
  '/proc',
  '--tmpfs',
  '/run',
  '--',
  shell,
  '-c',
  ':',
];

export type ProbeRunner = (file: string, args: readonly string[], signal: AbortSignal) => Promise<{ status: number | null; stderr: string }>;

export type BubblewrapProbe = { ok: true } | { ok: false; stderr: string };

export type BubblewrapProbeOptions = { signal: AbortSignal; run?: ProbeRunner };

const nodeProbeRunner: ProbeRunner = (file, args, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ['ignore', 'ignore', 'pipe'], signal, killSignal: 'SIGKILL' });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stderr: Buffer.concat(stderr).toString('utf8') }));
  });

export const probeBubblewrap = async (bwrapPath: string, shell: string, { signal, run = nodeProbeRunner }: BubblewrapProbeOptions): Promise<BubblewrapProbe> => {
  const { status, stderr } = await run(bwrapPath, bwrapProbeArguments(shell), signal);
  if (status === 0) return { ok: true };
  return { ok: false, stderr: status === null ? 'bwrap ended without an exit status' : stderr.trim() };
};

export interface BubblewrapSandboxOptions {
  bwrapPath?: string;
  tmpRoot: string;
  lock: KernelLockMechanism;
  killGraceMs: number;
  filesystem?: FilesystemPort;
  journal: PlaceholderJournal;
  holders: () => Awaitable<ReadonlySet<string>>;
  spawnProcess?: LaunchOptions['spawnProcess'];
  groupMembers?: GroupMembersReader;
  socketGuard?: () => Awaitable<string>;
  relay?: () => Awaitable<readonly string[]>;
  architecture?: string;
  timing?: Timing;
}

type Step = () => Awaitable<void>;

const attemptAll = async (steps: readonly Step[]): Promise<unknown[]> => {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
};

const throwAll = (failures: readonly unknown[]): void => {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, failures.map((failure) => (failure as Error).message).join('; '));
};

export function createBubblewrapSandbox(options: BubblewrapSandboxOptions): Sandbox {
  const bwrapPath = options.bwrapPath ?? DEFAULT_BWRAP_PATH;
  const filesystem = options.filesystem ?? nodeFilesystemPort(options.lock);
  const groupMembers = options.groupMembers ?? procGroupMembers;
  const timing = options.timing ?? systemTiming;
  const architecture = socketFilterArchitectureOf(options.architecture ?? process.arch);
  const signalSandboxTerm = async (pgid: number, stop: AbortSignal): Promise<void> => {
    if (signalGroupExceptLeader(pgid, 'SIGTERM', groupMembers) === 0) await signalGroup(pgid, 'SIGTERM', undefined, stop);
  };
  let executable: Promise<void> | undefined;
  const requireBubblewrap = (signal: AbortSignal): Promise<void> => {
    executable ??= (async () => filesystem.requireExecutable(bwrapPath))();
    return settledOrAborted(executable, signal);
  };
  const directories: DirectoryPort = { isDirectory: async (target) => (await filesystem.kindOf(target)) === 'directory' };
  const held = new Map<string, number>();
  const { journal, holders } = options;
  const owned = new Map<string, Ownership>();
  const kept = new Map<string, Ownership>();
  const sweepFailures = new Map<string, string>();

  const remove = async (placeholder: string, ownership: Ownership): Promise<void> => {
    if (ownership.identity !== undefined) await filesystem.removePlaceholder(placeholder, ownership.identity, ownership.form);
    await journal.forget(placeholder);
  };
  const discard = async (placeholder: string, stillHeld: ReadonlySet<string>): Promise<void> => {
    const ownership = owned.get(placeholder) as Ownership;
    owned.delete(placeholder);
    if (stillHeld.has(placeholder)) {
      kept.set(placeholder, ownership);
      return;
    }
    await remove(placeholder, ownership);
  };
  const sweepKept = async (stillHeld: ReadonlySet<string>): Promise<void> => {
    const releasable = [...kept].filter(([placeholder]) => !stillHeld.has(placeholder));
    for (const [placeholder] of releasable) kept.delete(placeholder);
    const newFailures: unknown[] = [];
    for (const [placeholder, ownership] of releasable) {
      if (held.has(placeholder) || owned.has(placeholder)) continue;
      try {
        await remove(placeholder, ownership);
        sweepFailures.delete(placeholder);
      } catch (error) {
        kept.set(placeholder, ownership);
        const message = error instanceof Error ? error.message : String(error);
        if (sweepFailures.get(placeholder) !== message) {
          sweepFailures.set(placeholder, message);
          newFailures.push(error);
        }
      }
    }
    throwAll(newFailures);
  };
  let turn: Promise<void> = Promise.resolve();
  const serially = async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const earlier = turn;
    let leave: () => void = () => undefined;
    const own = new Promise<void>((resolve) => {
      leave = resolve;
    });
    turn = earlier.then(() => own);
    try {
      await (signal === undefined ? earlier : settledOrAborted(earlier, signal));
      return await work();
    } finally {
      leave();
    }
  };
  const sweep = (): Promise<void> =>
    serially(async () => {
      if (kept.size === 0) return;
      await sweepKept(await holders());
    });
  const hold = async (plan: BubblewrapPlan): Promise<void> => {
    const begun: string[] = [];
    const adopted: Array<[string, Ownership]> = [];
    try {
      for (const placeholder of plan.placeholders.filter((candidate) => !held.has(candidate))) {
        if (kept.has(placeholder)) {
          const ownership = kept.get(placeholder) as Ownership;
          kept.delete(placeholder);
          sweepFailures.delete(placeholder);
          owned.set(placeholder, ownership);
          adopted.push([placeholder, ownership]);
          continue;
        }
        const form = plan.forms[placeholder] as PlaceholderForm;
        await journal.intend(placeholder, timing.now(), form);
        begun.push(placeholder);
        owned.set(placeholder, { form });
        const identity = await filesystem.createPlaceholder(placeholder, form);
        owned.set(placeholder, { form, identity });
        await journal.complete(placeholder, identity);
      }
    } catch (error) {
      const failures = await attemptAll(begun.map((placeholder) => () => remove(placeholder, owned.get(placeholder) as Ownership)));
      for (const placeholder of begun) owned.delete(placeholder);
      for (const [placeholder, ownership] of adopted) {
        owned.delete(placeholder);
        kept.set(placeholder, ownership);
      }
      throwAll([error, ...failures]);
    }
    for (const placeholder of plan.placeholders) held.set(placeholder, (held.get(placeholder) ?? 0) + 1);
  };
  const releaseNow = async (plan: BubblewrapPlan): Promise<void> => {
    const ended: string[] = [];
    for (const placeholder of plan.placeholders) {
      const remaining = (held.get(placeholder) ?? 1) - 1;
      if (remaining > 0) {
        held.set(placeholder, remaining);
        continue;
      }
      held.delete(placeholder);
      ended.push(placeholder);
    }
    if (ended.length === 0 && kept.size === 0) return;
    const stillHeld = await holders();
    throwAll(await attemptAll([...ended.map((placeholder) => () => discard(placeholder, stillHeld)), () => sweepKept(stillHeld)]));
  };
  const relayPrefixOf = async (signal: AbortSignal): Promise<readonly string[]> => {
    if (options.relay === undefined) {
      throw new SandboxPolicyError(
        'network_relay_missing',
        'the command may reach only the hosts it was granted, which the Linux sandbox allows only through its network relay, and this installation has no network relay, so the command was not started',
      );
    }
    const relay = options.relay;
    return settledOrAborted((async () => relay())(), signal);
  };
  const launchWith = async (command: SandboxCommand, plan: BubblewrapPlan, tmpDir: string, signal: AbortSignal, afterExit: Step, descriptors?: SandboxDescriptors): Promise<SandboxedProcess> => {
    const guard = plan.sockets.kind === 'no-unix-sockets' || options.socketGuard === undefined ? undefined : await settledOrAborted((async () => options.socketGuard?.())(), signal);
    const marked = command.markerFile !== undefined || descriptors?.markerFd !== undefined;
    const relayed = plan.relay === undefined ? undefined : { port: plan.relay.port, prefix: await relayPrefixOf(signal) };
    const argv = relayed === undefined ? command.argv : relayCommandOf(relayed.prefix, relayed.port, marked ? MARKER_SLOT : undefined, command.argv);
    const wrapped = bubblewrapCommandOf(bwrapPath, plan, argv, guard);
    await hold(plan);
    try {
      return launch({
        file: wrapped.file,
        args: wrapped.args,
        protection: { kind: 'sandboxed', backend: 'bubblewrap' },
        socketFilter: socketFilter(architecture, wrapped.socketFilter),
        ...(relayed === undefined ? {} : { channel: { slot: RELAY_CHANNEL_SLOT, serve: (stream: Duplex) => serveRelayToProxy(stream, relayed.port) } }),
        cwd: command.cwd,
        ...(command.markerFile === undefined ? {} : { markerFile: command.markerFile }),
        ...(descriptors?.markerFd === undefined ? {} : { markerFd: descriptors.markerFd }),
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
        env: { ...command.env, TMPDIR: tmpDir },
        signal,
        killGraceMs: options.killGraceMs,
        signalTerm: signalSandboxTerm,
        ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
        afterExit: async () => throwAll(await attemptAll([() => serially(() => releaseNow(plan)), afterExit])),
      });
    } catch (error) {
      throwAll([error, ...(await attemptAll([() => releaseNow(plan)]))]);
      throw error;
    }
  };

  return {
    kind: 'bubblewrap',
    sweep,
    recover: () =>
      serially(() => recoverPlaceholders(journal, { holders: async () => new Set([...(await holders()), ...held.keys(), ...owned.keys(), ...kept.keys()]) })),
    spawn: (command: SandboxCommand, policy: SandboxPolicy, signal: AbortSignal, descriptors?: SandboxDescriptors): Promise<SandboxedProcess> =>
      serially(async () => {
        await requireBubblewrap(signal);
        for (const root of policy.writableRoots) await assertExistingDirectory(root, directories);
        const planned = { heldPlaceholders: new Set([...held.keys(), ...kept.keys()]), cwd: command.cwd };
        if (command.tmpDir !== undefined) {
          await assertExistingDirectory(command.tmpDir, directories);
          return await launchWith(command, await planBubblewrap(policy, { ...planned, tmpDir: command.tmpDir }, signal, filesystem), command.tmpDir, signal, () => undefined, descriptors);
        }
        const tmpRoot = await settledOrAborted((async () => filesystem.realpath(options.tmpRoot))(), signal);
        const scratch = await filesystem.makeScratchDirectory(tmpRoot, 'sandbox-');
        try {
          const scratchDir = await hostPaths(signal).canonicalPath(scratch.path);
          const plan = await planBubblewrap(policy, { ...planned, scratchDir }, signal, filesystem);
          return await launchWith(command, plan, scratch.path, signal, () => scratch.dispose(), descriptors);
        } catch (error) {
          throwAll([error, ...(await attemptAll([() => scratch.dispose()]))]);
          throw error;
        }
      }, signal),
  };
}
