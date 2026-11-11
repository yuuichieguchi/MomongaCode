import path from 'node:path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { hostPaths } from '@momonga/foundation';
import type { FileRuleSet, FileSystem } from '@momonga/foundation';
import { createReadAccessMatcher } from '../read-access.ts';
import type { ReadAccessMatcher, ReadFamilyTool } from '../read-access.ts';
import { isMissing } from './files.ts';

export type WalkEntry = { absolute: string; relative: string };

type Dirent = Awaited<ReturnType<FileSystem['readdirEntries']>>[number];

export type WalkFiles = Pick<FileSystem, 'readTextFile' | 'lstat' | 'stat' | 'readdirEntries'>;

export type WalkOptions = {
  files: WalkFiles;
  root: string;
  readDenied: readonly string[];
  readAllowed: readonly string[] | undefined;
  fileRules: FileRuleSet;
  tool: ReadFamilyTool;
  includeSymlinkedFiles: boolean;
  signal: AbortSignal;
  onUnreadable(): void;
  onRuleBlocked(entry: RuleBlockedEntry): void;
};

export type RuleBlockedEntry = { absolute: string; isDirectory: boolean };

export type Blocks = {
  blocksResolved(resolved: string): Promise<boolean>;
  leadsToAllowed(resolved: string): Promise<boolean>;
  allowedWithin(directory: string): Promise<string[]>;
  isAllowedEntry(resolved: string): Promise<boolean>;
};

type WalkAccess = Blocks & Pick<ReadAccessMatcher, 'blockedByForms'>;

export type IgnoreFrame = { base: string; rules: Ignore };

const IGNORE_FILE_NAMES = ['.gitignore', '.ignore', '.rgignore'] as const;

export const isPermissionError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
};

const loadIgnoreRules = async (files: WalkFiles, directory: string, base: string, onUnreadable: () => void): Promise<IgnoreFrame | undefined> => {
  let rules: Ignore | undefined;
  for (const name of IGNORE_FILE_NAMES) {
    let text: string;
    try {
      text = await files.readTextFile(path.join(directory, name));
    } catch (error) {
      if (isMissing(error)) continue;
      if (isPermissionError(error)) {
        onUnreadable();
        continue;
      }
      throw error;
    }
    rules ??= ignore();
    rules.add(text);
  }
  return rules === undefined ? undefined : { base, rules };
};

const isIgnored = (frames: readonly IgnoreFrame[], relative: string, isDirectory: boolean): boolean => {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index] as IgnoreFrame;
    const local = relative.slice(frame.base.length);
    const verdict = frame.rules.test(isDirectory ? `${local}/` : local);
    if (verdict.ignored) return true;
    if (verdict.unignored) return false;
  }
  return false;
};

const byName = (left: Dirent, right: Dirent): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

const nextComponents = async (directory: string, denied: Blocks): Promise<string[]> => {
  const names = (await denied.allowedWithin(directory)).map((allowed) => allowed.slice(directory.length + 1).split(path.sep)[0] as string);
  return [...new Set(names)].sort();
};

export type AllowedRoot = { absolute: string; relative: string; isDirectory: boolean; frames: readonly IgnoreFrame[] };

export async function* reachableAllowedRoots(
  directory: string,
  base: string,
  frames: readonly IgnoreFrame[],
  options: Pick<WalkOptions, 'files' | 'signal' | 'onUnreadable'>,
  access: Blocks,
): AsyncGenerator<AllowedRoot> {
  options.signal.throwIfAborted();
  const directoryBlocked = await access.blocksResolved(directory);
  const own = directoryBlocked ? undefined : await loadIgnoreRules(options.files, directory, base, options.onUnreadable);
  const active = own === undefined ? frames : [...frames, own];
  for (const name of await nextComponents(directory, access)) {
    const child = path.join(directory, name);
    const stat = await options.files.lstat(child).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (stat === undefined || stat.isSymbolicLink()) continue;
    const isDirectory = stat.isDirectory();
    if (!isDirectory && !stat.isFile()) continue;
    const relative = `${base}${name}`;
    if (isIgnored(active, relative, isDirectory)) continue;
    if (await access.isAllowedEntry(child)) {
      if (directoryBlocked) yield { absolute: child, relative, isDirectory, frames: active };
    } else if (isDirectory) yield* reachableAllowedRoots(child, `${relative}/`, active, options, access);
  }
}

async function* walkAllowedRoots(
  directory: string,
  base: string,
  frames: readonly IgnoreFrame[],
  options: WalkOptions,
  denied: WalkAccess,
): AsyncGenerator<WalkEntry> {
  for await (const root of reachableAllowedRoots(directory, base, frames, options, denied)) {
    if (root.isDirectory) yield* walkDirectory(root.absolute, `${root.relative}/`, root.frames, options, denied);
    else yield { absolute: root.absolute, relative: root.relative };
  }
}

async function* walkDirectory(
  directory: string,
  base: string,
  frames: readonly IgnoreFrame[],
  options: WalkOptions,
  denied: WalkAccess,
): AsyncGenerator<WalkEntry> {
  options.signal.throwIfAborted();
  const own = await loadIgnoreRules(options.files, directory, base, options.onUnreadable);
  const active = own === undefined ? frames : [...frames, own];
  let entries: Dirent[];
  try {
    entries = await options.files.readdirEntries(directory);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    options.onUnreadable();
    return;
  }
  entries.sort(byName);
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    const relative = `${base}${entry.name}`;
    if (await denied.blocksResolved(absolute)) {
      if (entry.isDirectory() && (await denied.leadsToAllowed(absolute)) && !isIgnored(active, relative, true)) {
        yield* walkAllowedRoots(absolute, `${relative}/`, active, options, denied);
      }
      continue;
    }
    if (!entry.isSymbolicLink() && denied.blockedByForms(absolute, absolute, options.tool) !== undefined) {
      if (!isIgnored(active, relative, entry.isDirectory())) options.onRuleBlocked({ absolute, isDirectory: entry.isDirectory() });
      continue;
    }
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      if (!options.includeSymlinkedFiles) continue;
      const resolution = await hostPaths(options.signal).resolveCanonicalPath(absolute);
      if (!resolution.ok) continue;
      const canonicalTarget = resolution.path;
      if ((await denied.blocksResolved(canonicalTarget)) || denied.blockedByForms(absolute, canonicalTarget, options.tool) !== undefined) continue;
      const target = await options.files.stat(canonicalTarget).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (target === undefined || !target.isFile()) continue;
      isDirectory = false;
      isFile = true;
    }
    if (isDirectory) {
      if (isIgnored(active, relative, true)) continue;
      yield* walkDirectory(absolute, `${relative}/`, active, options, denied);
    } else if (isFile) {
      if (isIgnored(active, relative, false)) continue;
      yield { absolute, relative };
    }
  }
}

export async function* walkFiles(options: WalkOptions): AsyncGenerator<WalkEntry> {
  yield* walkDirectory(options.root, '', [], options, await createReadAccessMatcher(options, hostPaths(options.signal)));
}
