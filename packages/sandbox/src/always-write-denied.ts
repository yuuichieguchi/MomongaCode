import fs from 'node:fs';
import path from 'node:path';
import { isTransientErrno, momongaLayout } from '@momonga/foundation';
import { canonicalizePath } from './canonical-path.ts';

const LAUNCHER_LINKS_MAX_BYTES = 64 * 1024;

export type LauncherLinksStatus =
  | { status: 'absent' }
  | { status: 'read' }
  | { status: 'ignored'; reason: 'symlink' | 'not_regular' | 'too_large' };

export interface AlwaysWriteDenied {
  root: string;
  keychains: string;
  subtrees: readonly string[];
  literals: readonly string[];
  launcherLinks: LauncherLinksStatus;
}

export function canonicalParentForm(literal: string): string {
  try {
    return path.join(canonicalizePath(path.dirname(literal)), path.basename(literal));
  } catch (error) {
    if (isTransientErrno(error)) throw error;
    return literal;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeLine(line: Buffer): string | undefined {
  try {
    return utf8.decode(line);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

function recordedLinks(content: Buffer): string[] {
  const links: string[] = [];
  let start = 0;
  while (start <= content.length) {
    const newline = content.indexOf(0x0a, start);
    const end = newline === -1 ? content.length : newline;
    const text = decodeLine(content.subarray(start, end));
    start = end + 1;
    if (text === undefined || text.includes('\0') || text.trim() === '' || !path.isAbsolute(text)) continue;
    links.push(text);
  }
  return links;
}

function readLauncherLinks(file: string): { links: string[]; launcherLinks: LauncherLinksStatus } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { links: [], launcherLinks: { status: 'absent' } };
    throw error;
  }
  if (stat.isSymbolicLink()) return { links: [], launcherLinks: { status: 'ignored', reason: 'symlink' } };
  if (!stat.isFile()) return { links: [], launcherLinks: { status: 'ignored', reason: 'not_regular' } };
  if (stat.size > LAUNCHER_LINKS_MAX_BYTES) return { links: [], launcherLinks: { status: 'ignored', reason: 'too_large' } };
  return { links: recordedLinks(fs.readFileSync(file)), launcherLinks: { status: 'read' } };
}

export function alwaysWriteDenied(home: string): AlwaysWriteDenied {
  const paths = momongaLayout(home);
  const { links, launcherLinks } = readLauncherLinks(path.join(paths.root, 'bin', 'launcher-links'));
  const lexical = [paths.launcher, ...links];
  return {
    root: paths.root,
    keychains: paths.keychains,
    subtrees: [paths.root, paths.keychains],
    literals: [...new Set(lexical.flatMap((link) => [link, canonicalParentForm(link)]))],
    launcherLinks,
  };
}
