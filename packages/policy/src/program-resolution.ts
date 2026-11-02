import path from 'node:path';
import { walkPath } from '@momonga/foundation';
import type { PolicyFilesystem, ProgramResolution } from './filesystem.ts';
import type { Segment } from './shell.ts';
import type { WrapperUse } from './wrappers.ts';

export const DEFAULT_COMMAND_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export type ResolutionContext = {
  fs: Pick<PolicyFilesystem, 'resolveProgram' | 'readNoFollow'>;
  cwd: string;
  searchPath: string | undefined;
  isWritable: (absolute: string) => boolean;
};

const PATH_ASSIGNMENT = /^PATH\+?=/;
const ENV_PATH_DISQUALIFIERS: readonly string[] = ['-P', '-i', '--ignore-environment'];

const unresolved: ProgramResolution = { none: true };

const walkedProgram = (absolute: string, context: ResolutionContext): ProgramResolution => {
  const entries: string[] = [];
  const result = walkPath(
    absolute,
    (candidate) => {
      entries.push(candidate);
      const read = context.fs.readNoFollow(candidate);
      return 'unresolvable' in read ? { stepFailure: read } : read;
    },
    () => undefined,
  );
  if (!result.ok) return unresolved;
  if (entries.some((entry) => context.isWritable(entry) || context.isWritable(path.dirname(entry)))) return unresolved;
  return { program: path.join(result.prefix, ...result.tail) };
};

const resolveSlashWord = (word: string, context: ResolutionContext): ProgramResolution => (path.isAbsolute(word) ? walkedProgram(word, context) : unresolved);

const resolveBareWord = (word: string, searchPath: string | undefined, context: ResolutionContext, outsideWritable: boolean): ProgramResolution => {
  const found = context.fs.resolveProgram(word, context.cwd, searchPath, context.isWritable);
  return outsideWritable && 'program' in found ? walkedProgram(found.program, context) : found;
};

const resolveWord = (word: string, searchPath: string | undefined, context: ResolutionContext, outsideWritable: boolean): ProgramResolution =>
  word.includes('/') ? resolveSlashWord(word, context) : resolveBareWord(word, searchPath, context, outsideWritable);

const isCommandP = (wrapper: WrapperUse): boolean => wrapper.name === 'command' && wrapper.options.some((option) => option.option === '-p');

const runsProgram = (wrapper: WrapperUse): boolean => wrapper.spec.wrapper?.program === true;

export const executedByWrapper = (segment: Segment): boolean => segment.wrappers.some(runsProgram);

export const resolveSegmentProgram = (segment: Segment, context: ResolutionContext): ProgramResolution => {
  const word = segment.words[segment.effectiveIndex];
  if (word === undefined || !word.literal) return unresolved;
  if (segment.words.slice(0, segment.effectiveIndex).some((entry) => PATH_ASSIGNMENT.test(entry.value))) return unresolved;
  let lookupPath = context.searchPath;
  let executed = false;
  for (const wrapper of segment.wrappers) {
    if (wrapper.name === 'env') {
      if (wrapper.options.some((option) => ENV_PATH_DISQUALIFIERS.includes(option.option))) return unresolved;
    } else if (!wrapper.stripped) return unresolved;
    if ((executed || runsProgram(wrapper) || wrapper.word.value.includes('/')) && !('program' in resolveWord(wrapper.word.value, lookupPath, context, true))) return unresolved;
    executed = executed || runsProgram(wrapper);
    lookupPath = isCommandP(wrapper) ? DEFAULT_COMMAND_PATH : context.searchPath;
  }
  return resolveWord(word.value, lookupPath, context, false);
};
