import { COPY_TARGET_OPTIONS, define, flag, letters, marked, optionalValue, valued, when } from './command-specs.ts';
import type { CommandSpec, OptionDecl } from './command-specs.ts';
import { decl } from './command-specs.ts';

const GREP_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('abcEFGHhIiJLlMnOopqRrsUVvwXxZz')),
  ...flag('--recursive', '--line-buffered', '--null', '--ignore-case', '--invert-match', '--word-regexp', '--line-regexp', '--count', '--files-with-matches', '--files-without-match', '--line-number', '--no-messages', '--quiet', '--silent', '--with-filename', '--no-filename', '--only-matching', '--extended-regexp', '--fixed-strings', '--basic-regexp', '--perl-regexp', '--text', '--binary', '--null-data', '--initial-tab', '--no-group-separator'),
  ...valued('non-path', ...letters('ABCdDm'), '-e', '--regexp', '--binary-files', '--label', '--max-count', '--after-context', '--before-context', '--directories', '--devices', '--include', '--exclude', '--include-dir', '--exclude-dir'),
  ...valued('read', '-f', '--file'),
  ...optionalValue('non-path', '--color', '--colour', '--context'),
  ...when({ any: ['-R', '-r', '--recursive', '-d=recurse', '--directories=recurse'] }, marked('follows-symlinks', '-S')),
];

const DIFF_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('aBbcdEefilNnpqsTtuwy'), '--brief', '--ed', '--expand-tabs', '--forward-ed', '--ignore-all-space', '--ignore-case', '--ignore-space-change', '--initial-tab', '--minimal', '--no-dereference', '--no-ignore-file-name-case', '--normal', '--paginate', '--rcs', '--show-c-function', '--speed-large-files', '--starting-file', '--strip-trailing-cr', '--text', '--unified'),
  ...valued('non-path', '-A', '-C', '-D', '-F', '-I', '-L', '-U', '-x', '-S', '--algorithm', '--tabsize', '--label', '--ignore-matching-lines', '--show-function-line', '--context', '--ifdef', '--changed-group-format'),
  ...valued('read', '-X'),
  ...optionalValue('non-path', '--color'),
  ...when({ none: ['--no-dereference'] }, marked('follows-symlinks', '-r', '--recursive')),
];

const LS_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('@ABCFGHIOPRSTUWabcdefghiklmnopqrstuvwxy1%,')),
  ...marked('follows-symlinks', '-L'),
  ...valued('non-path', '-D'),
  ...optionalValue('non-path', '--color'),
];

const SORT_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('bcCdfghiRMmnrsuVz')),
  ...valued('non-path', '-k', '-S', '-t', '--key', '--field-separator', '--buffer-size'),
  ...valued('write', '-o', '-T', '--output', '--temporary-directory'),
  ...valued('exec', '--compress-program'),
];

const PS_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('ACcefhjlMmrSTvwXxL')),
  ...marked('sensitive', '-E'),
  ...valued('non-path', '-O', '-o', '-G', '-g', '-u', '-p', '-t', '-U'),
];

const FIND_OPTIONS: readonly OptionDecl[] = [
  ...flag('-H', '-P', '-E', '-X', '-d', '-s', '-x', '-depth', '-prune', '-print', '-print0', '-empty', '-not', '-a', '-o', '-and', '-or', '-xdev', '-mount', '-true', '-false', '-ls', '-nouser', '-nogroup', '!', '(', ')'),
  ...marked('follows-symlinks', '-L', '-follow'),
  ...valued('read', '-f', '-newer', '-samefile'),
  ...valued('non-path', '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-size', '-mtime', '-atime', '-ctime', '-mmin', '-amin', '-cmin', '-perm', '-user', '-group', '-uid', '-gid', '-maxdepth', '-mindepth', '-links', '-inum', '-fstype', '-flags', '-lname', '-ilname'),
  ...marked('delete', '-delete'),
  ...decl('exec', 'command', ['-exec', '-execdir', '-ok', '-okdir']),
  ...valued('exec', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from'),
  ...marked('exec', '-rm'),
];

export const BSD_SPECS: readonly CommandSpec[] = [
  define({ names: ['mkdir'], approval: 'edit', operands: 'write-all', options: [...flag('-p', '-v'), ...valued('non-path', '-m')] }),
  define({ names: ['rmdir'], approval: 'edit', operands: 'write-all', removes: true, options: flag('-p', '-v') }),
  define({ names: ['rm'], approval: 'edit', operands: 'write-all', removes: true, options: flag(...letters('fidIRrvWx')) }),
  define({
    names: ['touch'],
    approval: 'edit',
    operands: 'write-all',
    plainOperandsOnly: true,
    options: [...flag(...letters('achm')), ...valued('non-path', '-A', '-t', '-d'), ...valued('read', '-r')],
  }),
  define({ names: ['mv'], createsNames: true, approval: 'edit', operands: 'move', options: [...flag(...letters('finhv')), ...COPY_TARGET_OPTIONS] }),
  define({
    names: ['cp'],
    createsNames: true,
    approval: 'edit',
    operands: 'copy',
    options: [
      ...flag(...letters('RHPfinaclNpSvXx')),
      ...marked('symlink-create', '-s'),
      ...marked('follows-symlinks', '-L'),
      ...COPY_TARGET_OPTIONS,
    ],
  }),
  define({
    names: ['sed'],
    dialect: 'bsd',
    approval: 'edit',
    operands: 'read-all',
    extractor: 'sed',
    options: [...flag(...letters('EHalnru')), ...valued('payload', '-e'), ...valued('opens-path', '-f'), ...valued('non-path', '-i', '-I')],
  }),
  define({ names: ['ls'], approval: 'read-only', operands: 'read-all', options: LS_OPTIONS }),
  define({ names: ['cat'], approval: 'read-only', operands: 'read-all', options: flag(...letters('belnstuv')) }),
  define({ names: ['head'], approval: 'read-only', operands: 'read-all', numericOptions: true, options: valued('non-path', '-n', '-c') }),
  define({ names: ['tail'], approval: 'read-only', operands: 'read-all', numericOptions: true, options: [...flag('-F', '-f', '-r', '-q', '-v'), ...valued('non-path', '-b', '-c', '-n')] }),
  define({ names: ['wc'], approval: 'read-only', operands: 'read-all', options: flag(...letters('Lclmw')) }),
  define({ names: ['grep'], approval: 'read-only', operands: 'pattern-first', patternOptions: ['-e', '-f', '--regexp', '--file'], options: GREP_OPTIONS }),
  define({ names: ['egrep', 'fgrep'], operands: 'pattern-first', patternOptions: ['-e', '-f', '--regexp', '--file'], options: GREP_OPTIONS }),
  define({ names: ['diff'], approval: 'read-only', operands: 'read-all', options: DIFF_OPTIONS }),
  define({
    names: ['stat'],
    approval: 'read-only',
    operands: 'read-all',
    options: [...flag(...letters('Fnqlrsx')), ...marked('follows-symlinks', '-L'), ...valued('non-path', '-f', '-t')],
  }),
  define({
    names: ['du'],
    approval: 'read-only',
    operands: 'read-all',
    options: [...flag(...letters('AclnxHPghkmas')), ...marked('follows-symlinks', '-L'), ...valued('non-path', '-d', '-B', '-I', '-t')],
  }),
  define({ names: ['which'], approval: 'read-only', operands: 'none', options: flag('-a', '-s') }),
  define({
    names: ['file'],
    approval: 'read-only',
    operands: 'read-all',
    options: [
      ...flag(...letters('bcdDhiIkLnNprsvz'), '--exclude-quiet', '--extension', '--mime-encoding', '--mime-type'),
      ...valued('opens-path', '-f', '-m', '-M'),
      ...marked('opens-path', '-C'),
      ...valued('non-path', '-P'),
    ],
  }),
  define({ names: ['ps'], approval: 'read-only', operands: 'none', options: PS_OPTIONS, psLetters: { allowed: 'AaCcfhjlMmrSTuvwXx', sensitive: 'eE' } }),
  define({ names: ['sort'], approval: 'read-only', operands: 'read-all', options: SORT_OPTIONS }),
  define({ names: ['find'], approval: 'read-only', operands: 'read-all', extractor: 'find', noClusters: true, options: FIND_OPTIONS }),
];
