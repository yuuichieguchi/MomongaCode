import { describe, expect, it } from 'vitest';
import { parseGit } from '../src/git-argv.ts';
import { analyzeCommand, allWriteTargets } from '../src/shell.ts';
import type { Word } from '../src/shell.ts';

const argsOf = (command: string): Word[] => {
  const analysis = analyzeCommand(command);
  const [segment] = analysis?.segments ?? [];
  if (segment === undefined) throw new Error(`no segment in ${command}`);
  return segment.words.slice(1);
};

const parsed = (command: string) => {
  const result = parseGit(argsOf(command));
  return {
    subcommand: result.subcommand,
    rest: result.rest.map((word) => word.value),
    cwdChange: result.cwdChange,
    configOverride: result.configOverride,
    unknownOption: result.unknownOption,
    globals: result.globals.length,
  };
};

describe('parseGit', () => {
  it.each([
    ['git -C d status', { subcommand: 'status', rest: [], cwdChange: true, configOverride: false, unknownOption: false, globals: 1 }],
    ['git -c a=b -C d log', { subcommand: 'log', rest: [], cwdChange: true, configOverride: true, unknownOption: false, globals: 2 }],
    ['git --git-dir=d --work-tree=w status', { subcommand: 'status', rest: [], cwdChange: true, configOverride: false, unknownOption: false, globals: 2 }],
    ['git --namespace n log', { subcommand: 'log', rest: [], cwdChange: false, configOverride: false, unknownOption: false, globals: 1 }],
    ['git --super-prefix p log', { subcommand: 'log', rest: [], cwdChange: false, configOverride: false, unknownOption: false, globals: 1 }],
    ['git --attr-source s log -n 1', { subcommand: 'log', rest: ['-n', '1'], cwdChange: false, configOverride: false, unknownOption: false, globals: 1 }],
    ['git --paginate log', { subcommand: 'log', rest: [], cwdChange: false, configOverride: false, unknownOption: false, globals: 1 }],
    ['git --exec-path=x log', { subcommand: 'log', rest: [], cwdChange: false, configOverride: false, unknownOption: false, globals: 1 }],
    ['git --frobnicate log', { subcommand: undefined, rest: [], cwdChange: false, configOverride: false, unknownOption: true, globals: 0 }],
  ])('%s', (command, expected) => {
    const result = parsed(command);
    if (expected.unknownOption) {
      expect(result.unknownOption).toBe(true);
      return;
    }
    expect(result).toEqual(expected);
  });

  it('takes the subcommand after a valued global, so git --super-prefix p clone u d writes d', () => {
    expect(parsed('git --super-prefix p clone u d').subcommand).toBe('clone');
    const analysis = analyzeCommand('git --super-prefix p clone u d');
    expect(allWriteTargets(analysis as NonNullable<typeof analysis>)).toContainEqual({ literal: 'd' });
  });
});
