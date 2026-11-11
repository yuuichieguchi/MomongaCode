import path from 'node:path';
import { commondirTarget, everyAsync, gitFileTarget } from '@momonga/foundation';
import type { HeadRead, PolicyFilesystem } from './filesystem.ts';

export type RepositoryPorts = Pick<PolicyFilesystem, 'canonicalise' | 'readEntry' | 'readHead' | 'isSearchable'>;

export type RepositoryHit = { directory: string; entry: 'dotgit' | 'bare'; gitDirectories: string[] };

export type Discovery = { found: false } | { found: true; hit: RepositoryHit } | { unresolved: true };

const NOT_FOUND: Discovery = { found: false };
const UNRESOLVED: Discovery = { unresolved: true };

const SYMBOLIC_HEAD = /^ref:[ \t\n\r]*refs\//;
const OBJECT_NAME_PREFIX = /^[0-9A-Fa-f]{40}/;

type Validity = 'valid' | 'invalid' | 'unresolved';

const headIsValid = (head: HeadRead): boolean => {
  if (head.kind === 'invalid') return false;
  if (head.kind === 'symlink') return head.target.startsWith('refs/');
  const [text] = head.text.split('\0');
  return SYMBOLIC_HEAD.test(text as string) || OBJECT_NAME_PREFIX.test(text as string);
};

type Common = { directory: string } | 'unresolved' | 'broken';

const commonDirectoryOf = async (gitDirectory: string, ports: RepositoryPorts): Promise<Common> => {
  const common = await ports.readEntry(path.join(gitDirectory, 'commondir'));
  if ('unresolvable' in common || common.kind === 'oversize') return 'unresolved';
  if (common.kind !== 'file') return { directory: gitDirectory };
  const target = commondirTarget(common.text);
  if (target === undefined) return 'broken';
  const resolved = await canonicalOf(path.resolve(gitDirectory, target), ports);
  return resolved === undefined ? 'unresolved' : { directory: resolved };
};

const directoryValidity = async (directory: string, ports: RepositoryPorts): Promise<Validity> => {
  if (!headIsValid(await ports.readHead(path.join(directory, 'HEAD')))) return 'invalid';
  const common = await commonDirectoryOf(directory, ports);
  if (common === 'unresolved') return 'unresolved';
  if (common === 'broken') return 'invalid';
  return (await everyAsync(['objects', 'refs'], (name) => ports.isSearchable(path.join(common.directory, name)))) ? 'valid' : 'invalid';
};

const canonicalOf = async (absolute: string, ports: RepositoryPorts): Promise<string | undefined> => {
  const resolution = await ports.canonicalise(absolute);
  return resolution.ok ? resolution.path : undefined;
};

const gitDirectoriesOf = async (gitDirectory: string, ports: RepositoryPorts): Promise<string[] | undefined> => {
  const common = await commonDirectoryOf(gitDirectory, ports);
  if (common === 'unresolved' || common === 'broken') return undefined;
  return common.directory === gitDirectory ? [gitDirectory] : [gitDirectory, common.directory];
};

const hitAtGitfile = async (directory: string, text: string, ports: RepositoryPorts): Promise<Discovery> => {
  const named = gitFileTarget(text);
  if (named === undefined) return NOT_FOUND;
  const target = await canonicalOf(path.resolve(directory, named), ports);
  if (target === undefined) return UNRESOLVED;
  const validity = await directoryValidity(target, ports);
  if (validity === 'unresolved') return UNRESOLVED;
  return validity === 'valid' ? await hitAt(directory, 'dotgit', target, ports) : NOT_FOUND;
};

const hitAt = async (directory: string, entry: RepositoryHit['entry'], gitDirectory: string | undefined, ports: RepositoryPorts): Promise<Discovery> => {
  if (gitDirectory === undefined) return UNRESOLVED;
  const gitDirectories = await gitDirectoriesOf(gitDirectory, ports);
  return gitDirectories === undefined ? UNRESOLVED : { found: true, hit: { directory, entry, gitDirectories } };
};

export type DiscoveryOptions = { bare: boolean };

const discoverBare = async (directory: string, ports: RepositoryPorts): Promise<Discovery> => {
  const own = await directoryValidity(directory, ports);
  if (own === 'unresolved') return UNRESOLVED;
  return own === 'valid' ? await hitAt(directory, 'bare', directory, ports) : NOT_FOUND;
};

export const discoverRepository = async (cwd: string, ports: RepositoryPorts, options: DiscoveryOptions = { bare: false }): Promise<Discovery> => {
  const start = await ports.canonicalise(cwd);
  if (!start.ok) return UNRESOLVED;
  if (options.bare) return await discoverBare(start.path, ports);
  for (let directory = start.path; ; directory = path.dirname(directory)) {
    const dotGit = await ports.readEntry(path.join(directory, '.git'));
    if ('unresolvable' in dotGit || dotGit.kind === 'oversize') return UNRESOLVED;
    if (dotGit.kind === 'file') return await hitAtGitfile(directory, dotGit.text, ports);
    if (dotGit.kind === 'directory') {
      const validity = await directoryValidity(dotGit.canonical, ports);
      if (validity === 'unresolved') return UNRESOLVED;
      if (validity === 'valid') return await hitAt(directory, 'dotgit', dotGit.canonical, ports);
    }
    const own = await directoryValidity(directory, ports);
    if (own === 'unresolved') return UNRESOLVED;
    if (own === 'valid') return await hitAt(directory, 'bare', directory, ports);
    if (path.dirname(directory) === directory) return NOT_FOUND;
  }
};
