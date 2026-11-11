import path from 'node:path';
import { walkPath } from '@momonga/foundation';
import type { PolicyFilesystem, ProgramResolution, WritableCheck } from './filesystem.ts';
import type { Segment } from './shell.ts';
import type { WrapperUse } from './wrappers.ts';

export const DEFAULT_COMMAND_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export type ResolutionContext = {
  fs: Pick<PolicyFilesystem, 'resolveProgram' | 'readNoFollow'>;
  cwd: string;
  searchPath: string | undefined;
  isWritable: WritableCheck;
};

const PATH_ASSIGNMENT = /^PATH\+?=/;

const unresolved: ProgramResolution = { none: true };

const walkedProgram = async (absolute: string, context: ResolutionContext): Promise<ProgramResolution> => {
  const entries: string[] = [];
  const result = await walkPath(
    absolute,
    async (candidate) => {
      entries.push(candidate);
      const read = await context.fs.readNoFollow(candidate);
      return 'unresolvable' in read ? { stepFailure: read } : read;
    },
    () => undefined,
  );
  if (!result.ok) return unresolved;
  for (const entry of entries) {
    if ((await context.isWritable(entry)) || (await context.isWritable(path.dirname(entry)))) return unresolved;
  }
  return { program: path.join(result.prefix, ...result.tail) };
};

const resolveSlashWord = async (word: string, context: ResolutionContext): Promise<ProgramResolution> => (path.isAbsolute(word) ? walkedProgram(word, context) : unresolved);

const resolveBareWord = async (word: string, searchPath: string | undefined, context: ResolutionContext, outsideWritable: boolean): Promise<ProgramResolution> => {
  const found = await context.fs.resolveProgram(word, context.cwd, searchPath, context.isWritable);
  return outsideWritable && 'program' in found ? walkedProgram(found.program, context) : found;
};

const resolveWord = (word: string, searchPath: string | undefined, context: ResolutionContext, outsideWritable: boolean): Promise<ProgramResolution> =>
  word.includes('/') ? resolveSlashWord(word, context) : resolveBareWord(word, searchPath, context, outsideWritable);

const usesDefaultPath = (wrapper: WrapperUse): boolean =>
  wrapper.options.some((option) => wrapper.spec.wrapper?.defaultPathOptions?.includes(option.option) === true);

const runsProgram = (wrapper: WrapperUse): boolean => wrapper.spec.wrapper?.program === true;

export const executedByWrapper = (segment: Segment): boolean => segment.wrappers.some(runsProgram);

export const resolveSegmentProgram = async (segment: Segment, context: ResolutionContext): Promise<ProgramResolution> => {
  const word = segment.words[segment.effectiveIndex];
  if (word === undefined || !word.literal) return unresolved;
  if (segment.words.slice(0, segment.effectiveIndex).some((entry) => PATH_ASSIGNMENT.test(entry.value))) return unresolved;
  let lookupPath = context.searchPath;
  let executed = false;
  for (const wrapper of segment.wrappers) {
    const keeps = wrapper.spec.wrapper?.keepsSearchPath;
    if (keeps !== undefined) {
      if (wrapper.options.some((option) => keeps.exceptWith.includes(option.option))) return unresolved;
    } else if (!wrapper.stripped) return unresolved;
    if ((executed || runsProgram(wrapper) || wrapper.word.value.includes('/')) && !('program' in (await resolveWord(wrapper.word.value, lookupPath, context, true)))) return unresolved;
    executed = executed || runsProgram(wrapper);
    lookupPath = usesDefaultPath(wrapper) ? DEFAULT_COMMAND_PATH : context.searchPath;
  }
  return resolveWord(word.value, lookupPath, context, false);
};
