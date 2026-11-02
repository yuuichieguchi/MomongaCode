import { define } from './command-specs.ts';
import type { CommandSpec, OptionDecl, OptionEffect } from './command-specs.ts';
import { GIT_OPTION_TABLES } from './git-option-tables.ts';

const EXEC_OPTIONS: ReadonlySet<string> = new Set(['--ext-diff', '--textconv', '--exec', '--extcmd', '--upload-pack', '--receive-pack', '--config', '--template', '-O', '--open-files-in-pager', '--filters']);
const WRITE_OPTIONS: ReadonlySet<string> = new Set(['--output']);
const READ_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  blame: ['--contents', '--ignore-revs-file', '-S'],
  grep: ['-f'],
  'ls-files': ['-X', '--exclude-from'],
  'rev-parse': ['--resolve-git-dir'],
};
const ABBREVIATED: ReadonlySet<string> = new Set(['reset', 'clean', 'checkout', 'switch']);
const NUMERIC: ReadonlySet<string> = new Set(['log', 'show', 'rev-list', 'shortlog', 'grep']);

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
  if (WRITE_OPTIONS.has(name)) return 'write';
  if (READ_OPTIONS[subcommand]?.includes(name) === true) return 'read';
  return takes === 'none' ? 'flag' : 'non-path';
};

const tableOptions = (subcommand: string): OptionDecl[] | undefined => {
  const table = GIT_OPTION_TABLES[subcommand];
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
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'shortlog', 'grep', 'cat-file', 'show-ref', 'name-rev', 'merge-base', 'for-each-ref', 'count-objects', 'check-ignore',
]);
