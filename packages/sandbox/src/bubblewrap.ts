import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileRuleBlocks } from '@momonga/foundation';
import type { FileRuleEntry, FileRuleSet } from '@momonga/foundation';
import { canonicalizePath } from './canonical-path.ts';
import { SANDBOX_STOP_BOUND_MS, launch } from './process.ts';
import type { LaunchOptions } from './process.ts';
import { SandboxPolicyError } from './policy-error.ts';
import { validateSandboxPolicy } from './profile.ts';
import { identityOf, isStillThePlaceholder } from './placeholder-journal.ts';
import type { PlaceholderIdentity, PlaceholderJournal } from './placeholder-journal.ts';
import { assertExistingDirectory, removePrivateTmpDir } from './scratch.ts';
import type { DirectoryPort } from './scratch.ts';
import type { Sandbox, SandboxCommand, SandboxPolicy, SandboxedProcess } from './types.ts';

export const DEFAULT_BWRAP_PATH = '/usr/bin/bwrap';

export type EntryKind = 'file' | 'directory';

export type Unreachable = 'unreachable';

export type FilesystemPort = {
  kindOf(target: string): EntryKind | undefined | Unreachable;
  isSymbolicLink(target: string): boolean;
  realpath(target: string): string;
  children(directory: string): Array<{ path: string; kind: EntryKind | 'other' }> | Unreachable;
  createPlaceholder(target: string): PlaceholderIdentity;
  removePlaceholder(target: string, identity: PlaceholderIdentity): void;
  requireExecutable(file: string): void;
  makeTempDirectory(parent: string, prefix: string): string;
  removePrivateDirectory(directory: string): void;
};

const inspected = <T>(absent: T, read: () => T): T | Unreachable => {
  try {
    return read();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') return absent;
    if (code === 'ELOOP' || code === 'EACCES') return 'unreachable';
    throw error;
  }
};

export const nodeFilesystemPort: FilesystemPort = {
  requireExecutable: (file) => fs.accessSync(file, fs.constants.X_OK),
  makeTempDirectory: (parent, prefix) => fs.mkdtempSync(path.join(parent, prefix)),
  removePrivateDirectory: removePrivateTmpDir,
  kindOf: (target) =>
    inspected<EntryKind | undefined>(undefined, () => {
      const stat = fs.statSync(target, { throwIfNoEntry: false });
      if (stat === undefined) return undefined;
      return stat.isDirectory() ? 'directory' : 'file';
    }),
  isSymbolicLink: (target) => inspected(false, () => fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() ?? false) === true,
  realpath: (target) => fs.realpathSync(target),
  createPlaceholder: (target) => {
    fs.closeSync(fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, PLACEHOLDER_MODE));
    return identityOf(target);
  },
  removePlaceholder: (target, identity) => {
    if (isStillThePlaceholder(target, identity)) fs.unlinkSync(target);
  },
  children: (directory) =>
    inspected<Array<{ path: string; kind: EntryKind | 'other' }>>([], () =>
      fs.readdirSync(directory, { withFileTypes: true }).map((entry) => ({
        path: path.join(directory, entry.name),
        kind: entry.isSymbolicLink() ? 'other' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      })),
    ),
};

export type BubblewrapOptions = { tmpDir?: string; scratchDir?: string; cwd: string; heldPlaceholders?: ReadonlySet<string> };

export type BubblewrapPlan = { args: string[]; placeholders: string[] };

type Mount = { depth: number; args: string[] };

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const depthOf = (target: string): number => target.split('/').filter((part) => part !== '').length;

const byDepth = (mounts: readonly Mount[]): string[] => [...mounts].sort((left, right) => left.depth - right.depth).flatMap((mount) => mount.args);

const PLACEHOLDER_MODE = 0o644;

const MODULE_PINNED_ENTRIES = ['hooks', 'config', 'config.worktree'] as const;

const SYSTEMD_RESOLVE_DIRECTORY = '/run/systemd/resolve';

const isUserDeny = (entry: FileRuleEntry): boolean =>
  entry.effect === 'deny' && entry.unresolved === null && (entry.tool === 'Read' || entry.tool === 'Edit');

const forms = (entry: FileRuleEntry): Array<{ directory: string }> => [
  { directory: entry.anchorDirectory },
  ...(entry.denyLexical === null ? [] : [{ directory: entry.lexicalDirectory }]),
];

type Inspector = {
  kindOf(target: string): EntryKind | undefined;
  children(directory: string): Array<{ path: string; kind: EntryKind | 'other' }>;
};

const blockedPaths = (set: FileRuleSet, entry: FileRuleEntry, port: Inspector): string[] => {
  const found: string[] = [];
  const visit = (candidate: string, kind: EntryKind | 'other'): void => {
    const blocked = fileRuleBlocks(set, entry, candidate, candidate);
    if (blocked) found.push(candidate);
    if (kind !== 'directory') return;
    const wholeDirectoryBlocked = blocked && (entry.exceptions.length === 0 || entry.blockedAsWhole);
    if (wholeDirectoryBlocked) return;
    for (const child of port.children(candidate)) visit(child.path, child.kind);
  };
  for (const { directory } of forms(entry)) {
    const kind = port.kindOf(directory);
    if (kind !== 'directory') continue;
    visit(directory, 'directory');
  }
  return unique(found);
};

export function planBubblewrap(policy: SandboxPolicy, options: BubblewrapOptions, port: FilesystemPort = nodeFilesystemPort): BubblewrapPlan {
  validateSandboxPolicy(policy, options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir });
  const heldPlaceholders = options.heldPlaceholders ?? new Set<string>();
  const canonicalize = (target: string): string => {
    const placeholder = [...heldPlaceholders].find((held) => target.startsWith(`${held}/`));
    if (placeholder === undefined) return canonicalizePath(target);
    return path.join(canonicalizePath(path.dirname(placeholder)), path.basename(placeholder), path.relative(placeholder, target));
  };
  const roots = unique(policy.writableRoots.map(canonicalizePath));
  const writeDenied = unique(policy.writeDenied.map(canonicalize));
  const readDenied = unique(policy.readDenied.map(canonicalize));
  const readAllowed = unique((policy.readAllowed ?? []).map(canonicalize));
  const sessionTmpDir = options.tmpDir === undefined ? undefined : canonicalizePath(options.tmpDir);
  const scratchDir = options.scratchDir === undefined ? undefined : canonicalizePath(options.scratchDir);
  const placeholders: string[] = [];

  const base: string[] = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/run'];
  if (policy.network === 'allow' && port.kindOf(SYSTEMD_RESOLVE_DIRECTORY) === 'directory') {
    base.push('--ro-bind', SYSTEMD_RESOLVE_DIRECTORY, SYSTEMD_RESOLVE_DIRECTORY);
  }

  const writableBinds: string[] = roots.flatMap((root) => ['--bind', root, root]);
  const wideningAreas: string[] = [];
  for (const entry of policy.fileRules.entries) {
    if (!entry.widening) continue;
    const closure = entry.subset.closure;
    const closureKind = closure.kind === 'subpath' ? port.kindOf(closure.path) : undefined;
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
    kindOf: (target) => {
      const kind = port.kindOf(target);
      if (kind !== 'unreachable') return kind;
      refuseUnreachable(target);
      return undefined;
    },
    children: (directory) => {
      const found = port.children(directory);
      if (found !== 'unreachable') return found;
      refuseUnreachable(directory);
      return [];
    },
  };
  const kindOf = inspector.kindOf;

  const firstMissingComponent = (target: string): string | undefined => {
    let missing = target;
    for (let parent = path.dirname(missing); parent !== missing; parent = path.dirname(missing)) {
      const kind = kindOf(parent);
      if (kind === 'directory') return missing;
      if (kind === 'file') return heldPlaceholders.has(parent) ? parent : undefined;
      missing = parent;
    }
    return undefined;
  };

  const reserve = (target: string, mounts: Mount[]): void => {
    const missing = firstMissingComponent(target);
    if (missing === undefined || !insideRoots(missing) || placeholders.includes(missing)) return;
    placeholders.push(missing);
    mounts.push({ depth: depthOf(missing), args: ['--ro-bind', '/dev/null', missing] });
  };

  const mounted: string[] = [];

  const protect = (target: string, mounts: Mount[]): void => {
    if (insideRoots(target) && port.isSymbolicLink(target)) {
      throw new SandboxPolicyError('protected_link_not_pinnable', `bubblewrap cannot pin the symbolic link ${target}: a mount cannot sit on a link name, so the link could be replaced from inside the sandbox`, { path: target });
    }
    const kind = kindOf(target);
    if (kind === undefined) {
      reserve(target, mounts);
      return;
    }
    const resolved = port.realpath(target);
    if (heldPlaceholders.has(resolved) && !placeholders.includes(resolved)) placeholders.push(resolved);
    mounted.push(resolved);
    mounts.push({ depth: depthOf(resolved), args: ['--ro-bind', resolved, resolved] });
  };

  const writeMounts: Mount[] = [];
  const literals = unique([...policy.writeDeniedLiterals, ...policy.protectedSet.literals]);
  for (const target of [...writeDenied, ...literals]) protect(target, writeMounts);
  const userDenies = [...policy.fileRules.entries, ...policy.protectedSet.patterns.entries].filter(isUserDeny);
  for (const entry of userDenies.filter((candidate) => candidate.access === 'write')) {
    const set = policy.protectedSet.patterns.entries.includes(entry) ? policy.protectedSet.patterns : policy.fileRules;
    for (const target of blockedPaths(set, entry, inspector)) protect(target, writeMounts);
  }
  const readOnlyDirectories = new Set<string>();
  const isGitDirectory = (directory: string): boolean =>
    kindOf(path.join(directory, 'HEAD')) === 'file' && kindOf(path.join(directory, 'objects')) === 'directory' && kindOf(path.join(directory, 'refs')) === 'directory';
  const anchorModules = (anchor: string): void => {
    if (!insideRoots(anchor)) return;
    if (kindOf(anchor) !== 'directory') {
      protect(anchor, writeMounts);
      return;
    }
    readOnlyDirectories.add(anchor);
    writeMounts.push({ depth: depthOf(anchor), args: ['--ro-bind', anchor, anchor] });
    walkModules(anchor);
  };
  const walkModules = (directory: string): void => {
    for (const child of inspector.children(directory)) {
      if (child.kind !== 'directory') continue;
      if (!isGitDirectory(child.path)) {
        readOnlyDirectories.add(child.path);
        walkModules(child.path);
        continue;
      }
      writeMounts.push({ depth: depthOf(child.path), args: ['--bind', child.path, child.path] });
      for (const name of MODULE_PINNED_ENTRIES) protect(path.join(child.path, name), writeMounts);
      anchorModules(path.join(child.path, 'modules'));
      pinWorktrees(path.join(child.path, 'worktrees'));
    }
  };
  const pinWorktrees = (anchor: string): void => {
    if (!insideRoots(anchor) || kindOf(anchor) !== 'directory') return;
    for (const child of inspector.children(anchor)) if (child.kind === 'directory') protect(path.join(child.path, 'config.worktree'), writeMounts);
  };
  for (const anchor of policy.protectedSet.moduleAnchors) anchorModules(anchor);
  for (const anchor of policy.protectedSet.worktreeAnchors) pinWorktrees(anchor);
  const pinMounts: Mount[] = [];
  const pinned = [...unique(mounted), ...unique(placeholders)];
  const pinnedAncestors = new Set<string>();
  for (const target of pinned) {
    for (let ancestor = path.dirname(target); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
      const inside = insideRoots(ancestor);
      if (!inside || pinnedAncestors.has(ancestor)) continue;
      if (!writableAreas.includes(ancestor) && !readOnlyDirectories.has(ancestor) && kindOf(ancestor) === 'directory') {
        pinnedAncestors.add(ancestor);
        pinMounts.push({ depth: depthOf(ancestor), args: ['--bind', ancestor, ancestor] });
      }
    }
  }

  const readMounts: Mount[] = [];
  const maskedDirectories: string[] = [];
  const mask = (target: string): void => {
    const kind = kindOf(target);
    if (kind === undefined) return;
    const resolved = port.realpath(target);
    if (kind === 'directory') maskedDirectories.push(resolved);
    readMounts.push({ depth: depthOf(resolved), args: kind === 'directory' ? ['--tmpfs', resolved] : ['--ro-bind', '/dev/null', resolved] });
  };
  for (const target of readDenied) mask(target);
  for (const entry of userDenies.filter((candidate) => candidate.access === 'read')) {
    const set = policy.protectedSet.patterns.entries.includes(entry) ? policy.protectedSet.patterns : policy.fileRules;
    for (const target of blockedPaths(set, entry, inspector)) mask(target);
  }
  const reallow: string[] = readAllowed.flatMap((target) => (kindOf(target) === undefined ? [] : ['--ro-bind', target, target]));

  const scratch: string[] = [...new Set([...(sessionTmpDir === undefined ? [] : [sessionTmpDir]), ...(scratchDir === undefined ? [] : [scratchDir])])].flatMap((dir) => [
    '--bind',
    dir,
    dir,
  ]);

  const args = [
    '--unshare-pid',
    '--unshare-ipc',
    ...(policy.network === 'deny' ? ['--unshare-net'] : []),
    '--die-with-parent',
    ...base,
    ...writableBinds,
    ...byDepth([...pinMounts, ...writeMounts]),
    ...byDepth(readMounts),
    ...reallow,
    ...scratch,
    ...unique(maskedDirectories).flatMap((directory) => ['--remount-ro', directory]),
    '--chdir',
    options.cwd,
  ];
  return { args, placeholders: unique(placeholders) };
}

export const BWRAP_PROBE_TIMEOUT_MS = SANDBOX_STOP_BOUND_MS;

export const bwrapProbeArguments = (shell: string): string[] => [
  '--unshare-pid',
  '--unshare-ipc',
  '--unshare-net',
  '--die-with-parent',
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--tmpfs',
  '/run',
  '--',
  shell,
  '-c',
  ':',
];

export type ProbeRunner = (file: string, args: readonly string[], timeoutMs: number) => { status: number | null; stderr: string; timedOut: boolean };

export type BubblewrapProbe = { ok: true } | { ok: false; stderr: string };

export type BubblewrapProbeOptions = { timeoutMs?: number; run?: ProbeRunner };

const nodeProbeRunner: ProbeRunner = (file, args, timeoutMs) => {
  const done = spawnSync(file, [...args], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (done.error !== undefined && (done.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') throw done.error;
  return { status: done.status, stderr: done.stderr, timedOut: done.error !== undefined };
};

export const probeBubblewrap = (bwrapPath: string, shell: string, { timeoutMs = BWRAP_PROBE_TIMEOUT_MS, run = nodeProbeRunner }: BubblewrapProbeOptions = {}): BubblewrapProbe => {
  const { status, stderr, timedOut } = run(bwrapPath, bwrapProbeArguments(shell), timeoutMs);
  if (timedOut) return { ok: false, stderr: `bwrap did not finish within ${timeoutMs} ms` };
  if (status === 0) return { ok: true };
  return { ok: false, stderr: status === null ? 'bwrap ended without an exit status' : stderr.trim() };
};

export interface BubblewrapSandboxOptions {
  bwrapPath?: string;
  tmpRoot: string;
  killGraceMs: number;
  filesystem?: FilesystemPort;
  journal: PlaceholderJournal;
  holders: () => ReadonlySet<string>;
  spawnProcess?: LaunchOptions['spawnProcess'];
}

export function createBubblewrapSandbox(options: BubblewrapSandboxOptions): Sandbox {
  const bwrapPath = options.bwrapPath ?? DEFAULT_BWRAP_PATH;
  const filesystem = options.filesystem ?? nodeFilesystemPort;
  filesystem.requireExecutable(bwrapPath);
  const tmpRoot = filesystem.realpath(options.tmpRoot);
  const directories: DirectoryPort = { isDirectory: (target) => filesystem.kindOf(target) === 'directory' };
  const held = new Map<string, number>();
  const { journal, holders } = options;
  const owned = new Map<string, PlaceholderIdentity | undefined>();
  const kept = new Map<string, PlaceholderIdentity | undefined>();

  const attemptAll = (steps: ReadonlyArray<() => void>): unknown[] => {
    const failures: unknown[] = [];
    for (const step of steps) {
      try {
        step();
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

  const remove = (placeholder: string, identity: PlaceholderIdentity | undefined): void => {
    if (identity !== undefined) filesystem.removePlaceholder(placeholder, identity);
    journal.forget(placeholder);
  };
  const discard = (placeholder: string): void => {
    const identity = owned.get(placeholder);
    owned.delete(placeholder);
    if (holders().has(placeholder)) {
      kept.set(placeholder, identity);
      return;
    }
    remove(placeholder, identity);
  };
  const sweepKept = (): void => {
    if (kept.size === 0) return;
    const stillHeld = holders();
    const releasable = [...kept].filter(([placeholder]) => !stillHeld.has(placeholder));
    throwAll(
      attemptAll(
        releasable.map(([placeholder, identity]) => () => {
          remove(placeholder, identity);
          kept.delete(placeholder);
        }),
      ),
    );
  };
  const hold = (plan: BubblewrapPlan): void => {
    const begun: string[] = [];
    try {
      for (const placeholder of plan.placeholders.filter((candidate) => !held.has(candidate))) {
        journal.intend(placeholder, Date.now());
        begun.push(placeholder);
        owned.set(placeholder, undefined);
        const identity = filesystem.createPlaceholder(placeholder);
        owned.set(placeholder, identity);
        journal.complete(placeholder, identity);
      }
    } catch (error) {
      const failures = attemptAll(begun.map((placeholder) => () => remove(placeholder, owned.get(placeholder))));
      for (const placeholder of begun) owned.delete(placeholder);
      throwAll([error, ...failures]);
    }
    for (const placeholder of plan.placeholders) held.set(placeholder, (held.get(placeholder) ?? 0) + 1);
  };
  const release = (plan: BubblewrapPlan): void => {
    const steps: Array<() => void> = [];
    for (const placeholder of plan.placeholders) {
      const remaining = (held.get(placeholder) ?? 1) - 1;
      if (remaining > 0) {
        held.set(placeholder, remaining);
        continue;
      }
      held.delete(placeholder);
      steps.push(() => discard(placeholder));
    }
    steps.push(sweepKept);
    throwAll(attemptAll(steps));
  };
  const launchWith = (command: SandboxCommand, plan: BubblewrapPlan, tmpDir: string, signal: AbortSignal, afterExit: () => void): SandboxedProcess => {
    hold(plan);
    try {
      return launch({
        file: bwrapPath,
        args: [...plan.args, '--', ...command.argv],
        cwd: command.cwd,
        ...(command.markerFile === undefined ? {} : { markerFile: command.markerFile }),
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
        env: { ...command.env, TMPDIR: tmpDir },
        signal,
        killGraceMs: options.killGraceMs,
        ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
        afterExit: () => throwAll(attemptAll([() => release(plan), afterExit])),
      });
    } catch (error) {
      throwAll([error, ...attemptAll([() => release(plan)])]);
      throw error;
    }
  };

  return {
    kind: 'bubblewrap',
    sweep: sweepKept,
    spawn(command: SandboxCommand, policy: SandboxPolicy, signal: AbortSignal): SandboxedProcess {
      for (const root of policy.writableRoots) assertExistingDirectory(root, directories);
      const planned = { heldPlaceholders: new Set(held.keys()), cwd: command.cwd };
      if (command.tmpDir !== undefined) {
        assertExistingDirectory(command.tmpDir, directories);
        return launchWith(command, planBubblewrap(policy, { ...planned, tmpDir: command.tmpDir }, filesystem), command.tmpDir, signal, () => undefined);
      }
      const tmpDir = filesystem.makeTempDirectory(tmpRoot, 'sandbox-');
      try {
        const scratchDir = canonicalizePath(tmpDir);
        const plan = planBubblewrap(policy, { ...planned, scratchDir }, filesystem);
        return launchWith(command, plan, tmpDir, signal, () => filesystem.removePrivateDirectory(tmpDir));
      } catch (error) {
        filesystem.removePrivateDirectory(tmpDir);
        throw error;
      }
    },
  };
}
