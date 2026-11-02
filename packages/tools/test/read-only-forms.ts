import { GIT_OPTION_TABLES, commandSpecsFor } from '@momonga/policy';
import type { CommandSpecs } from '@momonga/policy';

type Spec = CommandSpecs['all'][number];
type Option = Spec['options'][number];

const DISQUALIFYING: ReadonlySet<string> = new Set(['write', 'exec', 'opens-path', 'sensitive', 'cwd', 'root', 'delete', 'symlink-create', 'follows-symlinks']);

const STATUS_ONLY: readonly RegExp[] = [/^time /, /^sort (-R|--random-sort)( |$)/, /^file (-D|--debug)( |$)/, /^git rev-parse --(before|after|since|until)=/];

export const outputDiffersByNature = (command: string): boolean => STATUS_ONLY.some((pattern) => pattern.test(command));

const NEVER_EXITS: ReadonlySet<string> = new Set(['tail -f', 'tail -F', 'tail --follow', 'tail --retry']);

const GIT_READ_FORMS: Readonly<Record<string, { before: string; after: string }>> = {
  status: { before: '', after: '' },
  log: { before: '-1', after: '' },
  diff: { before: '', after: '' },
  show: { before: '', after: 'HEAD' },
  blame: { before: '', after: 'stable' },
  'ls-files': { before: '', after: '' },
  'ls-tree': { before: '', after: 'HEAD' },
  'rev-parse': { before: '', after: 'HEAD' },
  'rev-list': { before: '', after: 'HEAD' },
  describe: { before: '--always', after: '' },
  shortlog: { before: '', after: 'HEAD' },
  grep: { before: '', after: 'one' },
  'cat-file': { before: '-t', after: 'HEAD' },
  'show-ref': { before: '', after: '' },
  'name-rev': { before: '', after: 'HEAD' },
  'merge-base': { before: '', after: 'HEAD HEAD' },
  'for-each-ref': { before: '', after: '' },
  'count-objects': { before: '', after: '' },
  'check-ignore': { before: '', after: 'tracked' },
};

const GIT_NOT_APPROVABLE: Readonly<Record<string, readonly string[]>> = {
  '*': ['--ext-diff', '--textconv', '--output', '-O', '--open-files-in-pager', '--filters'],
  log: ['--show-signature'],
  show: ['--show-signature'],
  blame: ['--contents', '--ignore-revs-file', '-S'],
  grep: ['-f'],
  'ls-files': ['-X', '--exclude-from'],
  'rev-parse': ['--resolve-git-dir'],
};

const SEQUENCES: readonly string[] = [
  'echo hi',
  'pwd',
  'pwd -P',
  'which ls',
  'cd sub',
  'cd sub && ls',
  'ls; pwd',
  'cat tracked | wc -l',
  'ls 2>/dev/null',
  'time ls',
  'nice ls',
  'sed -n 1p tracked',
  'ls *',
  'git status',
  'git status --porcelain=v2',
  'git diff',
  'git diff --stat',
  'git log -1',
  'git branch',
  'git branch -a',
  'git branch -vv',
  'git branch --show-current',
  'git branch --contains HEAD',
  'git tag',
  'git tag -l',
  'git tag -n1',
  'git remote',
  'git remote -v',
  'git reflog',
  'git reflog show HEAD',
  'git reflog list',
  'git reflog exists HEAD',
  'git reflog --oneline -n 1',
];

const OPERANDS: Readonly<Record<string, string>> = {
  'read-all': 'tracked',
  'pattern-first': 'one tracked',
  none: '',
};

const valueFor = (option: Option): string => (option.effect === 'read' ? 'tracked' : '1');

const wordsFor = (option: Option): string => {
  if (option.takes === 'value') return `${option.name} ${valueFor(option)}`;
  if (option.takes === 'attached') return option.name.startsWith('--') ? `${option.name}=${valueFor(option)}` : `${option.name}${valueFor(option)}`;
  return option.name;
};

const join = (...parts: readonly string[]): string => parts.filter((part) => part !== '').join(' ');

const shellQuoted = (word: string): string => (/[!()]/.test(word) ? `'${word}'` : word);

const plainForms = (spec: Spec): string[] => {
  const operand = OPERANDS[spec.operands];
  if (operand === undefined || spec.approval !== 'read-only' || spec.extractor === 'git' || spec.extractor === 'cd') return [];
  const name = spec.names[0] as string;
  return [
    join(name, operand),
    ...spec.options
      .filter((option) => !DISQUALIFYING.has(option.effect) && !NEVER_EXITS.has(`${name} ${option.name}`) && option.applies === undefined)
      .map((option) => join(name, wordsFor({ ...option, name: shellQuoted(option.name) }), operand)),
  ];
};

const gitForms = (subcommand: string, form: { before: string; after: string }): string[] => {
  const table = GIT_OPTION_TABLES[subcommand];
  if (table === undefined) return [];
  const excluded = [...(GIT_NOT_APPROVABLE['*'] ?? []), ...(GIT_NOT_APPROVABLE[subcommand] ?? [])];
  const options: Option[] = [
    ...table.flags.map((name): Option => ({ name, takes: 'none', effect: 'flag' })),
    ...table.values.map((name): Option => ({ name, takes: 'value', effect: 'non-path' })),
    ...table.optionalValues.map((name): Option => ({ name, takes: 'attached', effect: 'non-path' })),
  ];
  return options.filter((option) => !excluded.includes(option.name)).map((option) => join('git', subcommand, form.before, wordsFor(option), form.after));
};

export const approvableForms = (platform: NodeJS.Platform): string[] => [
  ...new Set([
    ...SEQUENCES,
    ...commandSpecsFor(platform).all.flatMap(plainForms),
    ...Object.entries(GIT_READ_FORMS).flatMap(([subcommand, form]) => gitForms(subcommand, form)),
  ]),
];
