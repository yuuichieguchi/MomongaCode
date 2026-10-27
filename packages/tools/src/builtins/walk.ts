import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { canonicalizePath } from '@momonga/policy';
import type { FileRuleSet } from '@momonga/foundation';
import { createReadAccessMatcher } from '../read-access.ts';
import type { ReadAccessMatcher, ReadFamilyTool } from '../read-access.ts';
import { isMissing } from './files.ts';

export type WalkEntry = { absolute: string; relative: string };

export type WalkOptions = {
  root: string;
  readDenied: readonly string[];
  readAllowed: readonly string[] | undefined;
  fileRules: FileRuleSet;
  tool: ReadFamilyTool;
  includeSymlinkedFiles: boolean;
  signal: AbortSignal;
  onUnreadable(): void;
};

export type Blocks = {
  blocksResolved(resolved: string): boolean;
  leadsToAllowed(resolved: string): boolean;
  allowedWithin(directory: string): string[];
  isAllowedEntry(resolved: string): boolean;
};

type WalkAccess = Blocks & Pick<ReadAccessMatcher, 'blockedByForms'>;

export type IgnoreFrame = { base: string; rules: Ignore };

const IGNORE_FILE_NAMES = ['.gitignore', '.ignore', '.rgignore'] as const;

export const isPermissionError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
};

const loadIgnoreRules = async (directory: string, base: string, onUnreadable: () => void): Promise<IgnoreFrame | undefined> => {
  let rules: Ignore | undefined;
  for (const name of IGNORE_FILE_NAMES) {
    let text: string;
    try {
      text = await fs.promises.readFile(path.join(directory, name), 'utf8');
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

const byName = (left: fs.Dirent, right: fs.Dirent): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

const nextComponents = (directory: string, denied: Blocks): string[] => {
  const names = denied.allowedWithin(directory).map((allowed) => allowed.slice(directory.length + 1).split(path.sep)[0] as string);
  return [...new Set(names)].sort();
};

export type AllowedRoot = { absolute: string; relative: string; isDirectory: boolean; frames: readonly IgnoreFrame[] };

export async function* reachableAllowedRoots(
  directory: string,
  base: string,
  frames: readonly IgnoreFrame[],
  options: Pick<WalkOptions, 'signal' | 'onUnreadable'>,
  access: Blocks,
): AsyncGenerator<AllowedRoot> {
  options.signal.throwIfAborted();
  const directoryBlocked = access.blocksResolved(directory);
  const own = directoryBlocked ? undefined : await loadIgnoreRules(directory, base, options.onUnreadable);
  const active = own === undefined ? frames : [...frames, own];
  for (const name of nextComponents(directory, access)) {
    const child = path.join(directory, name);
    const stat = await fs.promises.lstat(child).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (stat === undefined || stat.isSymbolicLink()) continue;
    const isDirectory = stat.isDirectory();
    if (!isDirectory && !stat.isFile()) continue;
    const relative = `${base}${name}`;
    if (isIgnored(active, relative, isDirectory)) continue;
    if (access.isAllowedEntry(child)) {
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
  const own = await loadIgnoreRules(directory, base, options.onUnreadable);
  const active = own === undefined ? frames : [...frames, own];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
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
    if (denied.blocksResolved(absolute)) {
      if (entry.isDirectory() && denied.leadsToAllowed(absolute) && !isIgnored(active, relative, true)) {
        yield* walkAllowedRoots(absolute, `${relative}/`, active, options, denied);
      }
      continue;
    }
    if (!entry.isSymbolicLink() && denied.blockedByForms(absolute, absolute, options.tool) !== undefined) continue;
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      if (!options.includeSymlinkedFiles) continue;
      const canonicalTarget = canonicalizePath(absolute);
      if (canonicalTarget === null || denied.blocksResolved(canonicalTarget) || denied.blockedByForms(absolute, canonicalTarget, options.tool) !== undefined) continue;
      const target = await fs.promises.stat(canonicalTarget).catch((error: unknown) => {
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

export const walkFiles = (options: WalkOptions): AsyncGenerator<WalkEntry> => walkDirectory(options.root, '', [], options, createReadAccessMatcher(options));
