import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandSpecsFor } from '../src/platform-specs.ts';

const SOURCE_DIR = path.resolve(import.meta.dirname, '..', 'src');

const SPEC_TABLES = new Set(['command-specs.ts', 'bsd-specs.ts', 'gnu-specs.ts', 'platform-specs.ts', 'git-subcommands.ts', 'git-option-tables.ts']);

const PROGRAMS_THE_TABLE_MUST_DECLARE = ['printf'];

const PROGRAM_NAMES: ReadonlySet<string> = new Set([
  ...(['darwin', 'linux'] as const).flatMap((platform) => commandSpecsFor(platform).all.flatMap((spec) => [...spec.names])),
  ...PROGRAMS_THE_TABLE_MUST_DECLARE,
]);

const LONG_OPTION_WORDS: ReadonlySet<string> = new Set(
  (['darwin', 'linux'] as const).flatMap((platform) =>
    commandSpecsFor(platform).all.flatMap((spec) => spec.options.map((option) => option.name).filter((name) => name.startsWith('--')).map((name) => name.slice(2))),
  ),
);

const QUALIFIED_COMPARISON = /(?:\.value|\.name|\bprogram|\bprogramName)\s*(?:===|!==)\s*'([^']+)'|'([^']+)'\s*(?:===|!==)\s*(?:[\w.]*\.value|[\w.]*\.name|program|programName)\b/g;

const BARE_NAME_COMPARISON = /(?<![.\w])name\s*(?:===|!==)\s*'([^']+)'|'([^']+)'\s*(?:===|!==)\s*name\b/g;

const SET_OF_NAMES = /new Set\(\[([^\]]*)\]\)/g;

const stringsIn = (text: string): string[] => [...text.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);

const literalsOf = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((match) => (match[1] ?? match[2]) as string);

type Offender = { file: string; line: number; name: string };

const namesBranchedOn = (text: string): string[] => {
  if (/\bextractor\b/.test(text)) return [];
  const qualified = literalsOf(text, QUALIFIED_COMPARISON).filter((word) => PROGRAM_NAMES.has(word));
  const bare = literalsOf(text, BARE_NAME_COMPARISON).filter((word) => PROGRAM_NAMES.has(word) && !LONG_OPTION_WORDS.has(word));
  const sets = [...text.matchAll(SET_OF_NAMES)].map((match) => stringsIn(match[1] as string));
  const listed = sets.filter((members) => members.length > 0 && members.every((word) => PROGRAM_NAMES.has(word))).flat();
  return [...qualified, ...bare, ...listed];
};

const offendersIn = (file: string): Offender[] => {
  const lines = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8').split('\n');
  return lines.flatMap((text, index): Offender[] => namesBranchedOn(text).map((name) => ({ file, line: index + 1, name })));
};

const scannedFiles = (): string[] =>
  fs
    .readdirSync(SOURCE_DIR)
    .filter((file) => file.endsWith('.ts') && !SPEC_TABLES.has(file))
    .sort();

describe('no shared extractor or matcher of the policy compares a program name', () => {
  it('knows the program names of the spec tables, so the scan is not vacuous', () => {
    for (const name of ['echo', 'ln', 'install', 'cd', 'popd']) expect(PROGRAM_NAMES.has(name), name).toBe(true);
  });

  it('finds a program-name comparison when one is written, so the scan can fail', () => {
    const probe = [
      "if (name === 'ln') return;",
      "const printers = new Set(['echo', 'printf']);",
      "if (word.value !== 'cd') return null;",
      "if (spec.extractor === 'sed') return;",
      "if (name === 'file') scriptGiven = true;",
      "const EFFECTS = new Set(['write', 'exec']);",
    ];
    expect(probe.flatMap(namesBranchedOn)).toEqual(['ln', 'echo', 'printf', 'cd']);
  });

  it('leaves no program-name branch in command-match.ts and path-effects.ts', () => {
    expect([...offendersIn('command-match.ts'), ...offendersIn('path-effects.ts')]).toEqual([]);
  });

  it('leaves no program-name branch in any policy source outside the spec tables', () => {
    expect(scannedFiles().flatMap(offendersIn)).toEqual([]);
  });
});
