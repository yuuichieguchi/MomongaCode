import path from 'node:path';
import { lexicallyWithin } from '@momonga/foundation';
import type { ProtectedSet } from '@momonga/foundation';
import { hasOption, isOptionWord, parseArgv } from './argv.ts';
import type { ParsedArgv, ParsedOption } from './argv.ts';
import type { GitParse } from './git-argv.ts';
import { GIT_LISTING_SELECTORS, GIT_LISTING_SPECS, GIT_READ_ONLY_SUBCOMMANDS, gitSubcommandSpec, reflogView } from './git-subcommands.ts';
import type { PolicyFilesystem } from './filesystem.ts';
import { MAX_GLOB_MATCHES, expandGlobWord } from './glob-expansion.ts';
import { firstUnescaped, unescapeGlob } from './glob-pattern.ts';
import type { OptionEffect, CommandSpec } from './command-specs.ts';
import { globDirectory, sedFacts } from './path-effects.ts';
import { absoluteFrom } from './path-match.ts';
import { systemProgramDirectories } from './platform-specs.ts';
import { executedByWrapper, resolveSegmentProgram } from './program-resolution.ts';
import { discoverRepository } from './repository.ts';
import { insideRoots } from './roots.ts';
import { scanSedScript } from './sed-script.ts';
import type { Analysis, DirectoryStep, Segment, Word } from './shell.ts';
import type { Target } from './targets.ts';
import type { WrapperUse } from './wrappers.ts';

export const MAX_APPROVABLE_COMMAND_CHARS = 10_000;
export { MAX_GLOB_MATCHES };

export type ApprovalContext = {
  fs: PolicyFilesystem;
  cwd: string;
  home: string;
  roots: readonly string[];
  searchPath: string | undefined;
  isWritable: (absolute: string) => boolean;
  protectedSet: ProtectedSet;
};

export type ApprovalClass = 'read-only' | 'edit';

const DISQUALIFYING_EFFECTS: ReadonlySet<OptionEffect> = new Set(['write', 'exec', 'opens-path', 'sensitive', 'cwd', 'root', 'delete', 'symlink-create', 'follows-symlinks']);
const CAPABLE_EFFECTS: ReadonlySet<OptionEffect> = new Set(['write', 'exec', 'delete', 'opens-path', 'sensitive']);


const globAllowed = (pattern: string, context: ApprovalContext): boolean => {
  if (firstUnescaped(pattern, '{}') !== -1 || pattern.startsWith('~') || unescapeGlob(pattern).split('/').includes('..')) return false;
  const directory = globDirectory(pattern);
  const canonicalise = context.fs.canonicalise;
  if (!insideRoots([absoluteFrom(directory, context.cwd)], context.roots, context.cwd, canonicalise)) return false;
  return expandGlobWord(context, pattern).every(
    (entry) =>
      entry.kind !== 'unresolvable' &&
      !(entry.kind === 'match' && path.basename(entry.text).startsWith('-')) &&
      insideRoots([entry.absolute], context.roots, context.cwd, canonicalise),
  );
};

const operandsAllowed = (spec: CommandSpec, operands: readonly Word[], context: ApprovalContext): boolean => {
  const capable = spec.options.some((option) => CAPABLE_EFFECTS.has(option.effect));
  return operands.every((word) => {
    if (word.staticValue !== null) return true;
    if (capable || spec.approval === 'edit') return false;
    if (word.glob !== null) return globAllowed(word.glob, context);
    return spec.operands === 'none';
  });
};

const conditionHolds = (decl: { applies?: { any?: readonly string[]; none?: readonly string[] } }, present: ReadonlySet<string>): boolean => {
  const { any, none } = decl.applies ?? {};
  return (any === undefined || any.some((name) => present.has(name))) && (none === undefined || !none.some((name) => present.has(name)));
};

const presentOptions = (options: readonly ParsedOption[]): ReadonlySet<string> =>
  new Set(options.flatMap((entry) => (entry.value === undefined ? [entry.option] : [entry.option, `${entry.option}=${entry.value}`])));

const optionsAllowed = (spec: CommandSpec, options: readonly ParsedOption[]): boolean => {
  const present = presentOptions(options);
  return options.every(({ option }) => {
    const decl = spec.declOf(option);
    if (decl === undefined) return spec.numericOptions === true && NUMERIC_OPTION.test(option);
    const effect = conditionHolds(decl, present) ? decl.effect : 'flag';
    return !DISQUALIFYING_EFFECTS.has(effect);
  });
};

const NUMERIC_OPTION = /^-\d+$/;

const SENSITIVE_PS_WORD = (sensitive: string): RegExp => new RegExp(`^-[A-Za-z]*[${sensitive}]`);

const psAllowed = (spec: CommandSpec, segment: Segment, operands: readonly Word[]): boolean => {
  const letters = spec.psLetters;
  if (letters === undefined) return true;
  const args = segment.words.slice(segment.effectiveIndex + 1);
  const [first, ...later] = args;
  if (first === undefined) return true;
  if (first.staticValue === null) return false;
  if (first.staticValue.startsWith('-')) return operands.length === 0;
  if (operands.length !== 1 || operands[0] !== first) return false;
  if (!/^[A-Za-z]+$/.test(first.staticValue) || ![...first.staticValue].every((letter) => letters.allowed.includes(letter))) return false;
  const sensitiveWord = SENSITIVE_PS_WORD(letters.sensitive);
  return !later.some((word) => word.literal && sensitiveWord.test(word.value));
};

const sedAllowed = (spec: CommandSpec, parsed: ParsedArgv): boolean => {
  const facts = sedFacts(parsed);
  if (facts.scripts.length === 0 || facts.scriptFiles.length > 0) return false;
  return facts.scripts.every((script) => script !== null && scanSedScript(script, spec.dialect ?? 'bsd').simple);
};

const programApproved = (spec: CommandSpec, segment: Segment, context: ApprovalContext): boolean => {
  if (spec.builtin === true && !(segment.words[segment.effectiveIndex] as Word).value.includes('/') && !executedByWrapper(segment)) return true;
  const resolution = resolveSegmentProgram(segment, context);
  if (!('program' in resolution)) return false;
  return systemProgramDirectories(context.fs.platform).some((directory) => resolution.program === path.join(directory, spec.names[0] as string));
};

const sameDirectory = (left: string, right: string): boolean => lexicallyWithin(left, right) && lexicallyWithin(right, left);

type StepOutcome = { unresolved: true } | { fails: true } | { reaches: string; named: string };

const namedStepPath = (state: string, step: { path: string; physical: boolean }, home: string): string | undefined => {
  if (step.path === '~' || step.path.startsWith('~/')) return `${home}${step.path.slice(1)}`;
  if (step.path.startsWith('~')) return undefined;
  return path.isAbsolute(step.path) ? step.path : `${state}/${step.path}`;
};

const stepOutcome = (context: ApprovalContext, state: string, step: { path: string; physical: boolean }): StepOutcome => {
  const named = namedStepPath(state, step, context.home);
  if (named === undefined) return { unresolved: true };
  if (!step.physical) return { reaches: path.resolve(named), named };
  const resolution = context.fs.canonicalise(named);
  if (resolution.ok) return { reaches: resolution.path, named };
  const { reason } = resolution;
  return reason.kind === 'errno' && (reason.code === 'ENOENT' || reason.code === 'ENOTDIR') ? { fails: true } : { unresolved: true };
};

const reachableDirectories = (context: ApprovalContext, trail: readonly DirectoryStep[], changed: readonly string[]): string[] | undefined => {
  let states = [context.cwd];
  for (const step of trail) {
    if (step === null) return undefined;
    const reached = new Set(states);
    for (const state of states) {
      const outcome = stepOutcome(context, state, step);
      if ('unresolved' in outcome) return undefined;
      if ('fails' in outcome) continue;
      const named = path.resolve(outcome.named);
      if (changed.some((entry) => lexicallyWithin(outcome.reaches, entry) || lexicallyWithin(named, entry))) return undefined;
      const entry = context.fs.readEntry(outcome.reaches);
      if ('unresolvable' in entry) return undefined;
      if (entry.kind !== 'directory' && changed.some((written) => lexicallyWithin(written, outcome.reaches) || lexicallyWithin(written, named))) return undefined;
      if (entry.kind === 'directory') reached.add(outcome.reaches);
    }
    states = [...reached];
  }
  return states;
};

const DISCOVERY_ENTRIES: readonly string[] = ['.git', 'HEAD', 'objects', 'refs', 'commondir'];

const ancestorsOf = (directory: string): string[] => {
  const found = [directory];
  for (let current = path.dirname(directory); current !== found[found.length - 1]; current = path.dirname(current)) found.push(current);
  return found;
};

const discoveryAffected = (context: ApprovalContext, directory: string, changed: readonly string[]): boolean => {
  if (changed.length === 0) return false;
  const canonical = context.fs.canonicalise(directory);
  const chain = [...ancestorsOf(directory), ...(canonical.ok ? ancestorsOf(canonical.path) : [])];
  return changed.some((entry) => chain.some((ancestor) => lexicallyWithin(ancestor, entry) || DISCOVERY_ENTRIES.some((name) => lexicallyWithin(entry, path.join(ancestor, name)))));
};

const gitRepositoryAllowed = (context: ApprovalContext, directory: string, bare: boolean): boolean => {
  const { fs, protectedSet, isWritable } = context;
  const discovery = discoverRepository(directory, fs, { bare });
  if ('unresolved' in discovery) return false;
  if (!discovery.found) return true;
  const { hit } = discovery;
  const roots = context.roots.map((root) => fs.canonicalise(root)).flatMap((resolution) => (resolution.ok ? [resolution.path] : []));
  const ownRoot = hit.entry === 'dotgit' ? roots.find((root) => sameDirectory(root, hit.directory)) : undefined;
  if (ownRoot !== undefined) return !protectedSet.issues.some((issue) => issue.root === ownRoot);
  return !isWritable(hit.directory) && hit.gitDirectories.every((directory) => !isWritable(directory));
};

const gitReadOnlyAllowed = (subcommand: string, rest: readonly Word[]): boolean => {
  const spec = gitSubcommandSpec(subcommand);
  const parsed = parseArgv(rest, spec);
  return parsed.undeclared.length === 0 && optionsAllowed(spec, parsed.options);
};

const listingAllowed = (subcommand: 'branch' | 'tag', rest: readonly Word[]): boolean => {
  const spec = GIT_LISTING_SPECS[subcommand];
  const parsed = parseArgv(rest, spec);
  if (parsed.undeclared.length > 0 || !optionsAllowed(spec, parsed.options)) return false;
  return parsed.operands.length === 0 || hasOption(parsed, ...GIT_LISTING_SELECTORS[subcommand]);
};

const remoteAllowed = (rest: readonly Word[]): boolean => {
  const spec = GIT_LISTING_SPECS.remote;
  const parsed = parseArgv(rest, spec);
  if (parsed.undeclared.length > 0 || !optionsAllowed(spec, parsed.options)) return false;
  const [first, ...names] = parsed.operands;
  if (first === undefined) return parsed.options.every(({ option }) => option === '-v' || option === '--verbose');
  if (first.value === 'show') return names.length > 0 && hasOption(parsed, '-n');
  return first.value === 'get-url' && names.length > 0 && !hasOption(parsed, '-n', '-v', '--verbose');
};

const reflogAllowed = (rest: readonly Word[]): boolean => {
  const view = reflogView(rest);
  if (view.subcommand === undefined) return false;
  if (view.subcommand === 'show') return gitReadOnlyAllowed('reflog', view.words);
  return view.words.every((word) => !isOptionWord(word));
};

const gitSubcommandAllowed = (git: GitParse): boolean => {
  switch (git.subcommand) {
    case 'branch':
    case 'tag':
      return listingAllowed(git.subcommand, git.rest);
    case 'remote':
      return remoteAllowed(git.rest);
    case 'reflog':
      return reflogAllowed(git.rest);
    default:
      return git.subcommand !== undefined && GIT_READ_ONLY_SUBCOMMANDS.has(git.subcommand) && gitReadOnlyAllowed(git.subcommand, git.rest);
  }
};

const gitApproved = (segment: Segment, context: ApprovalContext, changed: readonly string[]): boolean => {
  const git = segment.effects.git;
  if (git === undefined || git.unknownOption || git.cwdChange || git.configOverride) return false;
  const spec = segment.effects.spec as CommandSpec;
  if (git.globals.some((entry) => DISQUALIFYING_EFFECTS.has(spec.effectOf(entry.option) ?? 'flag'))) return false;
  if (git.rest.some((word) => word.staticValue === null)) return false;
  if (!gitSubcommandAllowed(git)) return false;
  const directories = reachableDirectories(context, segment.cwdTrail, changed);
  if (directories === undefined) return false;
  if (directories.some((directory) => discoveryAffected(context, directory, changed))) return false;
  const bare = git.globals.some((entry) => entry.option === '--bare');
  return directories.every((directory) => gitRepositoryAllowed(context, directory, bare));
};

const wrapperApproved = (wrapper: WrapperUse): boolean => {
  const declaration = wrapper.spec.wrapper;
  if (!wrapper.stripped || declaration?.approvable !== true) return false;
  const allowed = declaration.approvedOptions;
  return allowed === undefined || wrapper.options.every((option) => allowed.includes(option.option));
};

const segmentClass = (segment: Segment, context: ApprovalContext, changed: readonly string[]): ApprovalClass | undefined => {
  if (segment.unanalyzable || segment.commandIndex > 0) return undefined;
  const spec = segment.effects.spec;
  if (spec?.approval === undefined) return undefined;
  if (!segment.wrappers.every(wrapperApproved)) return undefined;
  if (spec.plainOperandsOnly === true && segment.wrappers.length > 0) return undefined;
  if (!programApproved(spec, segment, context)) return undefined;
  const writing = segment.effects.writes.length > 0 || segment.wrapperWrites.length > 0;
  const approved = spec.extractor === 'git' ? gitApproved(segment, context, changed) : plainApproved(spec, segment, context);
  if (!approved) return undefined;
  return spec.approval === 'edit' && writing ? 'edit' : 'read-only';
};

const plainApproved = (spec: CommandSpec, segment: Segment, context: ApprovalContext): boolean => {
  const parsed = segment.effects.parsed;
  if (parsed === undefined || parsed.undeclared.length > 0) return false;
  if (parsed.options.some((entry) => entry.dynamic === true)) return false;
  if (!optionsAllowed(spec, parsed.options)) return false;
  if (spec.plainOperandsOnly === true && parsed.options.length > 0) return false;
  if (!operandsAllowed(spec, parsed.operands, context)) return false;
  if (spec.extractor === 'sed' && !sedAllowed(spec, parsed)) return false;
  if (spec.extractor === 'cd' && parsed.operands.some((word) => word.staticValue === '-')) return false;
  if (!psAllowed(spec, segment, parsed.operands)) return false;
  return true;
};

const changesIntoUnknownDirectory = (segment: Segment): boolean => {
  const word = segment.words[segment.effectiveIndex];
  if (word === undefined || word.value !== 'cd') return false;
  const parsed = segment.effects.parsed;
  const [operand] = parsed?.operands ?? [];
  return operand === undefined || operand.staticValue === null || operand.staticValue === '-';
};

const EVERYTHING = '/';

const changedPathOf = (target: Target, context: ApprovalContext): string => {
  if (!('literal' in target)) return EVERYTHING;
  if (target.literal === '~' || target.literal.startsWith('~/')) return path.join(context.home, target.literal.slice(1));
  return target.literal.startsWith('~') ? EVERYTHING : absoluteFrom(target.literal, context.cwd);
};

const changedPathsOf = (segment: Segment, redirects: readonly Target[], context: ApprovalContext): string[] =>
  [...redirects, ...segment.wrapperWrites, ...segment.effects.writes].map((target) => changedPathOf(target, context));

const analysisApproval = (context: ApprovalContext, analysis: Analysis, changed: string[]): ApprovalClass | undefined => {
  if ([...analysis.redirects, ...analysis.reads].some((target) => 'unresolvable' in target)) return undefined;
  let directoryUnknown = false;
  let approval: ApprovalClass = 'read-only';
  for (const [position, segment] of analysis.segments.entries()) {
    for (const inner of analysis.nested) {
      if (inner.at === position && analysisApproval(context, inner, changed) !== 'read-only') return undefined;
    }
    if (directoryUnknown) return undefined;
    const kind = segmentClass(segment, context, changed);
    if (kind === undefined) return undefined;
    if (kind === 'edit') approval = 'edit';
    changed.push(...changedPathsOf(segment, analysis.redirects.filter((_, index) => analysis.redirectAt[index] === position), context));
    if (changesIntoUnknownDirectory(segment)) directoryUnknown = true;
  }
  return approval;
};

export const commandApproval = (context: ApprovalContext, command: string, analysis: Analysis | null): ApprovalClass | undefined => {
  if (analysis === null || command.length > MAX_APPROVABLE_COMMAND_CHARS || analysis.segments.length === 0) return undefined;
  if (!insideRoots([context.cwd], context.roots, context.cwd, context.fs.canonicalise)) return undefined;
  return analysisApproval(context, analysis, []);
};
