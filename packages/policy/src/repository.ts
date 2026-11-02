import path from 'node:path';
import type { PolicyFilesystem } from './filesystem.ts';

export type RepositoryPorts = Pick<PolicyFilesystem, 'canonicalise' | 'readEntry' | 'readNoFollow'>;

export type RepositoryHit = { directory: string; entry: 'dotgit' | 'bare'; gitDirectories: string[] };

export type Discovery = { found: false } | { found: true; hit: RepositoryHit } | { unresolved: true };

const NOT_FOUND: Discovery = { found: false };
const UNRESOLVED: Discovery = { unresolved: true };

const SYMBOLIC_HEAD = /^ref:\s*refs\//;
const OBJECT_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:\s|$)/;
const GITDIR_FILE = /^gitdir:\s*(.+?)\s*$/m;

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

const directoryValidity = (directory: string, ports: RepositoryPorts): Validity => {
  for (const name of ['objects', 'refs']) {
    const entry = ports.readEntry(path.join(directory, name));
    if ('unresolvable' in entry) return 'unresolved';
    if (entry.kind !== 'directory') return 'invalid';
  }
  return headValidity(path.join(directory, 'HEAD'), ports);
};

const canonicalOf = (absolute: string, ports: RepositoryPorts): string | undefined => {
  const resolution = ports.canonicalise(absolute);
  return resolution.ok ? resolution.path : undefined;
};

const gitDirectoriesOf = (gitDirectory: string, ports: RepositoryPorts): string[] | undefined => {
  const common = ports.readEntry(path.join(gitDirectory, 'commondir'));
  if ('unresolvable' in common || common.kind === 'oversize') return undefined;
  if (common.kind !== 'file') return [gitDirectory];
  const commonDirectory = canonicalOf(path.resolve(gitDirectory, common.text.trim()), ports);
  return commonDirectory === undefined ? undefined : [gitDirectory, commonDirectory];
};

const dotGitFileTarget = (directory: string, text: string, ports: RepositoryPorts): string | undefined => {
  const named = GITDIR_FILE.exec(text)?.[1];
  return named === undefined ? undefined : canonicalOf(path.resolve(directory, named), ports);
};

const hitAt = (directory: string, entry: RepositoryHit['entry'], gitDirectory: string | undefined, ports: RepositoryPorts): Discovery => {
  if (gitDirectory === undefined) return UNRESOLVED;
  const gitDirectories = gitDirectoriesOf(gitDirectory, ports);
  return gitDirectories === undefined ? UNRESOLVED : { found: true, hit: { directory, entry, gitDirectories } };
};

export const discoverRepository = (cwd: string, ports: RepositoryPorts): Discovery => {
  const start = ports.canonicalise(cwd);
  if (!start.ok) return UNRESOLVED;
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
