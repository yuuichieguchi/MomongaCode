import fs from 'node:fs';
import path from 'node:path';
import { fileRuleBlocks } from '@momonga/foundation';
import type { FileRuleEntry, FileRuleSet } from '@momonga/foundation';
import { canonicalizePath } from './canonical-path.ts';
import { launch } from './process.ts';
import { validateSandboxPolicy } from './profile.ts';
import { assertExistingDirectory, removePrivateTmpDir } from './scratch.ts';
import type { Sandbox, SandboxCommand, SandboxPolicy, SandboxedProcess } from './types.ts';

export const DEFAULT_BWRAP_PATH = '/usr/bin/bwrap';

export type EntryKind = 'file' | 'directory';

export type FilesystemPort = {
  kindOf(target: string): EntryKind | undefined;
  realpath(target: string): string;
  children(directory: string): Array<{ path: string; kind: EntryKind | 'other' }>;
};

export const nodeFilesystemPort: FilesystemPort = {
  kindOf: (target) => {
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (stat === undefined) return undefined;
    return stat.isDirectory() ? 'directory' : 'file';
  },
  realpath: (target) => fs.realpathSync(target),
  children: (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).map((entry) => ({
      path: path.join(directory, entry.name),
      kind: entry.isSymbolicLink() ? 'other' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    })),
};

export type BubblewrapOptions = { tmpDir?: string; scratchDir?: string; cwd: string };

export type BubblewrapPlan = { args: string[]; unprotected: string[] };

type Mount = { depth: number; args: string[] };

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const depthOf = (target: string): number => target.split('/').filter((part) => part !== '').length;

const byDepth = (mounts: readonly Mount[]): string[] => [...mounts].sort((left, right) => left.depth - right.depth).flatMap((mount) => mount.args);

const SYSTEMD_RESOLVE_DIRECTORY = '/run/systemd/resolve';

const isUserDeny = (entry: FileRuleEntry): boolean =>
  entry.effect === 'deny' && entry.unresolved === null && (entry.tool === 'Read' || entry.tool === 'Edit');

const forms = (entry: FileRuleEntry): Array<{ directory: string }> => [
  { directory: entry.anchorDirectory },
  ...(entry.denyLexical === null ? [] : [{ directory: entry.lexicalDirectory }]),
];

const blockedPaths = (set: FileRuleSet, entry: FileRuleEntry, port: FilesystemPort): string[] => {
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
  const roots = unique(policy.writableRoots.map(canonicalizePath));
  const writeDenied = unique(policy.writeDenied.map(canonicalizePath));
  const readDenied = unique(policy.readDenied.map(canonicalizePath));
  const readAllowed = unique((policy.readAllowed ?? []).map(canonicalizePath));
  const sessionTmpDir = options.tmpDir === undefined ? undefined : canonicalizePath(options.tmpDir);
  const scratchDir = options.scratchDir === undefined ? undefined : canonicalizePath(options.scratchDir);
  const unprotected: string[] = [];

  const base: string[] = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/run'];
  if (policy.network === 'allow' && port.kindOf(SYSTEMD_RESOLVE_DIRECTORY) === 'directory') {
    base.push('--ro-bind', SYSTEMD_RESOLVE_DIRECTORY, SYSTEMD_RESOLVE_DIRECTORY);
  }

  const writableBinds: string[] = roots.flatMap((root) => ['--bind', root, root]);
  for (const entry of policy.fileRules.entries) {
    if (!entry.widening) continue;
    const closure = entry.subset.closure;
    if (closure.kind === 'subpath' && port.kindOf(closure.path) !== undefined) writableBinds.push('--bind', closure.path, closure.path);
  }

  const protect = (target: string, mounts: Mount[]): void => {
    const kind = port.kindOf(target);
    if (kind === undefined) {
      unprotected.push(target);
      return;
    }
    const resolved = port.realpath(target);
    mounts.push({ depth: depthOf(resolved), args: ['--ro-bind', resolved, resolved] });
  };

  const writeMounts: Mount[] = [];
  const literals = unique([...policy.writeDeniedLiterals, ...policy.protectedSet.literals]);
  for (const target of [...writeDenied, ...literals]) protect(target, writeMounts);
  const userDenies = [...policy.fileRules.entries, ...policy.protectedSet.patterns.entries].filter(isUserDeny);
  for (const entry of userDenies.filter((candidate) => candidate.access === 'write')) {
    const set = policy.protectedSet.patterns.entries.includes(entry) ? policy.protectedSet.patterns : policy.fileRules;
    for (const target of blockedPaths(set, entry, port)) protect(target, writeMounts);
  }
  const pinMounts: Mount[] = [];
  for (const target of unique([...writeDenied, ...literals]).flatMap((literal) => (port.kindOf(literal) === undefined ? [] : [literal]))) {
    for (let ancestor = path.dirname(port.realpath(target)); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
      const inside = roots.some((root) => ancestor.startsWith(`${root}/`));
      if (inside && !roots.includes(ancestor) && port.kindOf(ancestor) === 'directory') pinMounts.push({ depth: depthOf(ancestor), args: ['--bind', ancestor, ancestor] });
    }
  }

  const readMounts: Mount[] = [];
  const mask = (target: string): void => {
    const kind = port.kindOf(target);
    if (kind === undefined) return;
    const resolved = port.realpath(target);
    readMounts.push({ depth: depthOf(resolved), args: kind === 'directory' ? ['--tmpfs', resolved] : ['--ro-bind', '/dev/null', resolved] });
  };
  for (const target of readDenied) mask(target);
  for (const entry of userDenies.filter((candidate) => candidate.access === 'read')) {
    const set = policy.protectedSet.patterns.entries.includes(entry) ? policy.protectedSet.patterns : policy.fileRules;
    for (const target of blockedPaths(set, entry, port)) mask(target);
  }
  const reallow: string[] = readAllowed.flatMap((target) => (port.kindOf(target) === undefined ? [] : ['--ro-bind', target, target]));

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
    '--chdir',
    options.cwd,
  ];
  return { args, unprotected: unique(unprotected) };
}

export interface BubblewrapSandboxOptions {
  bwrapPath?: string;
  tmpRoot: string;
  killGraceMs: number;
  filesystem?: FilesystemPort;
}

export function createBubblewrapSandbox(options: BubblewrapSandboxOptions): Sandbox {
  const bwrapPath = options.bwrapPath ?? DEFAULT_BWRAP_PATH;
  fs.accessSync(bwrapPath, fs.constants.X_OK);
  const tmpRoot = fs.realpathSync(options.tmpRoot);
  const filesystem = options.filesystem ?? nodeFilesystemPort;
  const launchWith = (command: SandboxCommand, plan: BubblewrapPlan, tmpDir: string, signal: AbortSignal, afterExit: () => void): SandboxedProcess =>
    launch({
      file: bwrapPath,
      args: [...plan.args, '--', ...command.argv],
      cwd: command.cwd,
      ...(command.markerFile === undefined ? {} : { markerFile: command.markerFile }),
      env: { ...command.env, TMPDIR: tmpDir },
      signal,
      killGraceMs: options.killGraceMs,
      afterExit,
    });

  return {
    kind: 'bubblewrap',
    spawn(command: SandboxCommand, policy: SandboxPolicy, signal: AbortSignal): SandboxedProcess {
      for (const root of policy.writableRoots) assertExistingDirectory(root);
      if (command.tmpDir !== undefined) {
        assertExistingDirectory(command.tmpDir);
        return launchWith(command, planBubblewrap(policy, { tmpDir: command.tmpDir, cwd: command.cwd }, filesystem), command.tmpDir, signal, () => undefined);
      }
      const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'sandbox-'));
      try {
        const scratchDir = canonicalizePath(tmpDir);
        const plan = planBubblewrap(policy, { scratchDir, cwd: command.cwd }, filesystem);
        return launchWith(command, plan, tmpDir, signal, () => removePrivateTmpDir(tmpDir));
      } catch (error) {
        removePrivateTmpDir(tmpDir);
        throw error;
      }
    },
  };
}
