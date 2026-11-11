import path from 'node:path';
import { ASSIGNMENT, RESERVED_WORDS, commandPatternOf, commandSpecsFor, comparesByAdjacency, inertPrinterSet } from '@momonga/policy';
import type { CommandPattern, PermissionRule } from '@momonga/policy';
import type { Bool, Re, Seq } from 'z3-solver';
import { setContains, singleton } from './char-set.ts';
import type { CharSet } from './char-set.ts';
import type { Smt } from './smt.ts';

const WORD_CHARACTERS: CharSet = [
  [0x25, 0x25],
  [0x2b, 0x3a],
  [0x3d, 0x3d],
  [0x40, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];

const SPACE = 0x20;
const SLASH = 0x2f;
const HYPHEN = 0x2d;

export type CommandModel = {
  variable(name: string): Seq;
  domain(command: Seq): Bool;
  excludedBlock(command: Seq, text: string): Bool | undefined;
  position(command: Seq, rule: PermissionRule): Bool;
  incidental(command: Seq, rule: PermissionRule): Bool;
  strict(command: Seq, rule: PermissionRule): Bool;
  optionGap(command: Seq, rule: PermissionRule): Bool;
  unmodelled(rule: PermissionRule): boolean;
  wrapperDeny(rule: PermissionRule): boolean;
  wordCount(rule: PermissionRule): number;
  candidates(rule: PermissionRule): string[];
};

const SHELL_PAYLOAD_FLAG = '-c';
const PAYLOAD_EXAMPLE = 'ls';
const ARGUMENT_EXAMPLE = 'x';

const excludedProgramNames = (): string[] => {
  const fromSpecs = [...commandSpecsFor('darwin').all, ...commandSpecsFor('linux').all].filter((spec) => spec.wrapper !== undefined || spec.neverPrefix === true || spec.payload !== undefined).flatMap((spec) => [...spec.names]);
  return [...new Set([...fromSpecs, ...RESERVED_WORDS])];
};

const patternWords = (pattern: CommandPattern): string[] => (pattern.kind === 'prefix' ? pattern.words : pattern.text.split(/\s+/));

const firstNameOf = (rule: PermissionRule): string => path.basename(patternWords(commandPatternOf(rule))[0] as string);

export const createCommandModel = (smt: Smt): CommandModel => {
  const ctx = smt.ctx;
  const spaces = smt.plus(smt.chars(singleton(SPACE)));
  const slash = smt.chars(singleton(SLASH));
  const hyphen = smt.chars(singleton(HYPHEN));
  const wordAlphabet = smt.chars(WORD_CHARACTERS);
  const plainWord = smt.plus(wordAlphabet);
  const rest = smt.star(smt.concat(spaces, plainWord));

  const expressible = (text: string): boolean => [...text].every((character) => setContains(WORD_CHARACTERS, character.codePointAt(0) as number));

  const basenameIs = (name: string): Re => smt.concat(smt.optional(smt.concat(smt.star(wordAlphabet), slash)), smt.text(name), smt.star(slash));
  const wordsExpressible = (rule: PermissionRule): boolean => patternWords(commandPatternOf(rule)).every(expressible);
  const excludedNames = excludedProgramNames().filter(expressible);
  const printer = smt.union(...[...inertPrinterSet(commandSpecsFor('darwin'))].map(basenameIs));
  const command = smt.concat(plainWord, rest);

  const excludedBlock = (term: Seq, text: string): Bool | undefined => {
    const name = path.basename(text.split(' ')[0] as string);
    return excludedNames.includes(name) ? ctx.Not(smt.member(term, smt.concat(basenameIs(name), rest))) : undefined;
  };

  const lenient = (expected: string): Re => {
    const exactWord = smt.text(expected);
    if (expected.includes('/') || ASSIGNMENT.test(expected)) return exactWord;
    return smt.union(exactWord, smt.concat(smt.optional(smt.concat(smt.star(wordAlphabet), slash)), smt.text(expected), smt.star(slash)));
  };

  const sequence = (words: readonly string[], firstWordLanguage: (expected: string) => Re): Re =>
    smt.concat(...words.map((expected, index) => (index === 0 ? firstWordLanguage(expected) : smt.concat(spaces, smt.text(expected)))));

  const modelled = (rule: PermissionRule): boolean => wordsExpressible(rule) && !excludedNames.includes(firstNameOf(rule));

  const never = ctx.Bool.val(false);

  const positionLanguage = (pattern: CommandPattern): Re => {
    const words = patternWords(pattern);
    const body = sequence(words, lenient);
    return pattern.kind === 'prefix' ? smt.concat(body, rest) : body;
  };

  const incidentalLanguage = (pattern: CommandPattern): Re => {
    const words = patternWords(pattern);
    const body = sequence(words, lenient);
    const before = smt.concat(smt.difference(plainWord, printer), spaces, smt.star(smt.concat(plainWord, spaces)));
    return smt.concat(before, pattern.kind === 'prefix' ? smt.concat(body, rest) : body);
  };

  const strictLanguage = (pattern: CommandPattern): Re | undefined => {
    if (pattern.kind === 'exact') return [...pattern.text].every((character) => character === ' ' || expressible(character)) ? smt.text(pattern.text) : undefined;
    if (pattern.kind === 'glob') return undefined;
    return smt.concat(sequence(pattern.words, (expected) => smt.text(expected)), rest);
  };

  const gap = smt.star(smt.concat(spaces, hyphen, smt.star(plainWord), smt.optional(smt.concat(spaces, plainWord))));

  const gappedLanguage = (pattern: CommandPattern): Re => {
    const words = patternWords(pattern);
    const tail = words.slice(1).map((expected) => smt.concat(gap, spaces, smt.text(expected)));
    const body = smt.concat(smt.star(smt.concat(plainWord, spaces)), lenient(words[0] as string), ...tail);
    return pattern.kind === 'prefix' ? smt.concat(body, rest) : body;
  };

  const skipsOptions = (rule: PermissionRule): boolean =>
    rule.specifier !== undefined && rule.effect !== 'allow' && wordsExpressible(rule) && patternWords(commandPatternOf(rule)).length > 1 && !comparesByAdjacency(rule);

  const optionGap = (term: Seq, rule: PermissionRule): Bool => {
    if (!skipsOptions(rule)) return never;
    const pattern = commandPatternOf(rule);
    return ctx.And(smt.member(term, gappedLanguage(pattern)), ctx.Not(smt.member(term, positionLanguage(pattern))), ctx.Not(smt.member(term, incidentalLanguage(pattern))));
  };

  const member = (term: Seq, language: Re | undefined): Bool => (language === undefined ? never : smt.member(term, language));

  return {
    variable: (name) => smt.stringVariable(name),
    domain: (term) => smt.member(term, command),
    excludedBlock,
    position: (term, rule) => (rule.specifier === undefined ? ctx.Bool.val(true) : modelled(rule) ? member(term, positionLanguage(commandPatternOf(rule))) : never),
    incidental: (term, rule) => (rule.specifier === undefined || !wordsExpressible(rule) ? never : member(term, incidentalLanguage(commandPatternOf(rule)))),
    strict: (term, rule) => (rule.specifier === undefined ? ctx.Bool.val(true) : modelled(rule) ? member(term, strictLanguage(commandPatternOf(rule))) : never),
    optionGap,
    unmodelled: (rule) => rule.specifier !== undefined && !modelled(rule),
    wrapperDeny: (rule) => rule.specifier !== undefined && rule.effect === 'deny' && wordsExpressible(rule) && !modelled(rule),
    wordCount: (rule) => patternWords(commandPatternOf(rule)).length,
    candidates: (rule) => {
      const words = patternWords(commandPatternOf(rule));
      const own = words.join(' ');
      return [own, `${own} ${ARGUMENT_EXAMPLE}`, `${words[0] as string} ${SHELL_PAYLOAD_FLAG} ${PAYLOAD_EXAMPLE}`];
    },
  };
};
