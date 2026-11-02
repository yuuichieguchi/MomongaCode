import type { GlobDeadline, GlobExpander } from './filesystem.ts';
import { EMPTY_GLOB_TABLE, expandGlobTable } from './glob-expansion.ts';
import type { GlobTable } from './glob-expansion.ts';
import { commandSpecsFor } from './platform-specs.ts';
import { analyzeCommand } from './shell.ts';
import type { Analysis, Segment, Word } from './shell.ts';
import type { Target } from './targets.ts';
import type { PermissionSubject } from './types.ts';

const globsOfWords = (words: readonly Word[]): string[] => words.flatMap((word) => (word.glob === null ? [] : [word.glob]));

const globsOfTargets = (targets: readonly Target[]): string[] => targets.flatMap((target) => ('glob' in target ? [target.glob] : []));

const globsOfSegment = (segment: Segment): string[] => [
  ...globsOfWords(segment.words),
  ...globsOfWords(segment.wrapperPayloads),
  ...globsOfTargets(segment.effects.reads),
  ...globsOfTargets(segment.effects.writes),
  ...globsOfTargets(segment.effects.darwinWrites ?? []),
  ...globsOfTargets(segment.wrapperWrites),
];

const globsOfAnalysis = (analysis: Analysis): string[] => [
  ...analysis.segments.flatMap(globsOfSegment),
  ...globsOfTargets(analysis.redirects),
  ...globsOfTargets(analysis.reads),
  ...analysis.nested.flatMap(globsOfAnalysis),
];

export type GlobPreparation = {
  expand: GlobExpander;
  platform: NodeJS.Platform;
  subject: PermissionSubject;
  cwd: string;
  home: string;
  deadline: GlobDeadline;
  signal: AbortSignal;
};

export const prepareGlobs = async ({ expand, platform, subject, cwd, home, deadline, signal }: GlobPreparation): Promise<GlobTable> => {
  if (subject.kind !== 'command') return EMPTY_GLOB_TABLE;
  const analysis = analyzeCommand(subject.command, commandSpecsFor(platform));
  if (analysis === null) return EMPTY_GLOB_TABLE;
  return expandGlobTable(expand, { cwd, home }, globsOfAnalysis(analysis), deadline, signal);
};
