import { settledOrAborted } from '@momonga/foundation';
import type { Awaitable, ConfigPrograms, EntryRead, GitlinkRead, LocatedParts, PathResolution, StepRead, Unresolved } from '@momonga/foundation';

export type { ProgramResolution } from '@momonga/foundation';
import type { ProgramResolution, WritableCheck } from '@momonga/foundation';

export type GlobExpansion = { matches: string[] } | { overflow: true } | Unresolved;

export type HeadRead = { kind: 'symlink'; target: string } | { kind: 'text'; text: string } | { kind: 'invalid' };

export type GlobDeadline = { remainingMs: () => number };

export type GlobExpander = (pattern: string, cwd: string, limit: number, deadline: GlobDeadline, signal: AbortSignal) => Promise<GlobExpansion>;

export type { WritableCheck } from '@momonga/foundation';

type Ports<Asker extends unknown[]> = {
  platform: NodeJS.Platform;
  canonicalise: (absolute: string, ...asker: Asker) => Awaitable<PathResolution>;
  volumeProbe: (directory: string, ...asker: Asker) => Awaitable<boolean>;
  locate: (absolute: string, ...asker: Asker) => Awaitable<LocatedParts>;
  resolveProgram: (name: string, cwd: string, searchPath: string | undefined, isWritable: WritableCheck, ...asker: Asker) => Awaitable<ProgramResolution>;
  readEntry: (absolute: string, ...asker: Asker) => Awaitable<EntryRead>;
  readNoFollow: (absolute: string, ...asker: Asker) => Awaitable<StepRead>;
  readHead: (absolute: string, ...asker: Asker) => Awaitable<HeadRead>;
  isSearchable: (absolute: string, ...asker: Asker) => Awaitable<boolean>;
  gitlinks: (gitDirectory: string, ...asker: Asker) => Awaitable<GitlinkRead | Unresolved>;
  configPrograms: (gitDirectory: string, ...asker: Asker) => Awaitable<ConfigPrograms | Unresolved>;
};

export type PolicyPorts = Ports<[]>;

export type PolicyHostPorts = Ports<[signal: AbortSignal]>;

export type PolicyFilesystem = PolicyPorts & { expandGlob: (pattern: string, cwd: string, limit: number) => GlobExpansion };

export type PolicyHostFilesystem = PolicyHostPorts & { expandGlob: GlobExpander };

export const askedBy = (host: PolicyHostPorts, signal: AbortSignal): PolicyPorts => {
  const asked = <T>(answer: () => Awaitable<T>): Promise<T> => settledOrAborted((async () => answer())(), signal);
  return {
    platform: host.platform,
    canonicalise: (absolute) => asked(() => host.canonicalise(absolute, signal)),
    volumeProbe: (directory) => asked(() => host.volumeProbe(directory, signal)),
    locate: (absolute) => asked(() => host.locate(absolute, signal)),
    resolveProgram: (name, cwd, searchPath, isWritable) => asked(() => host.resolveProgram(name, cwd, searchPath, isWritable, signal)),
    readEntry: (absolute) => asked(() => host.readEntry(absolute, signal)),
    readNoFollow: (absolute) => asked(() => host.readNoFollow(absolute, signal)),
    readHead: (absolute) => asked(() => host.readHead(absolute, signal)),
    isSearchable: (absolute) => asked(() => host.isSearchable(absolute, signal)),
    gitlinks: (gitDirectory) => asked(() => host.gitlinks(gitDirectory, signal)),
    configPrograms: (gitDirectory) => asked(() => host.configPrograms(gitDirectory, signal)),
  };
};

type Resolving = Pick<PolicyPorts, 'canonicalise' | 'volumeProbe' | 'locate'>;

const oncePerPath = <T>(read: (absolute: string) => Awaitable<T>): ((absolute: string) => Promise<T>) => {
  const answers = new Map<string, Promise<T>>();
  return (absolute) => {
    const known = answers.get(absolute);
    if (known !== undefined) return known;
    const answer = (async () => read(absolute))();
    answers.set(absolute, answer);
    return answer;
  };
};

export const createDecisionResolver = <T extends Resolving>(base: T): T => ({
  ...base,
  canonicalise: oncePerPath(base.canonicalise),
  volumeProbe: oncePerPath(base.volumeProbe),
  locate: oncePerPath(base.locate),
});
