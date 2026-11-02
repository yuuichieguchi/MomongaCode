import type { GitEntryReader, GitlinkRead, PathResolution, StepReader, Unresolved } from '@momonga/foundation';

export type ProgramResolution = { program: string } | { none: true };

export type GlobExpansion = { matches: string[] } | { overflow: true } | Unresolved;

export type HeadRead = { kind: 'symlink'; target: string } | { kind: 'text'; text: string } | { kind: 'invalid' };

export type PolicyFilesystem = {
  platform: NodeJS.Platform;
  canonicalise: (absolute: string) => PathResolution;
  volumeProbe: (directory: string) => boolean;
  resolveProgram: (name: string, cwd: string, searchPath: string | undefined, isWritable: (absolute: string) => boolean) => ProgramResolution;
  expandGlob: (pattern: string, cwd: string, limit: number) => GlobExpansion;
  readEntry: GitEntryReader;
  readNoFollow: StepReader;
  readHead: (absolute: string) => HeadRead;
  isSearchable: (absolute: string) => boolean;
  gitlinks: (gitDirectory: string) => GitlinkRead | Unresolved;
};
