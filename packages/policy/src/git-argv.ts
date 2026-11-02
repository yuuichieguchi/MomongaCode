import { isOptionWord, parseOptionAt } from './argv.ts';
import type { ParsedOption } from './argv.ts';
import type { CommandSpec, CommandSpecs } from './command-specs.ts';
import type { Word } from './shell.ts';

export type GitParse = {
  globals: ParsedOption[];
  subcommand: string | undefined;
  rest: Word[];
  cwdChange: boolean;
  configOverride: boolean;
  unknownOption: boolean;
  optionLikeValue: boolean;
};

const CONFIG_OVERRIDE_OPTIONS: readonly string[] = ['-c', '--config-env'];

export const parseGit = (args: readonly Word[], specs: CommandSpecs): GitParse => {
  const spec = specs.specOf('git') as CommandSpec;
  const globals: ParsedOption[] = [];
  let optionLikeValue = false;
  let index = 0;
  while (index < args.length && isOptionWord(args[index] as Word)) {
    const step = parseOptionAt(args, index, spec);
    if (step.undeclared !== undefined) return { globals, subcommand: undefined, rest: [], cwdChange: false, configOverride: false, unknownOption: true, optionLikeValue };
    globals.push(...step.options);
    if (step.optionLikeValue === true) optionLikeValue = true;
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
    optionLikeValue,
  };
};
