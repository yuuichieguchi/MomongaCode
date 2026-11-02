import { define } from './command-specs.ts';
import type { CommandSpec, OptionDecl, OptionEffect } from './command-specs.ts';
import type { Word } from './shell.ts';
import { GIT_OPTION_TABLES } from './git-option-tables.ts';

const EXEC_OPTIONS: ReadonlySet<string> = new Set(['--ext-diff', '--textconv', '--exec', '--extcmd', '--upload-pack', '--receive-pack', '--config', '--template', '-O', '--open-files-in-pager', '--filters']);
const SIGNATURE_VERIFYING_SUBCOMMANDS: ReadonlySet<string> = new Set(['log', 'show', 'reflog']);
const SIGNATURE_OPTION = '--show-signature';
const FORMAT_OPTIONS: readonly string[] = ['--format', '--pretty'];
const SORT_OPTION = '--sort';
const GROUP_OPTION = '--group';
const GROUP_FORMAT_PREFIX = 'format:';
const PRETTY_SIGNATURE = /%[-+ ]?G/;
const REF_FILTER_SIGNATURE = /%\((\*|\^\{\})?signature/;
const SORT_SIGNATURE = /^-?\*?signature/;

export const optionVerifiesSignature = (option: string, value: string | undefined): boolean => {
  if (value === undefined) return false;
  if (FORMAT_OPTIONS.includes(option)) return PRETTY_SIGNATURE.test(value) || REF_FILTER_SIGNATURE.test(value);
  if (option === SORT_OPTION) return SORT_SIGNATURE.test(value);
  return option === GROUP_OPTION && value.startsWith(GROUP_FORMAT_PREFIX) && PRETTY_SIGNATURE.test(value);
};
const WRITE_OPTIONS: ReadonlySet<string> = new Set(['--output']);
const READ_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  blame: ['--contents', '--ignore-revs-file', '-S'],
  grep: ['-f'],
  'ls-files': ['-X', '--exclude-from'],
  'rev-parse': ['--resolve-git-dir'],
};
const TABLE_ALIASES: Readonly<Record<string, string>> = { reflog: 'log' };
const ABBREVIATED: ReadonlySet<string> = new Set(['reset', 'clean', 'checkout', 'switch']);
const NUMERIC: ReadonlySet<string> = new Set(['log', 'show', 'rev-list', 'shortlog', 'grep', 'reflog']);

const valued = (effect: OptionEffect, names: readonly string[]): OptionDecl[] => names.map((name) => ({ name, takes: 'value', effect }));

const OTHER_OPTIONS: Readonly<Record<string, readonly OptionDecl[]>> = {
  clone: [
    ...['-b', '--branch', '-o', '--origin', '--depth', '--reference', '--template', '-c', '--config', '-j', '--jobs', '--filter', '--upload-pack', '-u', '--shallow-since', '--shallow-exclude', '--server-option'].map((name): OptionDecl => ({ name, takes: 'value', effect: 'non-path' })),
    { name: '--separate-git-dir', takes: 'value', effect: 'write' },
  ],
  worktree: valued('non-path', ['-b', '-B', '--reason']),
  archive: [...valued('non-path', ['--format', '--prefix', '--remote', '--exec']), ...valued('write', ['-o', '--output'])],
  'format-patch': valued('write', ['-o', '--output-directory']),
  init: valued('non-path', ['--template']),
};

const effectOf = (subcommand: string, name: string, takes: OptionDecl['takes']): OptionEffect => {
  if (EXEC_OPTIONS.has(name)) return 'exec';
  if (name === SIGNATURE_OPTION && SIGNATURE_VERIFYING_SUBCOMMANDS.has(subcommand)) return 'exec';
  if (WRITE_OPTIONS.has(name)) return 'write';
  if (READ_OPTIONS[subcommand]?.includes(name) === true) return 'read';
  return takes === 'none' ? 'flag' : 'non-path';
};

const tableOptions = (subcommand: string): OptionDecl[] | undefined => {
  const table = GIT_OPTION_TABLES[TABLE_ALIASES[subcommand] ?? subcommand];
  if (table === undefined) return undefined;
  const of = (names: readonly string[], takes: OptionDecl['takes']): OptionDecl[] => names.map((name) => ({ name, takes, effect: effectOf(subcommand, name, takes) }));
  return [...of(table.flags, 'none'), ...of(table.values, 'value'), ...of(table.optionalValues, 'attached')];
};

const specs = new Map<string, CommandSpec>();

export const gitSubcommandSpec = (subcommand: string): CommandSpec => {
  const known = specs.get(subcommand);
  if (known !== undefined) return known;
  const fromTable = tableOptions(subcommand);
  const spec = define({
    names: [subcommand],
    options: fromTable ?? OTHER_OPTIONS[subcommand] ?? [],
    ...(ABBREVIATED.has(subcommand) ? { abbreviations: true as const } : {}),
    ...(NUMERIC.has(subcommand) ? { numericOptions: true as const } : {}),
  });
  specs.set(subcommand, spec);
  return spec;
};

export const GIT_READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'shortlog', 'grep', 'cat-file', 'show-ref', 'name-rev', 'merge-base', 'for-each-ref', 'count-objects', 'check-ignore', 'reflog',
]);

const REFLOG_READ_FORMS = ['show', 'list', 'exists'] as const;

export type ReflogView = { subcommand: (typeof REFLOG_READ_FORMS)[number] | undefined; words: Word[] };

const readFormOf = (word: Word): (typeof REFLOG_READ_FORMS)[number] | undefined =>
  word.literal ? REFLOG_READ_FORMS.find((form) => form === word.value) : undefined;

export const reflogView = (rest: readonly Word[]): ReflogView => {
  const [head, ...tail] = rest;
  if (head === undefined) return { subcommand: 'show', words: [] };
  const form = readFormOf(head);
  if (form !== undefined) return { subcommand: form, words: tail };
  if (head.literal && head.value.startsWith('-')) return { subcommand: 'show', words: [...rest] };
  return { subcommand: undefined, words: [...rest] };
};

const LISTING_SELECTORS = ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
const LISTING_VALUES = [...LISTING_SELECTORS, '--sort', '--format'];
const listingFlags = (...names: string[]): OptionDecl[] => names.map((name) => ({ name, takes: 'none', effect: 'flag' }));
const listingValues = (names: readonly string[]): OptionDecl[] => names.map((name) => ({ name, takes: 'value', effect: 'non-path' }));
const listingOptionalValues = (names: readonly string[]): OptionDecl[] => names.map((name) => ({ name, takes: 'attached', effect: 'non-path' }));

export const GIT_LISTING_SELECTORS: Readonly<Record<'branch' | 'tag', readonly string[]>> = {
  branch: ['-l', '--list', '--show-current', ...LISTING_SELECTORS],
  tag: ['-l', '--list', '-n', ...LISTING_SELECTORS],
};

export const GIT_LISTING_SPECS: Readonly<Record<'branch' | 'tag' | 'remote', CommandSpec>> = {
  branch: define({
    names: ['branch'],
    options: [
      ...listingFlags('-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '--verbose', '--show-current', '-i', '--ignore-case', '--no-column', '--no-color', '--no-abbrev'),
      ...listingOptionalValues(['--abbrev', '--color', '--column']),
      ...listingValues(LISTING_VALUES),
    ],
  }),
  tag: define({
    names: ['tag'],
    options: [
      ...listingFlags('-l', '--list', '-i', '--ignore-case', '--no-column', '--no-color'),
      ...listingOptionalValues(['-n', '--color', '--column']),
      ...listingValues(LISTING_VALUES),
    ],
  }),
  remote: define({ names: ['remote'], options: listingFlags('-n', '-v', '--verbose', '--push', '--all') }),
};
