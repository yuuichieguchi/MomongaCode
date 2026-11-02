import path from 'node:path';
import { COMMAND_PREFIX_SUFFIX } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';
import { ASSIGNMENT } from './shell-lexemes.ts';
import { analyzeCommand } from './shell.ts';
import type { Analysis, Segment, Word } from './shell.ts';

export const INERT_PRINTERS: ReadonlySet<string> = new Set(['echo', 'printf']);
const WORD_PIECE_SEPARATOR = /[=!]/;

export type MatchStrength = 'position' | 'incidental';

export type CommandPattern = { kind: 'exact'; text: string } | { kind: 'prefix'; words: string[] };

export const commandPatternOf = (rule: PermissionRule): CommandPattern => {
  const specifier = rule.specifier as string;
  if (specifier.endsWith(COMMAND_PREFIX_SUFFIX)) {
    return { kind: 'prefix', words: specifier.slice(0, -COMMAND_PREFIX_SUFFIX.length).trim().split(/\s+/) };
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
  return segment.prefixEligible && prefixMatchesAt(segment.words, pattern.words, segment.commandIndex > 0 ? 0 : segment.strictIndex, false);
};

const expandWordPieces = (words: Word[]): Word[] =>
  words.flatMap((word) => {
    if (!word.literal || !WORD_PIECE_SEPARATOR.test(word.value)) return [word];
    const pieces = word.value
      .split(WORD_PIECE_SEPARATOR)
      .filter((piece) => piece !== '')
      .map((piece): Word => ({ value: piece, literal: true, plain: false, glob: false, staticValue: piece }));
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
  rule.specifier === undefined || strictSegmentMatches(commandPatternOf(rule), segment);

export const commandMatchStrength = (rule: PermissionRule, command: string): MatchStrength | null => {
  if (rule.specifier === undefined) return 'position';
  const pattern = commandPatternOf(rule);
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
