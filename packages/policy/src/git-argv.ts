import { isOptionWord, parseOptionAt } from './argv.ts';
import type { ParsedOption } from './argv.ts';
import { specOf } from './command-specs.ts';
import type { CommandSpec } from './command-specs.ts';
import type { Word } from './shell.ts';

export type GitParse = {
  globals: ParsedOption[];
  subcommand: string | undefined;
  rest: Word[];
  cwdChange: boolean;
  configOverride: boolean;
  unknownOption: boolean;
};

const CONFIG_OVERRIDE_OPTIONS: readonly string[] = ['-c', '--config-env'];

export const parseGit = (args: readonly Word[]): GitParse => {
  const spec = specOf('git') as CommandSpec;
  const globals: ParsedOption[] = [];
  let index = 0;
  while (index < args.length && isOptionWord(args[index] as Word)) {
    const step = parseOptionAt(args, index, spec);
    if (step.undeclared !== undefined) return { globals, subcommand: undefined, rest: [], cwdChange: false, configOverride: false, unknownOption: true };
    globals.push(...step.options);
    index = step.next;
  }
  const subcommandWord = args[index];
  const subcommand = subcommandWord !== undefined && subcommandWord.literal ? subcommandWord.value : undefined;
  return {
    globals,
    subcommand,
    rest: args.slice(index + 1),
    cwdChange: globals.some((entry) => spec.effectOf(entry.option) === 'cwd'),
    configOverride: globals.some((entry) => CONFIG_OVERRIDE_OPTIONS.includes(entry.option)),
    unknownOption: false,
  };
};
