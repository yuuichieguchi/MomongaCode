import path from 'node:path';
import { lexicallyWithin, mapAsync } from '@momonga/foundation';
import type { UnresolvableReason } from '@momonga/foundation';
import type { PolicyFilesystem } from './filesystem.ts';
import { expandGlobWord } from './glob-expansion.ts';
import { globDirectory } from './path-effects.ts';
import { absoluteFrom } from './path-match.ts';
import { resolveSegmentProgram } from './program-resolution.ts';
import type { ResolutionContext } from './program-resolution.ts';
import { discoverRepository } from './repository.ts';
import { programNameOf } from './shell.ts';
import type { Analysis, ExecutionStep, Segment } from './shell.ts';
import type { Target } from './targets.ts';

export type PlanContext = ResolutionContext & { fs: PolicyFilesystem; home: string; roots: readonly string[] };

export type PathPlan = {
  paths: string[];
  removes: string[];
  candidates: string[];
  unresolvable: UnresolvableReason[];
  needsApproval: boolean;
};

export type Located = PathPlan & { globDirectories: string[] };

export type Changed = { paths: string[]; unknown: boolean };

export type StepPlan = { step: ExecutionStep; writes: Located; changed: Changed; createsNames: boolean };

export type ChangeScope = 'every-write' | 'name-creating';

const DISCARD_TARGETS: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
const EVERYTHING = '/';

export type SedPrograms = ReadonlyMap<Segment, string>;

const segmentsInStepOrder = (analysis: Analysis): Segment[] =>
  analysis.segments.flatMap((segment, position) => [...analysis.nested.filter((inner) => inner.at === position).flatMap(segmentsInStepOrder), segment]);

export const resolveSedPrograms = async (context: PlanContext, analysis: Analysis): Promise<SedPrograms> => {
  const programs = new Map<Segment, string>();
  for (const segment of segmentsInStepOrder(analysis)) {
    if (segment.effects.darwinWrites === undefined || programNameOf(segment) !== 'sed') continue;
    const resolution = await resolveSegmentProgram(segment, context);
    if ('program' in resolution) programs.set(segment, resolution.program);
  }
  return programs;
};

export const sedResolution =
  (programs: SedPrograms) =>
  (segment: Segment): string | undefined =>
    programs.get(segment);

const worktreeOf = async (context: PlanContext): Promise<string> => {
  const discovery = await discoverRepository(context.cwd, context.fs);
  if ('found' in discovery && discovery.found && discovery.hit.entry === 'dotgit') return discovery.hit.directory;
  const cwd = await context.fs.canonicalise(context.cwd);
  const canonicalCwd = cwd.ok ? cwd.path : context.cwd;
  for (const root of context.roots) {
    const resolution = await context.fs.canonicalise(absoluteFrom(root, context.cwd));
    if (resolution.ok && lexicallyWithin(canonicalCwd, resolution.path)) return resolution.path;
  }
  return canonicalCwd;
};

export const locateTargets = async (context: PlanContext, targets: readonly Target[]): Promise<Located> => {
  const located: Located = { paths: [], removes: [], candidates: [], unresolvable: [], needsApproval: false, globDirectories: [] };
  const absolute = (text: string): string => (text === '~' || text.startsWith('~/') ? path.join(context.home, text.slice(1)) : absoluteFrom(text, context.cwd));
  const resolve = (text: string): string | undefined => (DISCARD_TARGETS.has(text) ? undefined : absolute(text));
  let worktree: string | undefined;
  for (const target of targets) {
    if ('unresolvable' in target) {
      located.unresolvable.push(target.unresolvable);
    } else if ('worktree' in target) {
      worktree ??= await worktreeOf(context);
      const resolved = target.below === undefined ? worktree : path.join(worktree, target.below);
      located.paths.push(resolved);
      located.removes.push(resolved);
    } else if ('glob' in target) {
      const directory = globDirectory(target.glob);
      if (!directory.startsWith('~') || directory === '~' || directory.startsWith('~/')) located.globDirectories.push(absolute(directory));
      for (const word of expandGlobWord(context, target.glob)) {
        if (word.kind === 'unresolvable') located.unresolvable.push(word.reason);
        else located.paths.push(word.absolute);
      }
    } else if ('candidate' in target) {
      const resolved = resolve(target.candidate);
      if (resolved === undefined) continue;
      located.candidates.push(resolved);
      if (target.removes === true) located.removes.push(resolved);
    } else {
      const resolved = resolve(target.literal);
      if (resolved === undefined) continue;
      located.paths.push(resolved);
      if (target.removes === true) located.removes.push(resolved);
      if (target.needsApproval === true) located.needsApproval = true;
    }
  }
  return located;
};

export const locateWrites = (context: PlanContext, steps: readonly ExecutionStep[]): Promise<StepPlan[]> =>
  mapAsync(steps, async (step) => {
    const writes = await locateTargets(context, step.writes);
    const changed = { paths: [...writes.paths, ...writes.candidates], unknown: writes.unresolvable.length > 0 || writes.needsApproval };
    return { step, writes, changed, createsNames: step.segment?.effects.spec?.createsNames === true && step.writes.length > 0 };
  });

export const changedBefore = (plans: readonly StepPlan[], index: number, scope: ChangeScope): Changed => {
  const own = plans[index] as StepPlan;
  const earlier = plans.slice(0, index);
  const concurrent = own.step.concurrentWith.filter((other) => other > index).map((other) => plans[other] as StepPlan);
  const sources = [...earlier, ...concurrent].filter((plan) => scope === 'every-write' || plan.createsNames);
  return { paths: sources.flatMap((plan) => plan.changed.paths), unknown: sources.some((plan) => plan.changed.unknown) };
};

export const changedPathList = (changed: Changed): string[] => (changed.unknown ? [...changed.paths, EVERYTHING] : changed.paths);

const EARLIER_SEGMENT: UnresolvableReason = { kind: 'earlier-segment' };

export const judgedAfter = (located: Located, changed: readonly string[]): PathPlan => {
  const probes = [...located.paths, ...located.candidates];
  const shadowed =
    probes.some((probe) => changed.some((entry) => lexicallyWithin(probe, entry))) ||
    located.globDirectories.some((directory) => changed.some((entry) => lexicallyWithin(directory, entry) || lexicallyWithin(entry, directory)));
  return shadowed ? { ...located, unresolvable: [...located.unresolvable, EARLIER_SEGMENT] } : located;
};
