import path from 'node:path';
import { hasOption, optionsNamed, parseArgv } from './argv.ts';
import type { ParsedArgv, ParsedOption } from './argv.ts';
import { parseGit } from './git-argv.ts';
import { GIT_READ_ONLY_SUBCOMMANDS, gitSubcommandSpec } from './git-subcommands.ts';
import type { GitParse } from './git-argv.ts';
import { specOf } from './command-specs.ts';
import type { CommandSpec } from './command-specs.ts';
import { scanSedScript } from './sed-script.ts';
import type { Segment, Word } from './shell.ts';
import { DYNAMIC, markConfigOverride, markRelativeUnresolvable, targetOfOption, targetOfText } from './targets.ts';
import type { CwdEffect, Target } from './targets.ts';

export type ProgramEffects = {
  writes: Target[];
  reads: Target[];
  opaque: boolean;
  darwinWrites?: Target[];
  spec?: CommandSpec;
  parsed?: ParsedArgv;
  git?: GitParse;
};

const NONE: ProgramEffects = { writes: [], reads: [], opaque: false };
const REMOTE_NAME = '__remote_name__';
const EXTRACTED = '__extracted__';
const GLOB_CHARACTER = /[*?[\]{}]/;
const REMOTE_OPERAND = /^[^/]*:/;
const DASH = '-';
export const DARWIN_SED = '/usr/bin/sed';

const operandTarget = (word: Word, access: 'read' | 'write'): Target => {
  if (word.staticValue !== null) return targetOfText(word.staticValue);
  if (access === 'read' && word.glob) return { literal: globDirectory(word.value) };
  return DYNAMIC;
};

export const globDirectory = (pattern: string): string => {
  const slash = pattern.lastIndexOf('/', pattern.search(GLOB_CHARACTER));
  if (slash === -1) return '.';
  return slash === 0 ? '/' : pattern.slice(0, slash);
};

const optionValues = (parsed: ParsedArgv, ...names: readonly string[]): ParsedOption[] => optionsNamed(parsed, ...names);

const withoutStdout = (options: readonly ParsedOption[]): ParsedOption[] => options.filter((option) => option.value !== DASH);

const targetsOf = (words: readonly Word[], access: 'read' | 'write'): Target[] => words.map((word) => operandTarget(word, access));

const removing = (target: Target): Target => ('literal' in target ? { ...target, removes: true } : target);

const into = (directories: readonly Target[], entry: string): Target[] =>
  directories.map((directory): Target => ('literal' in directory ? targetOfText(`${directory.literal}/${entry}`) : directory));

const isRemote = (word: Word | undefined): boolean => word !== undefined && word.staticValue !== null && REMOTE_OPERAND.test(word.staticValue) && !word.staticValue.startsWith('.');

const optionEffectTargets = (spec: CommandSpec, parsed: ParsedArgv): { reads: Target[]; writes: Target[] } => {
  const reads: Target[] = [];
  const writes: Target[] = [];
  for (const option of parsed.options) {
    const effect = spec.effectOf(option.option);
    if (effect === 'read') reads.push(targetOfOption(option));
    else if (effect === 'write') writes.push(targetOfOption(option));
  }
  return { reads, writes };
};

const roleEffects = (spec: CommandSpec, parsed: ParsedArgv): ProgramEffects => {
  const { reads, writes } = optionEffectTargets(spec, parsed);
  const operands = parsed.operands;
  const directories = optionValues(parsed, '-t', '--target-directory');
  const last = operands.at(-1);
  const markRemoves = (targets: Target[]): Target[] => (spec.removes === true ? targets.map(removing) : targets);
  switch (spec.operands) {
    case 'none':
      break;
    case 'read-all':
      reads.push(...targetsOf(operands, 'read'));
      break;
    case 'write-all':
      writes.push(...markRemoves(targetsOf(operands, 'write')));
      break;
    case 'copy':
      if (directories.length > 0) reads.push(...targetsOf(operands, 'read'));
      else {
        reads.push(...targetsOf(operands.slice(0, -1), 'read'));
        if (last !== undefined) writes.push(operandTarget(last, 'write'));
      }
      break;
    case 'move':
      writes.push(...targetsOf(operands, 'write'));
      reads.push(...targetsOf(directories.length > 0 ? operands : operands.slice(0, -1), 'read'));
      break;
    case 'pattern-first': {
      const patternGiven = spec.patternOptions?.some((name) => hasOption(parsed, name)) === true;
      reads.push(...targetsOf(patternGiven ? operands : operands.slice(1), 'read'));
      break;
    }
    case 'first-write-rest-read':
      if (writes.length > 0) reads.push(...targetsOf(operands, 'read'));
      else {
        const [archive, ...members] = operands;
        if (archive !== undefined && archive.staticValue !== DASH) writes.push(operandTarget(archive, 'write'));
        reads.push(...targetsOf(members, 'read'));
      }
      break;
    case 'first-read-second-write': {
      const [source, destination] = operands;
      if (source !== undefined) reads.push(operandTarget(source, 'read'));
      if (destination !== undefined) writes.push(operandTarget(destination, 'write'));
      break;
    }
    case 'candidate-all':
      break;
  }
  return { writes, reads, opaque: false };
};

const copyLike = (spec: CommandSpec, parsed: ParsedArgv, name: string): ProgramEffects => {
  const directories = optionValues(parsed, '-t', '--target-directory');
  const operands = parsed.operands;
  if (name === 'install' && hasOption(parsed, '-d')) return { writes: targetsOf(operands, 'write'), reads: [], opaque: false };
  if (directories.length > 0) return { writes: directories.map(targetOfOption), reads: name === 'ln' ? [] : targetsOf(operands, 'read'), opaque: false };
  const reads = name === 'ln' ? [] : targetsOf(operands.slice(0, -1), 'read');
  if (operands.length === 1 && name === 'ln') return { writes: [DYNAMIC], reads, opaque: false };
  const destination = operands.at(-1);
  return { writes: destination === undefined ? [] : [operandTarget(destination, 'write')], reads, opaque: false };
};

const ddEffects = (args: readonly Word[]): ProgramEffects => {
  const pick = (prefix: string): Target[] =>
    args.filter((word) => word.value.startsWith(prefix)).map((word) => (word.staticValue === null ? DYNAMIC : targetOfText(word.staticValue.slice(prefix.length))));
  return { writes: pick('of='), reads: pick('if='), opaque: false };
};

export type SedFacts = {
  scripts: Array<string | null>;
  scriptFiles: ParsedOption[];
  files: Word[];
  inPlace: boolean;
  extension: ParsedOption | undefined;
};

export const sedFacts = (parsed: ParsedArgv): SedFacts => {
  const expressions = optionValues(parsed, '-e');
  const scriptFiles = optionValues(parsed, '-f');
  const scriptGivenByOption = expressions.length > 0 || scriptFiles.length > 0;
  const [first, ...rest] = parsed.operands;
  const scripts: Array<string | null> = expressions.map((entry) => (entry.dynamic === true ? null : (entry.value ?? '')));
  const files = scriptGivenByOption ? parsed.operands : rest;
  if (!scriptGivenByOption && first !== undefined) scripts.push(first.staticValue);
  const extension = optionsNamed(parsed, '-i', '-I')[0];
  return { scripts, scriptFiles, files, inPlace: extension !== undefined, extension };
};

const backupTargets = (files: readonly Word[], extension: ParsedOption | undefined): Target[] => {
  if (extension === undefined) return [];
  if (extension.dynamic === true) return files.length > 0 ? [DYNAMIC] : [];
  const suffix = extension.value ?? '';
  if (suffix === '') return [];
  if (suffix.includes('/')) return files.length > 0 ? [DYNAMIC] : [];
  return files.map((file): Target => (file.staticValue === null ? DYNAMIC : targetOfText(`${file.staticValue}${suffix}`)));
};

const scriptTargets = (scripts: ReadonlyArray<string | null>): { writes: Target[]; reads: Target[] } => {
  const writes: Target[] = [];
  const reads: Target[] = [];
  for (const script of scripts) {
    if (script === null) {
      writes.push(DYNAMIC);
      continue;
    }
    const scan = scanSedScript(script);
    writes.push(...scan.writes);
    reads.push(...scan.reads);
  }
  return { writes, reads };
};

type GnuSed = { files: Word[]; inPlace: boolean; scriptFiles: Word[] };

const GNU_VALUED_SHORT = new Set(['e', 'f', 'l']);

const gnuSedReading = (args: readonly Word[]): GnuSed => {
  const operands: Word[] = [];
  const scriptFiles: Word[] = [];
  let inPlace = false;
  let scriptGiven = false;
  let afterSeparator = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as Word;
    if (afterSeparator || !word.literal || !word.value.startsWith('-') || word.value === '-') {
      operands.push(word);
    } else if (word.value === '--') {
      afterSeparator = true;
    } else if (word.value.startsWith('--')) {
      const name = word.value.slice(2).split('=')[0] as string;
      const attached = word.value.includes('=');
      if (name === 'in-place') inPlace = true;
      if (name === 'expression' || name === 'file') scriptGiven = true;
      if (name === 'file') scriptFiles.push(attached ? syntheticWord(word.value.slice(word.value.indexOf('=') + 1)) : (args[index + 1] ?? syntheticWord('')));
      if (!attached && (name === 'expression' || name === 'file' || name === 'line-length')) index += 1;
    } else {
      for (let position = 1; position < word.value.length; position += 1) {
        const letter = word.value.charAt(position);
        if (letter === 'i') {
          inPlace = true;
          break;
        }
        if (!GNU_VALUED_SHORT.has(letter)) continue;
        const rest = word.value.slice(position + 1);
        if (letter === 'e' || letter === 'f') scriptGiven = true;
        if (letter === 'f') scriptFiles.push(rest === '' ? (args[index + 1] ?? syntheticWord('')) : syntheticWord(rest));
        if (rest === '') index += 1;
        break;
      }
    }
  }
  return { files: scriptGiven ? operands : operands.slice(1), inPlace, scriptFiles };
};

const syntheticWord = (value: string): Word => ({ value, literal: true, plain: true, glob: false, staticValue: value });

const uniqueTargets = (targets: readonly Target[]): Target[] => {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = JSON.stringify(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const sedEffects = (spec: CommandSpec, args: readonly Word[], parsed: ParsedArgv): ProgramEffects => {
  const facts = sedFacts(parsed);
  const script = scriptTargets(facts.scripts);
  const darwinFiles = targetsOf(facts.files, 'write');
  const gnu = gnuSedReading(args);
  const gnuFiles = targetsOf(gnu.files, 'write');
  const darwinWrites = [...script.writes, ...(facts.inPlace ? [...darwinFiles, ...backupTargets(facts.files, facts.extension)] : [])];
  const unionWrites = uniqueTargets([...darwinWrites, ...(gnu.inPlace ? gnuFiles : [])]);
  const scriptFileReads = facts.scriptFiles.map(targetOfOption);
  const reads = [
    ...scriptFileReads,
    ...gnu.scriptFiles.map((word) => operandTarget(word, 'read')),
    ...script.reads,
    ...(facts.inPlace ? [] : targetsOf(facts.files, 'read')),
    ...(gnu.inPlace ? [] : targetsOf(gnu.files, 'read')),
  ];
  return { writes: unionWrites, darwinWrites, reads: uniqueTargets(reads), opaque: false, spec, parsed };
};

const tarEffects = (args: readonly Word[], spec: CommandSpec): ProgramEffects => {
  const first = args[0];
  const oldStyle = first !== undefined && first.literal && !first.value.startsWith('-');
  const parsed = parseArgv(oldStyle ? [] : args, spec);
  const letters = oldStyle ? (first as Word).value : '';
  const extract = oldStyle ? letters.includes('x') : hasOption(parsed, '-x', '--extract', '--get');
  const create = oldStyle ? letters.includes('c') : hasOption(parsed, '-c', '--create');
  const listing = oldStyle ? letters.includes('t') : hasOption(parsed, '-t', '--list');
  let archives: Target[];
  let directories: Target[];
  let operands: Word[];
  if (oldStyle) {
    const rest = args.slice(1);
    const takesFile = letters.includes('f');
    const takesDirectory = letters.includes('C');
    const leading = rest.slice(0, Number(takesFile) + Number(takesDirectory));
    const directoryFirst = takesDirectory && takesFile && letters.indexOf('C') < letters.indexOf('f');
    const leadingTarget = (position: number): Target => {
      const word = leading[position];
      return word === undefined ? DYNAMIC : operandTarget(word, 'write');
    };
    archives = takesFile ? [leadingTarget(directoryFirst ? 1 : 0)] : [];
    directories = takesDirectory ? [leadingTarget(takesFile && !directoryFirst ? 1 : 0)] : [];
    operands = rest.slice(leading.length);
  } else {
    archives = optionValues(parsed, '-f', '--file').map(targetOfOption);
    directories = optionValues(parsed, '-C', '--directory').map(targetOfOption);
    operands = parsed.operands;
  }
  const memberEffect: CwdEffect = directories.length > 0 ? 'changed' : 'none';
  const reads: Target[] = [];
  const writes: Target[] = [];
  if (extract) {
    reads.push(...archives);
    if (directories.length === 0) writes.push(DYNAMIC);
    else {
      writes.push(...into(directories, EXTRACTED));
      if (markRelativeUnresolvable(directories, 'changed').some((directory) => 'unresolvable' in directory)) writes.push({ unresolvable: { kind: 'cwd-changed' } });
    }
  } else if (create) {
    writes.push(...archives);
    reads.push(...markRelativeUnresolvable(targetsOf(operands, 'read'), memberEffect));
  } else if (listing) {
    reads.push(...archives);
  }
  return { writes, reads, opaque: false, spec, parsed };
};

const curlEffects = (spec: CommandSpec, parsed: ParsedArgv): ProgramEffects => {
  const outputs = withoutStdout(parsed.options.filter((option) => spec.effectOf(option.option) === 'write' && option.option !== '--output-dir')).map(targetOfOption);
  const directories = optionValues(parsed, '--output-dir').map(targetOfOption);
  const remoteName = hasOption(parsed, '-O', '--remote-name');
  const named = remoteName ? (directories.length > 0 ? into(directories, REMOTE_NAME) : [DYNAMIC]) : [];
  return { writes: [...outputs, ...(remoteName ? [] : directories), ...named], reads: [], opaque: false };
};

const wgetEffects = (parsed: ParsedArgv): ProgramEffects => {
  const logs = optionValues(parsed, '-o', '--output-file', '-a', '--append-output').map(targetOfOption);
  const documents = optionValues(parsed, '-O', '--output-document');
  const extra = optionValues(parsed, '--save-cookies', '--warc-file', '--rejected-log').map(targetOfOption);
  if (documents.length > 0) return { writes: [...logs, ...extra, ...withoutStdout(documents).map(targetOfOption)], reads: [], opaque: false };
  if (hasOption(parsed, '--spider')) return { writes: [...logs, ...extra], reads: [], opaque: false };
  const prefixes = optionValues(parsed, '-P', '--directory-prefix').map(targetOfOption);
  return { writes: [...logs, ...extra, ...(prefixes.length > 0 ? into(prefixes, REMOTE_NAME) : [DYNAMIC])], reads: [], opaque: false };
};

const UNZIP_LISTING = /^-[lptvZz]+$/;

const unzipEffects = (args: readonly Word[], parsed: ParsedArgv): ProgramEffects => {
  const reads = targetsOf(parsed.operands.slice(0, 1), 'read');
  if (args.some((word) => word.literal && UNZIP_LISTING.test(word.value))) return { writes: [], reads, opaque: false };
  const directories = optionValues(parsed, '-d').map(targetOfOption);
  return { writes: directories.length > 0 ? into(directories, EXTRACTED) : [DYNAMIC], reads, opaque: false };
};

const transferEffects = (spec: CommandSpec, parsed: ParsedArgv): ProgramEffects => {
  const { writes } = optionEffectTargets(spec, parsed);
  const operands = parsed.operands;
  if (operands.length < 2) return { writes, reads: [], opaque: false };
  const destination = operands.at(-1) as Word;
  const deleting = parsed.options.some((option) => spec.effectOf(option.option) === 'delete');
  const destinationTarget = operandTarget(destination, 'write');
  const reads = targetsOf(operands.slice(0, -1).filter((source) => !isRemote(source)), 'read');
  const destinationWrites = isRemote(destination) ? [] : [deleting ? removing(destinationTarget) : destinationTarget];
  return { writes: [...writes, ...destinationWrites], reads, opaque: false };
};

const awkEffects = (spec: CommandSpec, parsed: ParsedArgv): ProgramEffects => {
  const { reads } = optionEffectTargets(spec, parsed);
  if (reads.length > 0) return { writes: [], reads: [...reads, ...targetsOf(parsed.operands, 'read')], opaque: true };
  const [program, ...files] = parsed.operands;
  const text = program?.staticValue ?? null;
  const writing = text !== null && /system\s*\(|\||print[f]?\b[^;}\n]*>/.test(text);
  return { writes: writing ? [DYNAMIC] : [], reads: targetsOf(files, 'read'), opaque: text === null || writing };
};

const findEffects = (spec: CommandSpec, parsed: ParsedArgv): ProgramEffects => {
  const { reads } = optionEffectTargets(spec, parsed);
  const starting = targetsOf(parsed.operands, 'read');
  const deleting = hasOption(parsed, '-delete');
  return { writes: deleting ? starting.map(removing) : [], reads: [...reads, ...starting], opaque: false };
};

const cdEffects = (name: string, parsed: ParsedArgv): ProgramEffects => {
  const [operand] = parsed.operands;
  if (name === 'popd') return NONE;
  if (operand === undefined) return { writes: [], reads: name === 'cd' ? [{ literal: '~' }] : [], opaque: false };
  return { writes: [], reads: [operand.staticValue === DASH ? DYNAMIC : operandTarget(operand, 'read')], opaque: false };
};

const WORKTREE_REMOVAL: Target = { worktree: true, removes: true };
const GLOB_IN_PATHSPEC = /[*?[\]{}]/;
const SHORT_MAGIC = new Set(['/', '!', '^']);

type Pathspec = { names: string[]; rest: string };

const parsePathspecMagic = (text: string): Pathspec => {
  if (text.startsWith(':(')) {
    const close = text.indexOf(')');
    if (close !== -1) return { names: text.slice(2, close).split(','), rest: text.slice(close + 1) };
  }
  let index = 1;
  const names: string[] = [];
  while (SHORT_MAGIC.has(text.charAt(index))) {
    names.push(text.charAt(index) === '/' ? 'top' : 'exclude');
    index += 1;
  }
  return { names, rest: text.charAt(index) === ':' ? text.slice(index + 1) : text.slice(index) };
};

const pathspecRemoval = (word: Word): Target[] => {
  if (word.staticValue === null) return [DYNAMIC];
  const text = word.staticValue;
  if (!text.startsWith(':')) return [removing(targetOfText(text))];
  const { names, rest } = parsePathspecMagic(text);
  if (names.includes('exclude')) return [];
  if (names.includes('top')) {
    if (rest === '') return [WORKTREE_REMOVAL];
    return [GLOB_IN_PATHSPEC.test(rest) ? DYNAMIC : { worktree: true, removes: true, below: rest }];
  }
  return [removing(targetOfText(rest === '' ? '.' : rest))];
};

const pathspecRemovals = (words: readonly Word[]): Target[] => words.flatMap(pathspecRemoval);

const afterSeparator = (parsed: ParsedArgv): { before: Word[]; after: Word[] } => {
  const at = parsed.separatorAt ?? parsed.operands.length;
  return { before: parsed.operands.slice(0, at), after: parsed.operands.slice(at) };
};

const candidateRemoval = (word: Word): Target[] => (isPathspecMagic(word) ? pathspecRemoval(word) : [word.staticValue === null ? DYNAMIC : { candidate: word.staticValue, removes: true }]);

const isPathspecMagic = (word: Word): boolean => word.staticValue !== null && word.staticValue.startsWith(':');

const lastMode = (parsed: ParsedArgv, ...modes: readonly string[]): string | undefined => parsed.options.filter((entry) => modes.includes(entry.option)).at(-1)?.option;

const cleanRemoves = (parsed: ParsedArgv): boolean => {
  let dryRun = false;
  for (const entry of parsed.options) {
    if (entry.option === '-n' || entry.option === '--dry-run') dryRun = true;
    else if (entry.option === '--no-dry-run') dryRun = false;
  }
  return !dryRun;
};

const restoresWorktree = (parsed: ParsedArgv): boolean => !hasOption(parsed, '--staged', '-S') || hasOption(parsed, '--worktree', '-W');

const gitSubcommandEffects = (subcommand: string, rest: readonly Word[]): { writes: Target[]; reads: Target[] } => {
  const spec = gitSubcommandSpec(subcommand);
  const parsed = parseArgv(rest, spec);
  const { reads: optionReads, writes } = optionEffectTargets(spec, parsed);
  const operands = parsed.operands;
  const fromFile = hasOption(parsed, '--pathspec-from-file') ? [DYNAMIC] : [];
  if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) {
    const paths = subcommand === 'grep' && !hasOption(parsed, '-e', '-f') ? operands.slice(1) : operands;
    return { writes, reads: [...optionReads, ...targetsOf(paths, 'read')] };
  }
  switch (subcommand) {
    case 'clone': {
      const destination = operands[1];
      return { writes: [...writes, destination === undefined ? DYNAMIC : operandTarget(destination, 'write')], reads: [] };
    }
    case 'init':
      return { writes: operands[0] === undefined ? [] : [operandTarget(operands[0], 'write')], reads: [] };
    case 'worktree': {
      const target = operands[0]?.staticValue === 'add' ? operands[1] : undefined;
      return { writes: target === undefined ? [] : [operandTarget(target, 'write')], reads: [] };
    }
    case 'bundle': {
      const target = operands[0]?.staticValue === 'create' ? operands[1] : undefined;
      return { writes: target === undefined ? [] : [operandTarget(target, 'write')], reads: [] };
    }
    case 'archive':
    case 'format-patch':
      return { writes, reads: [] };
    case 'rm':
      return { writes: targetsOf(operands, 'write').map(removing), reads: [] };
    case 'mv':
      return { writes: targetsOf(operands, 'write'), reads: [] };
    case 'restore':
      return { writes: restoresWorktree(parsed) ? [...pathspecRemovals(operands), ...fromFile] : [], reads: [] };
    case 'clean': {
      if (!cleanRemoves(parsed)) return { writes: [], reads: [] };
      return { writes: operands.length === 0 ? [removing(targetOfText('.'))] : pathspecRemovals(operands), reads: [] };
    }
    case 'switch':
      return { writes: hasOption(parsed, '-f', '--force', '--discard-changes') ? [WORKTREE_REMOVAL] : [], reads: [] };
    case 'checkout': {
      const { before, after } = afterSeparator(parsed);
      const forced = hasOption(parsed, '-f', '--force');
      return { writes: [...(forced ? [WORKTREE_REMOVAL] : []), ...pathspecRemovals(after), ...before.flatMap(candidateRemoval), ...fromFile], reads: [] };
    }
    case 'reset': {
      const { before, after } = afterSeparator(parsed);
      const mode = lastMode(parsed, '--hard', '--merge', '--soft', '--mixed', '--keep');
      const whole = mode === '--hard' || mode === '--merge';
      return {
        writes: [...(whole ? [WORKTREE_REMOVAL] : []), ...targetsOf(after, 'write'), ...before.map((word): Target => (word.staticValue === null ? DYNAMIC : { candidate: word.staticValue }))],
        reads: [],
      };
    }
    case 'apply':
    case 'am':
      return { writes: [DYNAMIC], reads: [] };
    default:
      return { writes: [], reads: [] };
  }
};

const gitEffects = (args: readonly Word[], spec: CommandSpec): ProgramEffects => {
  const git = parseGit(args);
  if (git.subcommand === undefined) return { ...NONE, spec, git };
  const found = gitSubcommandEffects(git.subcommand, git.rest);
  const mark = (targets: Target[]): Target[] => {
    const relocated = git.cwdChange ? markRelativeUnresolvable(targets, 'changed') : targets;
    return git.configOverride ? markConfigOverride(relocated) : relocated;
  };
  return { writes: mark(found.writes), reads: mark(found.reads), opaque: false, spec, git };
};

const interpreterEffects = (name: string, spec: CommandSpec, args: readonly Word[]): ProgramEffects => {
  const inline = args.some((word) => word.literal && spec.inlineOptions?.test(word.value) === true);
  const hasOperand = args.some((word) => !word.literal || !word.value.startsWith('-'));
  const script = args.find((word) => !word.literal || !word.value.startsWith('-'));
  const reads = script === undefined ? [] : [operandTarget(script, 'read')];
  const writes = path.basename(name).startsWith('perl') ? perlWrites(args) : [];
  return { writes, reads, opaque: inline || !hasOperand, spec };
};

const PERL_IN_PLACE = /^-[A-Za-z]*i/;
const PERL_SCRIPT = /^-[A-Za-z]*[eE]/;
const PERL_VALUED = new Set(['-e', '-E', '-I', '-M', '-m']);

const perlWrites = (args: readonly Word[]): Target[] => {
  if (!args.some((word) => word.literal && PERL_IN_PLACE.test(word.value))) return [];
  const scriptGiven = args.some((word) => word.literal && PERL_SCRIPT.test(word.value));
  const operands: Word[] = [];
  let skipNext = false;
  for (const word of args) {
    if (skipNext) skipNext = false;
    else if (word.literal && word.value.startsWith('-') && word.value !== '-') skipNext = PERL_VALUED.has(word.value);
    else operands.push(word);
  }
  return targetsOf(scriptGiven ? operands : operands.slice(1), 'write');
};

const programEffects = (name: string, spec: CommandSpec, args: readonly Word[]): ProgramEffects => {
  if (spec.extractor === 'interpreter') return interpreterEffects(name, spec, args);
  if (spec.extractor === 'dd') return { ...ddEffects(args), spec };
  if (spec.extractor === 'git') return gitEffects(args, spec);
  if (spec.extractor === 'tar') return tarEffects(args, spec);
  const parsed = parseArgv(args, spec);
  switch (spec.extractor) {
    case 'sed':
      return sedEffects(spec, args, parsed);
    case 'ln':
    case 'install':
      return { ...copyLike(spec, parsed, spec.extractor), spec, parsed };
    case 'curl':
      return { ...curlEffects(spec, parsed), spec, parsed };
    case 'wget':
      return { ...wgetEffects(parsed), spec, parsed };
    case 'unzip':
      return { ...unzipEffects(args, parsed), spec, parsed };
    case 'transfer':
      return { ...transferEffects(spec, parsed), spec, parsed };
    case 'patch':
      return { writes: hasOption(parsed, '--dry-run') ? [] : [DYNAMIC], reads: [], opaque: false, spec, parsed };
    case 'awk':
      return { ...awkEffects(spec, parsed), spec, parsed };
    case 'find':
      return { ...findEffects(spec, parsed), spec, parsed };
    case 'cd':
      return { ...cdEffects(name, parsed), spec, parsed };
    default:
      return { ...roleEffects(spec, parsed), spec, parsed };
  }
};

export const pathEffectsOf = (segment: Segment, effect: CwdEffect): ProgramEffects => {
  const program = segment.words[segment.effectiveIndex];
  if (program === undefined) return { ...NONE, writes: [...segment.wrapperWrites] };
  const spec = program.literal ? specOf(path.basename(program.value)) : undefined;
  if (spec === undefined) return { ...NONE, writes: [...segment.wrapperWrites] };
  const name = path.basename(program.value);
  const found = programEffects(name, spec, segment.words.slice(segment.effectiveIndex + 1));
  const withWrapperWrites = (targets: Target[]): Target[] => [...segment.wrapperWrites, ...markRelativeUnresolvable(targets, effect)];
  return {
    ...found,
    writes: withWrapperWrites(found.writes),
    reads: markRelativeUnresolvable(found.reads, effect),
    ...(found.darwinWrites === undefined ? {} : { darwinWrites: withWrapperWrites(found.darwinWrites) }),
  };
};
