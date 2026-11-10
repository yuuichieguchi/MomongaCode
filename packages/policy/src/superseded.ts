import path from 'node:path';
import type { CommandSpecs } from './command-specs.ts';
import { analyzeCommand } from './shell.ts';
import type { Analysis, Segment } from './shell.ts';

export type SupersededForm = { operation: string; argv: readonly string[] };

type Positional = { value: string; followsOption: boolean };

const positionalWords = (segment: Segment): Positional[] | undefined => {
  const words = segment.words.slice(segment.effectiveIndex);
  const positional: Positional[] = [];
  let previousWasOption = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || !word.literal) return undefined;
    if (index === 0) {
      positional.push({ value: path.basename(word.value), followsOption: false });
    } else if (word.value.startsWith('-')) {
      previousWasOption = !word.value.includes('=');
      continue;
    } else {
      positional.push({ value: word.value, followsOption: previousWasOption });
    }
    previousWasOption = false;
  }
  return positional;
};

const matchesForm = (positional: readonly Positional[], form: SupersededForm): boolean => {
  if (positional[0]?.value !== form.argv[0]) return false;
  let matched = 1;
  for (const word of positional.slice(1)) {
    if (matched === form.argv.length) return true;
    if (word.value === form.argv[matched]) matched += 1;
    else if (!word.followsOption) return false;
  }
  return matched === form.argv.length;
};

const segmentForm = (segment: Segment, forms: readonly SupersededForm[]): SupersededForm | undefined => {
  const positional = positionalWords(segment);
  if (positional === undefined) return undefined;
  return forms.find((form) => matchesForm(positional, form));
};

const analysisForm = (analysis: Analysis, forms: readonly SupersededForm[]): SupersededForm | undefined => {
  for (const segment of analysis.segments) {
    const found = segmentForm(segment, forms);
    if (found !== undefined) return found;
  }
  for (const inner of analysis.nested) {
    const found = analysisForm(inner, forms);
    if (found !== undefined) return found;
  }
  return undefined;
};

export const supersededFormOf = (command: string, forms: readonly SupersededForm[], specs?: CommandSpecs): SupersededForm | undefined => {
  const analysis = analyzeCommand(command, specs);
  return analysis === null ? undefined : analysisForm(analysis, forms);
};
