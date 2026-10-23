import path from 'node:path';
import type { PermissionRule } from '@momonga/config';
import { analyzeCommand } from './shell.ts';
import type { Analysis, Segment, Word } from './shell.ts';

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const PREFIX_SUFFIX = ':*';
const INERT_PRINTERS: ReadonlySet<string> = new Set(['echo', 'printf']);
const WORD_PIECE_SEPARATOR = /[=!]/;

export type MatchStrength = 'position' | 'incidental';

const PACKAGE_MANAGER_DANGEROUS_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  npm: ['--script-shell', '--userconfig', '--prefix', '--node-options', '--globalconfig'],
  yarn: ['--script-shell', '--use-yarnrc', '--cwd'],
  pnpm: ['--script-shell'],
};

const PACKAGE_MANAGER_EXECUTING_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  npm: ['exec', 'x', 'init', 'create', 'innit'],
  pnpm: ['dlx', 'exec', 'create', 'x'],
  yarn: ['dlx', 'create', 'exec'],
};

const FIND_EXECUTING_PRIMARIES: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);

const ALWAYS_EXECUTING_PROGRAMS: ReadonlySet<string> = new Set(['npx', 'bunx']);

const GIT_GLOBAL_DANGEROUS_LONG = ['--git-dir', '--work-tree', '--exec-path', '--config-env'];
const GIT_SAFE_VALUED_GLOBALS: ReadonlySet<string> = new Set(['--namespace', '--super-prefix', '--attr-source']);
const GIT_DANGEROUS_SUBCOMMANDS: ReadonlySet<string> = new Set(['difftool', 'mergetool', 'filter-branch', 'filter-repo', 'config']);
const GIT_DANGEROUS_LONG = ['--open-files-in-pager', '--output', '--ext-diff', '--textconv', '--exec', '--extcmd', '--upload-pack', '--receive-pack', '--config', '--template'];
const GIT_UPLOAD_PACK_SHORT_SUBCOMMANDS: ReadonlySet<string> = new Set(['clone', 'fetch', 'ls-remote', 'archive', 'pull']);

const optionName = (word: string): string => {
  const equals = word.indexOf('=');
  return equals === -1 ? word : word.slice(0, equals);
};

const programName = (segment: Segment): string | undefined => {
  const program = segment.words[segment.commandIndex];
  return program !== undefined && program.literal ? path.basename(program.value) : undefined;
};

const firstOperand = (args: Word[]): string | undefined => args.find((word) => word.literal && !word.value.startsWith('-'))?.value;

const isGitDangerous = (args: Word[]): boolean => {
  let index = 0;
  for (;;) {
    const word = args[index];
    if (word === undefined) return false;
    if (!word.literal) return true;
    if (!word.value.startsWith('-')) break;
    const name = optionName(word.value);
    if (/^-[cC]/.test(word.value) && !word.value.startsWith('--')) return true;
    if (GIT_GLOBAL_DANGEROUS_LONG.includes(name)) return true;
    index += GIT_SAFE_VALUED_GLOBALS.has(word.value) ? 2 : 1;
  }
  const subcommand = (args[index] as Word).value;
  const rest = args.slice(index + 1);
  if (GIT_DANGEROUS_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === 'submodule' && rest.some((word) => word.value === 'foreach')) return true;
  if (subcommand === 'bisect' && rest.some((word) => word.value === 'run')) return true;
  return rest.some((word) => {
    if (!word.literal) return false;
    const text = word.value;
    if (!text.startsWith('-')) return false;
    if (!text.startsWith('--')) {
      if (text.startsWith('-O')) return true;
      if (subcommand === 'rebase' && text.startsWith('-x')) return true;
      return GIT_UPLOAD_PACK_SHORT_SUBCOMMANDS.has(subcommand) && text.startsWith('-u');
    }
    const name = optionName(text);
    if (subcommand === 'archive' && name.length >= 3 && '--remote'.startsWith(name)) return true;
    return GIT_DANGEROUS_LONG.some((dangerous) => name.startsWith(dangerous) || (name.length >= 3 && dangerous.startsWith(name)));
  });
};

const invokesDangerousOption = (segment: Segment): boolean => {
  const name = programName(segment);
  if (name === undefined) return false;
  const args = segment.words.slice(segment.commandIndex + 1);
  if (name === 'git') return isGitDangerous(args);
  if (name === 'find') {
    return args.some((word) => word.literal && FIND_EXECUTING_PRIMARIES.has(word.value));
  }
  const dangerous = PACKAGE_MANAGER_DANGEROUS_OPTIONS[name];
  if (dangerous === undefined) return false;
  const normalized = args.filter((word) => word.literal && word.value.startsWith('--')).map((word) => optionName(word.value).replaceAll('_', '-'));
  const configPrefixed = name === 'pnpm' && normalized.some((option) => option.startsWith('--config.'));
  return configPrefixed || normalized.some((option) => dangerous.includes(option));
};

const isExecutingPackageInvocation = (segment: Segment): boolean => {
  const name = programName(segment);
  if (name === undefined) return false;
  if (ALWAYS_EXECUTING_PROGRAMS.has(name)) return true;
  const executing = PACKAGE_MANAGER_EXECUTING_SUBCOMMANDS[name];
  if (executing === undefined) return false;
  const subcommand = firstOperand(segment.words.slice(segment.commandIndex + 1));
  return subcommand !== undefined && executing.includes(subcommand);
};

type CommandPattern = { kind: 'exact'; text: string } | { kind: 'prefix'; words: string[] };

const patternOf = (rule: PermissionRule): CommandPattern => {
  const specifier = rule.specifier as string;
  if (specifier.endsWith(PREFIX_SUFFIX)) {
    return { kind: 'prefix', words: specifier.slice(0, -PREFIX_SUFFIX.length).trim().split(/\s+/) };
  }
  return { kind: 'exact', text: specifier.trim() };
};

const patternWords = (pattern: CommandPattern): string[] => (pattern.kind === 'prefix' ? pattern.words : pattern.text.split(/\s+/));

const wordMatches = (word: Word | undefined, expected: string, allowBasename: boolean): boolean => {
  if (word === undefined || !word.literal) return false;
  if (word.value === expected) return true;
  return allowBasename && !expected.includes('/') && !ASSIGNMENT.test(expected) && path.basename(word.value) === expected;
};

const prefixMatchesAt = (words: Word[], expected: string[], offset: number, lenientFirstWord: boolean): boolean =>
  expected.every((expectedWord, index) => wordMatches(words[offset + index], expectedWord, lenientFirstWord && index === 0));

const strictSegmentMatches = (pattern: CommandPattern, segment: Segment): boolean => {
  if (pattern.kind === 'exact') return segment.text === pattern.text;
  return (
    segment.prefixEligible &&
    !invokesDangerousOption(segment) &&
    !isExecutingPackageInvocation(segment) &&
    prefixMatchesAt(segment.words, pattern.words, 0, false)
  );
};

const expandWordPieces = (words: Word[]): Word[] =>
  words.flatMap((word) => {
    if (!word.literal || !WORD_PIECE_SEPARATOR.test(word.value)) return [word];
    const pieces = word.value
      .split(WORD_PIECE_SEPARATOR)
      .filter((piece) => piece !== '')
      .map((piece): Word => ({ value: piece, literal: true, plain: false, staticValue: piece }));
    return [word, ...pieces];
  });

const conservativeSegmentStrength = (pattern: CommandPattern, segment: Segment): MatchStrength | null => {
  if (segment.unanalyzable) return 'position';
  if (pattern.kind === 'exact' && segment.text === pattern.text) return 'position';
  const expected = patternWords(pattern);
  const coversWholeCommand = (offset: number, length: number): boolean => pattern.kind === 'prefix' || offset + expected.length === length;
  const positionOffsets = [0, segment.commandIndex, segment.effectiveIndex].filter((offset) => offset >= 0);
  if (positionOffsets.some((offset) => prefixMatchesAt(segment.words, expected, offset, true) && coversWholeCommand(offset, segment.words.length))) {
    return 'position';
  }
  const first = segment.words[0];
  const startsWithPrinter = first !== undefined && first.literal && INERT_PRINTERS.has(path.basename(first.value));
  if (startsWithPrinter) return null;
  const words = expandWordPieces(segment.words);
  const incidental = words.some((_word, offset) => prefixMatchesAt(words, expected, offset, true) && coversWholeCommand(offset, words.length));
  return incidental ? 'incidental' : null;
};

const strongest = (strengths: Array<MatchStrength | null>): MatchStrength | null =>
  strengths.includes('position') ? 'position' : strengths.includes('incidental') ? 'incidental' : null;

const conservativeAnalysisStrength = (pattern: CommandPattern, analysis: Analysis): MatchStrength | null =>
  strongest([
    ...analysis.segments.map((segment) => conservativeSegmentStrength(pattern, segment)),
    ...analysis.nested.map((inner) => conservativeAnalysisStrength(pattern, inner)),
  ]);

export const matchesSegment = (rule: PermissionRule, segment: Segment): boolean =>
  strictSegmentMatches(patternOf(rule), segment);

export const commandMatchStrength = (rule: PermissionRule, command: string): MatchStrength | null => {
  const pattern = patternOf(rule);
  if (pattern.kind === 'exact' && command.trim() === pattern.text) return 'position';
  const analysis = analyzeCommand(command);
  if (rule.effect === 'allow') {
    const covered = analysis !== null && analysis.segments.length > 0 && analysis.segments.every((segment) => strictSegmentMatches(pattern, segment));
    return covered ? 'position' : null;
  }
  if (analysis === null) return 'position';
  return conservativeAnalysisStrength(pattern, analysis);
};

export const matchesCommand = (rule: PermissionRule, command: string): boolean => commandMatchStrength(rule, command) !== null;

export const commandCoveredByAllowRules = (rules: PermissionRule[], command: string): PermissionRule | undefined => {
  const whole = rules.find((rule) => matchesCommand(rule, command));
  if (whole !== undefined) return whole;
  const analysis = analyzeCommand(command);
  if (analysis === null || analysis.segments.length === 0) return undefined;
  const covering: PermissionRule[] = [];
  for (const segment of analysis.segments) {
    const rule = rules.find((candidate) => matchesSegment(candidate, segment));
    if (rule === undefined) return undefined;
    covering.push(rule);
  }
  return covering[0];
};
