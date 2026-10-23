import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { canonicalizePath } from '@momonga/policy';
import { createReadDeniedMatcher } from '../read-denied.ts';
import { isMissing } from './files.ts';

export type WalkEntry = { absolute: string; relative: string };

export type WalkOptions = {
  root: string;
  readDenied: readonly string[];
  includeSymlinkedFiles: boolean;
  signal: AbortSignal;
  onUnreadable(): void;
};

type Blocks = { blocksResolved(resolved: string): boolean };

type IgnoreFrame = { base: string; rules: Ignore };

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

async function* walkDirectory(
  directory: string,
  base: string,
  frames: readonly IgnoreFrame[],
  options: WalkOptions,
  denied: Blocks,
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
    if (denied.blocksResolved(absolute)) continue;
    const relative = `${base}${entry.name}`;
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      if (!options.includeSymlinkedFiles) continue;
      const canonicalTarget = canonicalizePath(absolute);
      if (canonicalTarget === null || denied.blocksResolved(canonicalTarget)) continue;
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

export const walkFiles = (options: WalkOptions): AsyncGenerator<WalkEntry> => walkDirectory(options.root, '', [], options, createReadDeniedMatcher(options.readDenied, options.root));
