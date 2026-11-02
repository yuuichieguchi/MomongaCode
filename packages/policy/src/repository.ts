import path from 'node:path';
import { commondirTarget, gitFileTarget } from '@momonga/foundation';
import type { PolicyFilesystem } from './filesystem.ts';

export type RepositoryPorts = Pick<PolicyFilesystem, 'canonicalise' | 'readEntry' | 'readNoFollow'>;

export type RepositoryHit = { directory: string; entry: 'dotgit' | 'bare'; gitDirectories: string[] };

export type Discovery = { found: false } | { found: true; hit: RepositoryHit } | { unresolved: true };

const NOT_FOUND: Discovery = { found: false };
const UNRESOLVED: Discovery = { unresolved: true };

const SYMBOLIC_HEAD = /^ref:\s*refs\//;
const OBJECT_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:\s|$)/;

type Validity = 'valid' | 'invalid' | 'unresolved';

const headValidity = (head: string, ports: RepositoryPorts): Validity => {
  const step = ports.readNoFollow(head);
  if ('unresolvable' in step) return 'unresolved';
  if (step.kind === 'symlink') return step.target.startsWith('refs/') ? 'valid' : 'invalid';
  if (step.kind !== 'other') return 'invalid';
  const entry = ports.readEntry(head);
  if ('unresolvable' in entry) return 'unresolved';
  if (entry.kind !== 'file') return 'invalid';
  return SYMBOLIC_HEAD.test(entry.text) || OBJECT_HEAD.test(entry.text) ? 'valid' : 'invalid';
};

type Common = { directory: string } | 'unresolved' | 'broken';

const commonDirectoryOf = (gitDirectory: string, ports: RepositoryPorts): Common => {
  const common = ports.readEntry(path.join(gitDirectory, 'commondir'));
  if ('unresolvable' in common || common.kind === 'oversize') return 'unresolved';
  if (common.kind !== 'file') return { directory: gitDirectory };
  const target = commondirTarget(common.text);
  if (target === undefined) return 'broken';
  const resolved = canonicalOf(path.resolve(gitDirectory, target), ports);
  return resolved === undefined ? 'unresolved' : { directory: resolved };
};

const directoryValidity = (directory: string, ports: RepositoryPorts): Validity => {
  const head = headValidity(path.join(directory, 'HEAD'), ports);
  if (head !== 'valid') return head;
  const common = commonDirectoryOf(directory, ports);
  if (common === 'unresolved') return 'unresolved';
  if (common === 'broken') return 'invalid';
  for (const name of ['objects', 'refs']) {
    const entry = ports.readEntry(path.join(common.directory, name));
    if ('unresolvable' in entry) return 'unresolved';
    if (entry.kind !== 'directory') return 'invalid';
  }
  return 'valid';
};

const canonicalOf = (absolute: string, ports: RepositoryPorts): string | undefined => {
  const resolution = ports.canonicalise(absolute);
  return resolution.ok ? resolution.path : undefined;
};

const gitDirectoriesOf = (gitDirectory: string, ports: RepositoryPorts): string[] | undefined => {
  const common = commonDirectoryOf(gitDirectory, ports);
  if (common === 'unresolved' || common === 'broken') return undefined;
  return common.directory === gitDirectory ? [gitDirectory] : [gitDirectory, common.directory];
};

const dotGitFileTarget = (directory: string, text: string, ports: RepositoryPorts): string | undefined => {
  const named = gitFileTarget(text);
  return named === undefined ? undefined : canonicalOf(path.resolve(directory, named), ports);
};

const hitAt = (directory: string, entry: RepositoryHit['entry'], gitDirectory: string | undefined, ports: RepositoryPorts): Discovery => {
  if (gitDirectory === undefined) return UNRESOLVED;
  const gitDirectories = gitDirectoriesOf(gitDirectory, ports);
  return gitDirectories === undefined ? UNRESOLVED : { found: true, hit: { directory, entry, gitDirectories } };
};

export type DiscoveryOptions = { bare: boolean };

const discoverBare = (directory: string, ports: RepositoryPorts): Discovery => {
  const own = directoryValidity(directory, ports);
  if (own === 'unresolved') return UNRESOLVED;
  return own === 'valid' ? hitAt(directory, 'bare', directory, ports) : NOT_FOUND;
};

export const discoverRepository = (cwd: string, ports: RepositoryPorts, options: DiscoveryOptions = { bare: false }): Discovery => {
  const start = ports.canonicalise(cwd);
  if (!start.ok) return UNRESOLVED;
  if (options.bare) return discoverBare(start.path, ports);
  for (let directory = start.path; ; directory = path.dirname(directory)) {
    const dotGit = ports.readEntry(path.join(directory, '.git'));
    if ('unresolvable' in dotGit || dotGit.kind === 'oversize') return UNRESOLVED;
    if (dotGit.kind === 'file') return hitAt(directory, 'dotgit', dotGitFileTarget(directory, dotGit.text, ports), ports);
    if (dotGit.kind === 'directory') {
      const validity = directoryValidity(dotGit.canonical, ports);
      if (validity === 'unresolved') return UNRESOLVED;
      if (validity === 'valid') return hitAt(directory, 'dotgit', dotGit.canonical, ports);
    }
    const own = directoryValidity(directory, ports);
    if (own === 'unresolved') return UNRESOLVED;
    if (own === 'valid') return hitAt(directory, 'bare', directory, ports);
    if (path.dirname(directory) === directory) return NOT_FOUND;
  }
};
