import path from 'node:path';
import { isOptionWord, parseOptionAt } from './argv.ts';
import type { ParsedOption } from './argv.ts';
import type { CommandSpecs } from './command-specs.ts';
import type { CommandSpec } from './command-specs.ts';
import { ASSIGNMENT } from './shell-lexemes.ts';
import type { Word } from './shell.ts';
import { DYNAMIC, strongerEffect, targetOfOption, targetOfText } from './targets.ts';
import type { CwdEffect, Target } from './targets.ts';

export type WrapperUse = { name: string; word: Word; spec: CommandSpec; options: ParsedOption[]; stripped: boolean };

export type EffectiveCommand = {
  index: number;
  strictIndex: number;
  unanalyzable: boolean;
  payloads: Word[];
  wrappers: WrapperUse[];
  cwdEffect: CwdEffect;
  writes: Target[];
};

const payloadWord = (option: ParsedOption): Word => ({
  value: option.value ?? '',
  literal: option.dynamic !== true,
  plain: option.dynamic !== true,
  glob: null,
  staticValue: option.dynamic === true ? null : (option.value ?? ''),
});

const isStripped = (word: Word, spec: CommandSpec, options: readonly ParsedOption[], nextWord: Word | undefined): boolean => {
  const wrapper = spec.wrapper;
  if (word.value.includes('/')) return false;
  if (wrapper?.strip === 'always') return !options.some((entry) => wrapper.queryOptions?.includes(entry.option) === true);
  if (wrapper?.strip === 'bare') return options.length === 0 && nextWord !== undefined && !isOptionWord(nextWord);
  return false;
};

const recordOptionEffect = (found: EffectiveCommand, spec: CommandSpec, option: ParsedOption): void => {
  const effect = spec.effectOf(option.option);
  if (effect === 'payload') found.payloads.push(payloadWord(option));
  else if (effect === 'write') found.writes.push(targetOfOption(option));
  else if (effect === 'cwd') found.cwdEffect = strongerEffect(found.cwdEffect, 'changed');
  else if (effect === 'root') found.cwdEffect = strongerEffect(found.cwdEffect, 'root-changed');
};

export const locateEffectiveCommand = (words: Word[], specs: CommandSpecs): EffectiveCommand => {
  const found: EffectiveCommand = { index: -1, strictIndex: -1, unanalyzable: false, payloads: [], wrappers: [], cwdEffect: 'none', writes: [] };
  let stripping = true;
  let index = 0;
  const settleStrict = (at: number): void => {
    if (stripping) found.strictIndex = at;
    stripping = false;
  };
  for (;;) {
    while (index < words.length && ASSIGNMENT.test((words[index] as Word).value)) index += 1;
    const word = words[index];
    if (word === undefined) return found;
    const spec = word.literal ? specs.specOf(path.basename(word.value)) : undefined;
    const wrapper = spec?.wrapper;
    if (spec === undefined || wrapper === undefined) {
      settleStrict(index);
      found.index = index;
      return found;
    }

    const options: ParsedOption[] = [];
    let cursor = index + 1;
    let positionalsLeft = wrapper.positionals ?? 0;
    let optionsOpen = true;
    let dynamicOperand = false;
    for (;;) {
      const current = words[cursor];
      if (current === undefined) {
        settleStrict(index);
        return found;
      }
      if (optionsOpen && current.literal && current.value === '--') {
        optionsOpen = false;
        cursor += 1;
      } else if (current.literal && current.value === '-' && wrapper.assignments === true) {
        cursor += 1;
      } else if (optionsOpen && isOptionWord(current)) {
        const step = parseOptionAt(words, cursor, spec);
        if (step.undeclared !== undefined) {
          settleStrict(index);
          found.index = index;
          found.unanalyzable = true;
          return found;
        }
        options.push(...step.options);
        for (const option of step.options) recordOptionEffect(found, spec, option);
        cursor = step.next;
      } else if (wrapper.assignments === true && ASSIGNMENT.test(current.value)) {
        cursor += 1;
      } else if (positionalsLeft > 0) {
        positionalsLeft -= 1;
        if (current.staticValue === null) dynamicOperand = true;
        if (wrapper.positionalWrites === true) found.writes.push(current.staticValue === null ? DYNAMIC : targetOfText(current.staticValue));
        if (wrapper.positionalRoot === true) found.cwdEffect = strongerEffect(found.cwdEffect, 'root-changed');
        cursor += 1;
      } else {
        break;
      }
    }

    const dynamic = dynamicOperand || options.some((option) => option.dynamic === true);
    if (dynamic) found.unanalyzable = true;
    const stripped = !dynamic && isStripped(word, spec, options, words[cursor]);
    if (!stripped) settleStrict(index);
    found.wrappers.push({ name: path.basename(word.value), word, spec, options, stripped });
    index = cursor;
  }
};
