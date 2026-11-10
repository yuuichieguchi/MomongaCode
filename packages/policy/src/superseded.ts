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

export type CoveredProgram = { program: string; flagOptions: readonly string[]; valueOptions: readonly string[] };

const MAX_OPEN_OPTIONS = 6;

const optionNameOf = (word: string): string => (word.startsWith('--') && word.includes('=') ? word.slice(0, word.indexOf('=')) : word);

type Shape = { subcommands: string[][] };

const shapeOf = (segment: Segment, covered: CoveredProgram): Shape => {
  const words = segment.words.slice(segment.effectiveIndex + 1);
  let readings: string[][] = [[]];
  let open = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined) break;
    if (!word.literal) return { subcommands: readings };
    if (!word.value.startsWith('-')) {
      readings = readings.map((reading) => [...reading, word.value]);
      continue;
    }
    const name = optionNameOf(word.value);
    if (word.value.includes('=') && word.value.startsWith('--')) continue;
    const next = words[index + 1];
    if (covered.flagOptions.includes(name) || next === undefined || !next.literal || next.value.startsWith('-')) continue;
    if (covered.valueOptions.includes(name)) {
      index += 1;
      continue;
    }
    open += 1;
    if (open > MAX_OPEN_OPTIONS) return { subcommands: readings };
    readings = [...readings.map((reading) => [...reading, next.value]), ...readings];
    index += 1;
  }
  return { subcommands: readings };
};

const startsWithAll = (reading: readonly string[], prefix: readonly string[]): boolean => prefix.every((word, index) => reading[index] === word);

const coveredVerdict = (segment: Segment, covered: CoveredProgram, forms: readonly SupersededForm[]): SupersededVerdict => {
  const own = forms.filter((form) => form.argv[0] === covered.program);
  const shape = shapeOf(segment, covered);
  const matched = own.find((form) => shape.subcommands.some((reading) => startsWithAll(reading, form.argv.slice(1))));
  if (matched !== undefined) return { kind: 'superseded', form: matched };
  return { kind: 'undecided', form: own[0] ?? { operation: covered.program, argv: [covered.program] } };
};

const segmentVerdict = (segment: Segment, forms: readonly SupersededForm[], programs: readonly CoveredProgram[]): SupersededVerdict | undefined => {
  const program = segment.words[segment.effectiveIndex];
  if (program !== undefined && program.literal) {
    const covered = programs.find((candidate) => candidate.program === path.basename(program.value));
    if (covered !== undefined) return coveredVerdict(segment, covered, forms);
  }
  let undecided: SupersededForm | undefined;
  for (const form of forms) {
    const reading = readingOf(segment, form);
    if (reading === 'superseded') return { kind: 'superseded', form };
    if (reading === 'undecided') undecided ??= form;
  }
  return undecided === undefined ? undefined : { kind: 'undecided', form: undecided };
};

const analysisVerdict = (analysis: Analysis, forms: readonly SupersededForm[], programs: readonly CoveredProgram[]): SupersededVerdict | undefined => {
  const verdicts = [...analysis.segments.map((segment) => segmentVerdict(segment, forms, programs)), ...analysis.nested.map((inner) => analysisVerdict(inner, forms, programs))];
  return verdicts.find((verdict) => verdict?.kind === 'superseded') ?? verdicts.find((verdict) => verdict !== undefined);
};

export const supersededVerdictOf = (command: string, forms: readonly SupersededForm[], specs?: CommandSpecs, programs: readonly CoveredProgram[] = []): SupersededVerdict | undefined => {
  if (forms.length === 0 && programs.length === 0) return undefined;
  const analysis = analyzeCommand(command, specs);
  const first = forms[0];
  if (analysis === null) return first === undefined ? undefined : { kind: 'undecided', form: first };
  return analysisVerdict(analysis, forms, programs);
};

export const supersededFormOf = (command: string, forms: readonly SupersededForm[], specs?: CommandSpecs): SupersededForm | undefined => {
  const verdict = supersededVerdictOf(command, forms, specs);
  return verdict?.kind === 'superseded' ? verdict.form : undefined;
};
