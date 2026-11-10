import path from 'node:path';
import type { CommandSpecs } from './command-specs.ts';
import { analyzeCommand } from './shell.ts';
import type { Analysis, Segment } from './shell.ts';

export type SupersededForm = { operation: string; argv: readonly string[] };

export type SupersededVerdict = { kind: 'superseded'; form: SupersededForm } | { kind: 'undecided'; form: SupersededForm };

type Reading = 'superseded' | 'undecided' | 'other';

const readingOf = (segment: Segment, form: SupersededForm): Reading => {
  const words = segment.words.slice(segment.effectiveIndex);
  const program = words[0];
  if (program === undefined) return 'other';
  if (!program.literal) return 'undecided';
  if (path.basename(program.value) !== form.argv[0]) return 'other';
  let matched = 1;
  let previousWasOption = false;
  for (const word of words.slice(1)) {
    if (matched === form.argv.length) return 'superseded';
    if (!word.literal) return 'undecided';
    if (word.value.startsWith('-')) {
      previousWasOption = !word.value.includes('=');
      continue;
    }
    if (word.value === form.argv[matched]) matched += 1;
    else if (!previousWasOption) return 'other';
    previousWasOption = false;
  }
  return matched === form.argv.length ? 'superseded' : 'other';
};

const segmentVerdict = (segment: Segment, forms: readonly SupersededForm[]): SupersededVerdict | undefined => {
  let undecided: SupersededForm | undefined;
  for (const form of forms) {
    const reading = readingOf(segment, form);
    if (reading === 'superseded') return { kind: 'superseded', form };
    if (reading === 'undecided') undecided ??= form;
  }
  return undecided === undefined ? undefined : { kind: 'undecided', form: undecided };
};

const analysisVerdict = (analysis: Analysis, forms: readonly SupersededForm[]): SupersededVerdict | undefined => {
  const verdicts = [...analysis.segments.map((segment) => segmentVerdict(segment, forms)), ...analysis.nested.map((inner) => analysisVerdict(inner, forms))];
  return verdicts.find((verdict) => verdict?.kind === 'superseded') ?? verdicts.find((verdict) => verdict !== undefined);
};

export const supersededVerdictOf = (command: string, forms: readonly SupersededForm[], specs?: CommandSpecs): SupersededVerdict | undefined => {
  if (forms.length === 0) return undefined;
  const analysis = analyzeCommand(command, specs);
  const first = forms[0];
  if (analysis === null) return first === undefined ? undefined : { kind: 'undecided', form: first };
  return analysisVerdict(analysis, forms);
};

export const supersededFormOf = (command: string, forms: readonly SupersededForm[], specs?: CommandSpecs): SupersededForm | undefined => {
  const verdict = supersededVerdictOf(command, forms, specs);
  return verdict?.kind === 'superseded' ? verdict.form : undefined;
};
