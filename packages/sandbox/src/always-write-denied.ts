import path from 'node:path';
import { hostPaths, isTransientErrno, nodeFileSystem, secretLocationsIn, settledOrAborted } from '@momonga/foundation';
import type { PathResolver, MomongaPaths } from '@momonga/foundation';

const LAUNCHER_LINKS_MAX_BYTES = 64 * 1024;

export type LauncherLinksStatus =
  | { status: 'absent' }
  | { status: 'read' }
  | { status: 'ignored'; reason: 'symlink' | 'not_regular' | 'too_large' };

export interface AlwaysWriteDenied {
  root: string;
  keychains: string;
  executables: string;
  subtrees: readonly string[];
  readDenied: readonly string[];
  literals: readonly string[];
  launcherLinks: LauncherLinksStatus;
}

export async function canonicalParentForm(literal: string, paths: Pick<PathResolver, 'canonicalPath'>): Promise<string> {
  try {
    return path.join(await paths.canonicalPath(path.dirname(literal)), path.basename(literal));
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

async function readLauncherLinks(file: string, signal: AbortSignal): Promise<{ links: string[]; launcherLinks: LauncherLinksStatus }> {
  let stat: Awaited<ReturnType<typeof nodeFileSystem.lstat>>;
  try {
    stat = await settledOrAborted(nodeFileSystem.lstat(file), signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { links: [], launcherLinks: { status: 'absent' } };
    throw error;
  }
  if (stat.isSymbolicLink()) return { links: [], launcherLinks: { status: 'ignored', reason: 'symlink' } };
  if (!stat.isFile()) return { links: [], launcherLinks: { status: 'ignored', reason: 'not_regular' } };
  if (stat.size > LAUNCHER_LINKS_MAX_BYTES) return { links: [], launcherLinks: { status: 'ignored', reason: 'too_large' } };
  return { links: recordedLinks(Buffer.from(await settledOrAborted(nodeFileSystem.readFile(file), signal))), launcherLinks: { status: 'read' } };
}

export type OwnedLayout = Pick<MomongaPaths, 'home' | 'root' | 'launcher' | 'keychains' | 'executables'>;

export async function alwaysWriteDenied(paths: OwnedLayout, signal: AbortSignal): Promise<AlwaysWriteDenied> {
  const resolver = hostPaths(signal);
  const { links, launcherLinks } = await readLauncherLinks(path.join(paths.root, 'bin', 'launcher-links'), signal);
  const lexical = [paths.launcher, ...links];
  const literals: string[] = [];
  for (const link of lexical) literals.push(link, await canonicalParentForm(link, resolver));
  return {
    root: paths.root,
    keychains: paths.keychains,
    executables: paths.executables,
    subtrees: [paths.root, paths.keychains, paths.executables],
    readDenied: secretLocationsIn(paths.home, paths).map((location) => location.directory),
    literals: [...new Set(literals)],
    launcherLinks,
  };
}
