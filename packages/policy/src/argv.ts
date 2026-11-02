import type { OptionDecl, CommandSpec } from './command-specs.ts';
import type { Word } from './shell.ts';

export type ParsedOption = { option: string; value?: string; dynamic?: true };

export type OptionStep = { next: number; options: ParsedOption[]; undeclared?: Word };

export type ParsedArgv = {
  options: ParsedOption[];
  operands: Word[];
  undeclared: Word[];
  separatorAt: number | undefined;
};

const COMMAND_TERMINATORS: ReadonlySet<string> = new Set([';', '+']);

const NUMERIC_OPTION = /^-\d+$/;

const withValue = (option: string, word: Word | undefined, attached: string | undefined): ParsedOption => {
  if (attached !== undefined) return { option, value: attached };
  if (word === undefined) return { option };
  return word.staticValue === null ? { option, value: word.value, dynamic: true } : { option, value: word.value };
};

const consume = (words: readonly Word[], at: number, decl: OptionDecl, attached: string | undefined): OptionStep => {
  const failed: OptionStep = { next: at + 1, options: [], undeclared: words[at] as Word };
  if (decl.takes === 'none') return attached === undefined ? { next: at + 1, options: [{ option: decl.name }] } : failed;
  if (decl.takes === 'attached') return { next: at + 1, options: [withValue(decl.name, undefined, attached)] };
  if (decl.takes === 'command') {
    let next = at + 1;
    while (next < words.length && !COMMAND_TERMINATORS.has((words[next] as Word).value)) next += 1;
    return { next: Math.min(next + 1, words.length), options: [{ option: decl.name }] };
  }
  if (attached !== undefined) return { next: at + 1, options: [withValue(decl.name, undefined, attached)] };
  const valueWord = words[at + 1];
  return valueWord === undefined ? failed : { next: at + 2, options: [withValue(decl.name, valueWord, undefined)] };
};

const withUndeclared = (step: OptionStep, undeclared: Word | undefined): OptionStep => (undeclared === undefined ? step : { ...step, undeclared });

const clusterStep = (words: readonly Word[], at: number, spec: CommandSpec): OptionStep => {
  const word = words[at] as Word;
  const parsed: ParsedOption[] = [];
  let undeclared: Word | undefined;
  for (let position = 1; position < word.value.length; position += 1) {
    const decl = spec.declOf(`-${word.value.charAt(position)}`);
    if (decl === undefined || decl.takes === 'command') {
      undeclared = word;
      continue;
    }
    if (decl.takes === 'none') {
      parsed.push({ option: decl.name });
      continue;
    }
    const rest = word.value.slice(position + 1);
    if (decl.takes === 'attached') return withUndeclared({ next: at + 1, options: [...parsed, withValue(decl.name, undefined, rest === '' ? undefined : rest)] }, undeclared);
    if (rest !== '') return withUndeclared({ next: at + 1, options: [...parsed, withValue(decl.name, undefined, rest)] }, undeclared);
    const valueWord = words[at + 1];
    if (valueWord === undefined) return { next: at + 1, options: parsed, undeclared: word };
    return withUndeclared({ next: at + 2, options: [...parsed, withValue(decl.name, valueWord, undefined)] }, undeclared);
  }
  return withUndeclared({ next: at + 1, options: parsed }, undeclared);
};

export const isOptionWord = (word: Word): boolean => word.literal && word.value.startsWith('-') && word.value !== '-' && word.value !== '--';

const uniqueAbbreviation = (spec: CommandSpec, name: string): OptionDecl | undefined => {
  const matches = spec.options.filter((option) => option.name.startsWith('--') && option.name.startsWith(name));
  return matches.length === 1 ? matches[0] : undefined;
};

export const parseOptionAt = (words: readonly Word[], at: number, spec: CommandSpec): OptionStep => {
  const word = words[at] as Word;
  const exact = spec.declOf(word.value);
  if (exact !== undefined) return consume(words, at, exact, undefined);
  if (spec.numericOptions === true && NUMERIC_OPTION.test(word.value)) return { next: at + 1, options: [{ option: word.value }] };
  if (word.value.startsWith('--')) {
    const equals = word.value.indexOf('=');
    const name = equals === -1 ? word.value : word.value.slice(0, equals);
    const decl = spec.declOf(name) ?? (spec.abbreviations === true ? uniqueAbbreviation(spec, name) : undefined);
    if (decl === undefined) return { next: at + 1, options: [], undeclared: word };
    return consume(words, at, decl, equals === -1 ? undefined : word.value.slice(equals + 1));
  }
  if (spec.noClusters === true) return { next: at + 1, options: [], undeclared: word };
  return clusterStep(words, at, spec);
};

export const parseArgv = (words: readonly Word[], spec: CommandSpec): ParsedArgv => {
  const parsed: ParsedArgv = { options: [], operands: [], undeclared: [], separatorAt: undefined };
  let index = 0;
  while (index < words.length) {
    const word = words[index] as Word;
    if (parsed.separatorAt === undefined && word.literal && word.value === '--') {
      parsed.separatorAt = parsed.operands.length;
      index += 1;
    } else if (parsed.separatorAt === undefined && isOptionWord(word)) {
      const step = parseOptionAt(words, index, spec);
      parsed.options.push(...step.options);
      if (step.undeclared !== undefined) parsed.undeclared.push(step.undeclared);
      index = step.next;
    } else {
      parsed.operands.push(word);
      index += 1;
    }
  }
  return parsed;
};

export const optionsNamed = (parsed: ParsedArgv, ...names: readonly string[]): ParsedOption[] => parsed.options.filter((entry) => names.includes(entry.option));

export const hasOption = (parsed: ParsedArgv, ...names: readonly string[]): boolean => parsed.options.some((entry) => names.includes(entry.option));
