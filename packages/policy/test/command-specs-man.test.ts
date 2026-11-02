import { describe, expect, it } from 'vitest';
import { parseArgv } from '../src/argv.ts';
import { specOf } from '../src/command-specs.ts';
import { analyzeCommand, allWriteTargets } from '../src/shell.ts';
import type { Word } from '../src/shell.ts';

type Declaration = { program: string; option: string; effect: string; man: string };

const SYNOPSIS: Readonly<Record<string, string>> = {
  mkdir: 'mkdir [-pv] [-m mode] directory_name ...',
  rmdir: 'rmdir [-pv] directory ...',
  rm: 'rm [-f | -i] [-dIRrvWx] file ...',
  touch: 'touch [-A [-][[hh]mm]SS] [-achm] [-r file] [-t [[CC]YY]MMDDhhmm[.SS]] [-d YYYY-MM-DDThh:mm:SS[.frac][tz]] file ...',
  mv: 'mv [-f | -i | -n] [-hv] source target',
  cp: 'cp [-R [-H | -L | -P]] [-f | -i | -n] [-aclNpSsvXx] source_file target_file',
  sed: 'sed [-EHalnru] [-e command] [-f command_file] [-I extension] [-i extension] [file ...]',
  ls: 'ls [-@ABCFGHILOPRSTUWabcdefghiklmnopqrstuvwxy1%,] [--color=when] [-D format] [file ...]',
  grep: 'grep [-abcdDEFGHhIiJLlMmnOopqRSsUVvwXxZz] [-A num] [-B num] [-C num] [-e pattern] [-f file] [pattern] [file ...]',
  diff: 'diff [-r] [--no-dereference] [-L label] [-F pattern] [-I pattern] [-A algo] [--tabsize number] file1 file2',
  stat: 'stat [-FLnq] [-f format | -l | -r | -s | -x] [-t timefmt] [file ...]',
  du: 'du [--libxo] [-Aclnx] [-H | -L | -P] [-g | -h | -k | -m] [-a | -s | -d depth] [-B blocksize] [-I mask] [-t threshold] [file ...]',
  file: 'file [-bcdDhiIkLnNprsvz] [-f namefile] [-m magicfiles] [-P name=value] [-M magicfiles] file',
  ps: 'ps [-AaCcEefhjlMmrSTvwXx] [-O fmt | -o fmt] [-G gid[,gid...]] [-g grp[,grp...]] [-u uid[,uid...]] [-p pid[,pid...]] [-t tty[,tty...]] [-U user[,user...]]',
  sort: 'sort [-bcCdfghiRMmnrsuVz] [-k field1[,field2]] [-S memsize] [-T dir] [-t char] [-o output] [file ...]',
  find: 'find [-H | -L | -P] [-EXdsx] [-f path] path ... [expression]',
  git: 'git [-C <path>] [-c <name>=<value>] [--exec-path[=<path>]] [-p | --paginate | -P | --no-pager] [--git-dir=<path>] [--work-tree=<path>] [--namespace=<name>]',
  curl: 'curl [options / URLs]',
  zip: 'zip [-aABcdDeEfFghjklLmoqrRSTuvVwXyz!@$] [--longoption ...] [-b path] [-n suffixes] [-t date] [-tt date] [zipfile [file ...]] [-xi list]',
};

const declare = (program: string, effect: string, options: readonly string[], man = SYNOPSIS[program] ?? ''): Declaration[] =>
  options.map((option) => ({ program, option, effect, man }));

const DECLARATIONS: readonly Declaration[] = [
  ...declare('mkdir', 'flag', ['-p', '-v']),
  ...declare('mkdir', 'non-path', ['-m']),
  ...declare('rmdir', 'flag', ['-p', '-v']),
  ...declare('rm', 'flag', ['-f', '-i', '-d', '-I', '-R', '-r', '-v', '-W', '-x']),
  ...declare('touch', 'flag', ['-a', '-c', '-h', '-m']),
  ...declare('touch', 'non-path', ['-A', '-t', '-d']),
  ...declare('touch', 'read', ['-r']),
  ...declare('mv', 'flag', ['-f', '-i', '-n', '-h', '-v']),
  ...declare('cp', 'flag', ['-R', '-H', '-P', '-f', '-i', '-n', '-a', '-c', '-l', '-N', '-p', '-S', '-v', '-X', '-x']),
  ...declare('cp', 'symlink-create', ['-s'], 'man cp: -s Create symbolic links to regular files in a hierarchy instead of copying.'),
  ...declare('cp', 'follows-symlinks', ['-L'], 'man cp: -L If the -R option is specified, all symbolic links are followed.'),
  ...declare('sed', 'flag', ['-E', '-H', '-a', '-l', '-n', '-r', '-u']),
  ...declare('sed', 'payload', ['-e']),
  ...declare('sed', 'opens-path', ['-f']),
  ...declare('ls', 'follows-symlinks', ['-L'], 'man ls: -L Follow all symbolic links to final target and list the file or directory the link references'),
  ...declare('ls', 'flag', ['-R', '-H', '-l', '-a']),
  ...declare('ls', 'non-path', ['-D']),
  ...declare('grep', 'read', ['-f']),
  ...declare('grep', 'flag', ['-R', '-r', '-p', '-O', '-i', '-n', '-l']),
  ...declare('grep', 'non-path', ['-A', '-B', '-C', '-e']),
  ...declare('diff', 'non-path', ['-L', '-F', '-I', '-A', '--tabsize']),
  ...declare('diff', 'flag', ['--no-dereference']),
  ...declare('stat', 'non-path', ['-f', '-t']),
  ...declare('stat', 'follows-symlinks', ['-L'], 'man stat: -L Use stat(2) instead of lstat(2).'),
  ...declare('du', 'non-path', ['-d', '-B', '-I', '-t']),
  ...declare('du', 'follows-symlinks', ['-L'], 'man du: -L Symbolic links on the command line and in file hierarchies are followed.'),
  ...declare('du', 'flag', ['-H', '-P', '-a', '-s', '-h']),
  ...declare('file', 'opens-path', ['-f', '-m', '-M', '-C']),
  ...declare('ps', 'sensitive', ['-E'], 'man ps: -E Display the environment as well.'),
  ...declare('ps', 'flag', ['-e', '-A', '-f']),
  ...declare('sort', 'write', ['-o', '-T']),
  ...declare('sort', 'non-path', ['-k', '-S', '-t']),
  ...declare('sort', 'exec', ['--compress-program'], 'man sort line 198: --compress-program=PROGRAM'),
  ...declare('find', 'follows-symlinks', ['-L', '-follow'], 'man find: -L Cause the file information and file type evaluated for each symbolic link to be those of the file referenced by the link'),
  ...declare('find', 'flag', ['-H', '-P']),
  ...declare('find', 'read', ['-f'], 'man find: -f path Add path to the list of paths that will be recursed into.'),
  ...declare('find', 'delete', ['-delete'], 'man find: -delete Delete found files and/or directories.'),
  ...declare('find', 'exec', ['-exec', '-execdir', '-ok', '-okdir'], 'man find: -exec utility [argument ...] ;'),
  ...declare('find', 'exec', ['-fprint', '-fprint0', '-fprintf', '-fls', '-rm', '-files0-from'], 'disqualifier by name; not implemented by Darwin find'),
  ...declare('git', 'cwd', ['-C', '--git-dir', '--work-tree']),
  ...declare('git', 'exec', ['-c', '--config-env', '--exec-path']),
  ...declare('git', 'non-path', ['--namespace', '--super-prefix', '--attr-source']),
  ...declare('git', 'flag', ['-p', '--paginate', '-P', '--no-pager', '--no-optional-locks', '--bare']),
  ...declare('curl', 'write', ['-D'], 'man curl line 1240: -D, --dump-header <filename>'),
  ...declare('curl', 'write', ['-c'], 'man curl line 724: -c, --cookie-jar <filename>'),
  ...declare('curl', 'write', ['-o', '--output-dir', '--trace', '--trace-ascii', '--stderr', '--etag-save', '--libcurl']),
  ...declare('zip', 'write', ['-O'], 'man zip line 1108: -O output-file --output-file output-file'),
];

const EFFECT_BEARING: ReadonlyArray<readonly [string, string]> = [
  ['cp', '-s'],
  ['cp', '-L'],
  ['sed', '-f'],
  ['ls', '-L'],
  ['grep', '-f'],
  ['stat', '-L'],
  ['du', '-L'],
  ['file', '-f'],
  ['file', '-m'],
  ['file', '-M'],
  ['file', '-C'],
  ['ps', '-E'],
  ['sort', '-o'],
  ['sort', '-T'],
  ['sort', '--compress-program'],
  ['find', '-L'],
  ['find', '-follow'],
  ['find', '-delete'],
  ['find', '-exec'],
  ['find', '-execdir'],
  ['find', '-ok'],
  ['find', '-okdir'],
  ['git', '-C'],
  ['git', '--git-dir'],
  ['git', '--work-tree'],
  ['git', '-c'],
  ['git', '--config-env'],
  ['git', '--exec-path'],
  ['curl', '-D'],
  ['curl', '-c'],
  ['zip', '-O'],
];

const DARWIN_SED = '/usr/bin/sed';

const darwinTargets = (command: string) => {
  const analysis = analyzeCommand(command);
  return allWriteTargets(analysis as NonNullable<typeof analysis>, () => DARWIN_SED);
};

const wordsAfterProgram = (command: string): Word[] => {
  const [segment] = analyzeCommand(command)?.segments ?? [];
  if (segment === undefined) throw new Error(`no segment in ${command}`);
  return segment.words.slice(1);
};

describe('declared models against the Darwin man pages (5.2)', () => {
  it.each(DECLARATIONS.map((entry) => [entry.program, entry.option, entry.effect, entry.man] as const))('%s %s has effect %s (%s)', (program, option, effect) => {
    expect(specOf(program)?.effectOf(option)).toBe(effect);
  });

  it('lists every effect-bearing option of 3.5 in the fixture', () => {
    const missing = EFFECT_BEARING.filter(([program, option]) => !DECLARATIONS.some((entry) => entry.program === program && entry.option === option));
    expect(missing).toEqual([]);
  });

  it.each([
    ['cp', '-T'],
    ['mv', '-u'],
    ['sed', '--posix'],
    ['sed', '--sandbox'],
    ['sed', '-s'],
    ['sed', '-z'],
    ['sed', '--in-place'],
    ['wc', '--libxo'],
  ])('%s %s is undeclared', (program, option) => {
    expect(specOf(program)?.effectOf(option)).toBeUndefined();
  });
});

describe('Darwin parsing cases', () => {
  it("sed -i '' s/a/b/ f takes '' as the extension and writes f", () => {
    const parsed = parseArgv(wordsAfterProgram("sed -i '' s/a/b/ f"), specOf('sed') as NonNullable<ReturnType<typeof specOf>>);
    expect(parsed.options).toContainEqual({ option: '-i', value: '' });
    expect(parsed.operands.map((word) => word.value)).toEqual(['s/a/b/', 'f']);
    const analysis = analyzeCommand("sed -i '' s/a/b/ f");
    expect(allWriteTargets(analysis as NonNullable<typeof analysis>, () => DARWIN_SED)).toEqual([{ literal: 'f' }]);
  });

  it('sed -i -e s/a/b/ f takes -e as the extension', () => {
    const parsed = parseArgv(wordsAfterProgram('sed -i -e s/a/b/ f'), specOf('sed') as NonNullable<ReturnType<typeof specOf>>);
    expect(parsed.options).toContainEqual({ option: '-i', value: '-e' });
    expect(parsed.operands.map((word) => word.value)).toEqual(['s/a/b/', 'f']);
  });

  it('cp -S is a flag and consumes nothing', () => {
    const parsed = parseArgv(wordsAfterProgram('cp -S a b'), specOf('cp') as NonNullable<ReturnType<typeof specOf>>);
    expect(parsed.operands.map((word) => word.value)).toEqual(['a', 'b']);
  });

  it('mv -h is declared', () => {
    expect(specOf('mv')?.effectOf('-h')).toBe('flag');
  });
});

describe('Darwin sed backup targets', () => {
  it('sed -i -e s/a/b/ h writes h and the backup h-e', () => {
    const targets = darwinTargets('sed -i -e s/a/b/ h');
    expect(targets).toContainEqual({ literal: 'h' });
    expect(targets).toContainEqual({ literal: 'h-e' });
  });

  it('sed -i .bak s/a/b/ f writes f and f.bak', () => {
    const targets = darwinTargets('sed -i .bak s/a/b/ f');
    expect(targets).toContainEqual({ literal: 'f' });
    expect(targets).toContainEqual({ literal: 'f.bak' });
  });

  it.each(['sed -i $EXT s/a/b/ f', 'sed -i /x s/a/b/ f'])('%s gives a dynamic backup target', (command) => {
    expect(darwinTargets(command)).toContainEqual({ unresolvable: { kind: 'dynamic' } });
  });
});
