import { describe, expect, it } from 'vitest';
import { parseRule } from '@momonga/config';
import * as policy from '@momonga/policy';
import type { CommandSpecs } from '@momonga/policy';
import { commandMatchStrength } from '../src/command-match.ts';
import { commandSpecsFor } from '../src/platform-specs.ts';
import { allReadTargets, allWriteTargets, analyzeCommand } from '../src/shell.ts';

const PLATFORMS = ['darwin', 'linux'] as const;

type Effects = { writes: unknown[]; reads: unknown[] };

const DYNAMIC = { unresolvable: { kind: 'dynamic' } };
const literal = (value: string) => ({ literal: value });

const OLD_INERT_PRINTERS: ReadonlySet<string> = new Set(['echo', 'printf']);

const inertPrinterSet = (specs: CommandSpecs): ReadonlySet<string> => {
  const derive = (policy as unknown as { inertPrinterSet?: (table: CommandSpecs) => ReadonlySet<string> }).inertPrinterSet;
  if (derive === undefined) throw new Error('@momonga/policy does not export inertPrinterSet');
  return derive(specs);
};

const oldCopyLike = (program: 'ln' | 'install', operands: readonly string[], targetDirectories: readonly string[], makesDirectories: boolean): Effects => {
  if (program === 'install' && makesDirectories) return { writes: operands.map(literal), reads: [] };
  if (targetDirectories.length > 0) return { writes: targetDirectories.map(literal), reads: program === 'ln' ? [] : operands.map(literal) };
  const reads = program === 'ln' ? [] : operands.slice(0, -1).map(literal);
  if (operands.length === 1 && program === 'ln') return { writes: [DYNAMIC], reads };
  const destination = operands.at(-1);
  return { writes: destination === undefined ? [] : [literal(destination)], reads };
};

const oldCdEffects = (program: 'cd' | 'pushd' | 'popd', operands: readonly string[]): Effects => {
  const [operand] = operands;
  if (program === 'popd') return { writes: [], reads: [] };
  if (operand === undefined) return { writes: [], reads: program === 'cd' ? [literal('~')] : [] };
  return { writes: [], reads: [operand === '-' ? DYNAMIC : literal(operand)] };
};

const subsets = <T,>(items: readonly T[]): T[][] => items.reduce<T[][]>((all, item) => [...all, ...all.map((subset) => [...subset, item])], [[]]);

const OPERAND_LISTS: readonly (readonly string[])[] = [[], ['a'], ['a', 'b'], ['a', 'b', 'c']];

type Row = { command: string; expected: Effects };

const copyRows = (program: 'ln' | 'install', flags: readonly string[]): Row[] =>
  subsets(flags).flatMap((chosen) =>
    [[], ['dir']].flatMap((targets) =>
      OPERAND_LISTS.filter((operands) => operands.length > 0 || targets.length > 0).map((operands) => ({
        command: [program, ...chosen, ...targets.flatMap((target) => ['-t', target]), ...operands].join(' '),
        expected: oldCopyLike(program, operands, targets, chosen.includes('-d')),
      })),
    ),
  );

const cdRows: Row[] = (['cd', 'pushd', 'popd'] as const).flatMap((program) =>
  [[], ['src'], ['-'], ['+1']]
    .filter((operands) => !(program === 'cd' && operands[0] === '+1'))
    .map((operands) => ({ command: [program, ...operands].join(' '), expected: oldCdEffects(program, operands) })),
);

const CORPUS: readonly Row[] = [
  ...copyRows('ln', ['-s', '-f', '-n']),
  ...copyRows('install', ['-d', '-v', '-p']),
  { command: 'install -m 644 a b', expected: oldCopyLike('install', ['a', 'b'], [], false) },
  { command: 'ln -s ../x .git/hooks/h', expected: oldCopyLike('ln', ['../x', '.git/hooks/h'], [], false) },
  ...cdRows,
];

const effectsOf = (platform: (typeof PLATFORMS)[number], command: string): Effects => {
  const analysis = analyzeCommand(command, commandSpecsFor(platform));
  if (analysis === null) throw new Error(`${command} is not analysable`);
  return { writes: allWriteTargets(analysis), reads: allReadTargets(analysis) };
};

const rmDeny = parseRule('Bash(rm:*)', { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: '/p', home: '/h', cwd: '/p' });

const PRINTER_CORPUS = ['echo rm -rf /', 'printf rm -rf /', '/bin/echo rm x', '/usr/bin/printf %s rm', 'printf rm x; rm y', 'echo x | rm y', 'rm -rf /'];

const oldStrength = (command: string): string | null => {
  const segments = command.split(/;|\|/).map((segment) => segment.trim().split(/\s+/));
  const strengths = segments.map((words) => {
    if (words[0]?.split('/').at(-1) === 'rm') return 'position';
    if (OLD_INERT_PRINTERS.has(words[0]?.split('/').at(-1) ?? '')) return null;
    return words.includes('rm') ? 'incidental' : null;
  });
  return strengths.includes('position') ? 'position' : strengths.includes('incidental') ? 'incidental' : null;
};

describe.each(PLATFORMS)('the copy and directory effects on %s are those of the old name branches', (platform) => {
  it('covers ln, install, cd, pushd and popd with generated option and operand combinations', () => {
    expect(CORPUS.length).toBeGreaterThan(60);
  });

  it.each(CORPUS.map((row) => [row.command, row.expected] as const))('%s', (command, expected) => {
    expect(effectsOf(platform, command)).toEqual(expected);
  });

  it('derives the same inert printers from the table as the old hard-coded set', () => {
    expect([...inertPrinterSet(commandSpecsFor(platform))].sort()).toEqual([...OLD_INERT_PRINTERS].sort());
  });

  it.each(PRINTER_CORPUS)('matches %s against Bash(rm:*) with the strength of the old printer exemption', (command) => {
    expect(commandMatchStrength(rmDeny, command)).toBe(oldStrength(command));
  });
});
