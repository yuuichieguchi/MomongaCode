import { COPY_TARGET_OPTIONS, decl, define, flag, letters, marked, optionalValue, valued, when } from './command-specs.ts';
import type { CommandSpec, OptionDecl } from './command-specs.ts';

const GNU_GREP_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('EFGPiyvwxcLlHhonqsbTZzaIUr')),
  ...flag(
    '--extended-regexp', '--fixed-strings', '--basic-regexp', '--perl-regexp', '--ignore-case', '--no-ignore-case', '--invert-match', '--word-regexp', '--line-regexp',
    '--count', '--files-without-match', '--files-with-matches', '--with-filename', '--no-filename', '--only-matching', '--quiet', '--silent', '--no-messages',
    '--byte-offset', '--initial-tab', '--null', '--null-data', '--text', '--line-number', '--line-buffered', '--recursive', '--unix-byte-offsets',
  ),
  ...valued('non-path', ...letters('eABCdDm'), '--regexp', '--max-count', '--after-context', '--before-context', '--context', '--directories', '--devices', '--binary-files', '--label', '--include', '--exclude', '--exclude-dir'),
  ...valued('read', '-f', '--file', '--exclude-from'),
  ...optionalValue('non-path', '--color', '--colour'),
  ...marked('follows-symlinks', '-R', '--dereference-recursive'),
];

const GNU_LS_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('aAbBcCdDfFgGhHiklmnNopqQrRsStuUvxX1Z')),
  ...flag(
    '--all', '--almost-all', '--author', '--escape', '--ignore-backups', '--classify', '--dired', '--no-group', '--human-readable', '--si', '--dereference-command-line',
    '--dereference-command-line-symlink-to-dir', '--inode', '--kibibytes', '--numeric-uid-gid', '--literal', '--hide-control-chars', '--show-control-chars',
    '--quote-name', '--reverse', '--recursive', '--size', '--directory', '--group-directories-first', '--context', '--zero', '--full-time', '--file-type',
  ),
  ...marked('follows-symlinks', '-L', '--dereference'),
  ...valued('non-path', '-I', '-T', '-w', '--ignore', '--tabsize', '--width', '--block-size', '--format', '--indicator-style', '--hide', '--quoting-style', '--sort', '--time', '--time-style'),
  ...optionalValue('non-path', '--color'),
];

const GNU_DIFF_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('aBbcdEefilNnpqstTuwy')),
  ...flag(
    '--text', '--ignore-blank-lines', '--ignore-space-change', '--minimal', '--ignore-tab-expansion', '--ignore-trailing-space', '--ignore-case', '--new-file', '--show-c-function',
    '--brief', '--report-identical-files', '--initial-tab', '--ignore-all-space', '--side-by-side', '--paginate', '--speed-large-files', '--strip-trailing-cr', '--expand-tabs',
    '--unidirectional-new-file', '--no-dereference', '--normal', '--left-column', '--suppress-common-lines', '--suppress-blank-empty',
  ),
  ...valued('non-path', '-C', '-U', '-F', '-I', '-L', '-W', '-x', '--label', '--show-function-line', '--ignore-matching-lines', '--width', '--tabsize', '--exclude'),
  ...optionalValue('non-path', '--unified', '--context', '--color'),
  ...valued('read', '-X', '--exclude-from', '-S', '--starting-file'),
  ...when({ none: ['--no-dereference'] }, marked('follows-symlinks', '-r', '--recursive')),
];

const GNU_SORT_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('bcCdfghiMmnRrsuVz')),
  ...flag(
    '--ignore-leading-blanks', '--check', '--dictionary-order', '--ignore-case', '--general-numeric-sort', '--human-numeric-sort', '--ignore-nonprinting', '--month-sort', '--merge',
    '--numeric-sort', '--random-sort', '--reverse', '--stable', '--unique', '--version-sort', '--zero-terminated', '--debug',
  ),
  ...valued('non-path', '-k', '-S', '-t', '--key', '--field-separator', '--buffer-size', '--parallel', '--batch-size', '--sort'),
  ...valued('write', '-o', '-T', '--output', '--temporary-directory'),
  ...valued('read', '--random-source'),
  ...valued('exec', '--compress-program', '--files0-from'),
];

const GNU_PS_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('AadefFHjlLMmNrTwyZ')),
  ...flag('--forest', '--no-headers', '--no-heading', '--headers', '--cumulative'),
  ...marked('sensitive', '-E'),
  ...valued('non-path', '-C', '-G', '-g', '-p', '-s', '-t', '-U', '-u', '-o', '-O', '-n', '--pid', '--ppid', '--sid', '--tty', '--user', '--group', '--cols', '--columns', '--lines', '--rows', '--width', '--height', '--sort'),
];

const GNU_FIND_OPTIONS: readonly OptionDecl[] = [
  ...flag(
    '-H', '-P', '-depth', '-d', '-daystart', '-ignore_readdir_race', '-noignore_readdir_race', '-mount', '-xdev', '-noleaf', '-warn', '-nowarn', '-empty', '-executable', '-readable',
    '-writable', '-nouser', '-nogroup', '-prune', '-print', '-print0', '-ls', '-quit', '-true', '-false', '-not', '-a', '-o', '-and', '-or', '!', '(', ')',
  ),
  ...marked('follows-symlinks', '-L', '-follow'),
  ...valued('read', '-newer', '-samefile'),
  ...valued(
    'non-path', '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-xtype', '-size', '-mtime', '-atime', '-ctime', '-mmin', '-amin', '-cmin',
    '-perm', '-user', '-group', '-uid', '-gid', '-maxdepth', '-mindepth', '-links', '-inum', '-fstype', '-lname', '-ilname', '-newermt', '-D', '-regextype', '-printf',
  ),
  ...marked('delete', '-delete'),
  ...decl('exec', 'command', ['-exec', '-execdir', '-ok', '-okdir']),
  ...valued('exec', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from'),
];

const GNU_TAIL_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('fFqvz'), '--quiet', '--silent', '--verbose', '--zero-terminated', '--retry'),
  ...optionalValue('non-path', '--follow'),
  ...valued('non-path', '-c', '-n', '-s', '--bytes', '--lines', '--pid', '--sleep-interval', '--max-unchanged-stats'),
];

const GNU_CP_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('afinprRuvxTPHdl')),
  ...flag('--archive', '--force', '--interactive', '--no-clobber', '--recursive', '--update', '--verbose', '--one-file-system', '--no-target-directory', '--no-dereference', '--link', '--strip-trailing-slashes'),
  ...marked('symlink-create', '-s', '--symbolic-link'),
  ...marked('follows-symlinks', '-L', '--dereference'),
  ...COPY_TARGET_OPTIONS,
];

const GNU_DU_OPTIONS: readonly OptionDecl[] = [
  ...flag(...letters('abchkmsxDHPSl0')),
  ...flag('--all', '--apparent-size', '--bytes', '--total', '--dereference-args', '--human-readable', '--inodes', '--si', '--summarize', '--separate-dirs', '--one-file-system', '--no-dereference', '--count-links', '--null'),
  ...marked('follows-symlinks', '-L', '--dereference'),
  ...valued('non-path', '-d', '-B', '-t', '--max-depth', '--block-size', '--threshold', '--exclude', '--time-style'),
  ...optionalValue('non-path', '--time'),
  ...valued('read', '-X', '--exclude-from'),
];

export const GNU_SPECS: readonly CommandSpec[] = [
  define({ names: ['mkdir'], approval: 'edit', operands: 'write-all', options: [...flag('-p', '-v', '-Z', '--parents', '--verbose'), ...valued('non-path', '-m', '--mode')] }),
  define({ names: ['rmdir'], approval: 'edit', operands: 'write-all', removes: true, options: flag('-p', '-v', '--parents', '--verbose', '--ignore-fail-on-non-empty') }),
  define({
    names: ['rm'],
    approval: 'edit',
    operands: 'write-all',
    removes: true,
    options: [...flag(...letters('fiIrRdv'), '--force', '--recursive', '--dir', '--verbose', '--one-file-system'), ...optionalValue('non-path', '--interactive')],
  }),
  define({
    names: ['touch'],
    approval: 'edit',
    operands: 'write-all',
    plainOperandsOnly: true,
    options: [...flag(...letters('acfhm'), '--no-create', '--no-dereference'), ...valued('non-path', '-d', '-t', '--date', '--time'), ...valued('read', '-r', '--reference')],
  }),
  define({
    names: ['mv'],
    createsNames: true,
    approval: 'edit',
    operands: 'move',
    options: [...flag(...letters('finTuvZ'), '--force', '--interactive', '--no-clobber', '--no-target-directory', '--strip-trailing-slashes', '--verbose'), ...COPY_TARGET_OPTIONS],
  }),
  define({ names: ['cp'], createsNames: true, approval: 'edit', operands: 'copy', options: GNU_CP_OPTIONS }),
  define({
    names: ['sed'],
    dialect: 'gnu',
    approval: 'edit',
    operands: 'read-all',
    extractor: 'sed',
    options: [
      ...flag(...letters('nEruszb'), '--quiet', '--silent', '--regexp-extended', '--unbuffered', '--separate', '--null-data', '--posix', '--sandbox', '--debug', '--follow-symlinks', '--binary'),
      ...valued('payload', '-e', '--expression'),
      ...valued('opens-path', '-f', '--file'),
      ...valued('non-path', '-l', '--line-length'),
      ...optionalValue('non-path', '-i', '--in-place'),
    ],
  }),
  define({ names: ['ls'], approval: 'read-only', operands: 'read-all', options: GNU_LS_OPTIONS }),
  define({
    names: ['cat'],
    approval: 'read-only',
    operands: 'read-all',
    options: flag(...letters('AbeEnstTuv'), '--show-all', '--number-nonblank', '--show-ends', '--number', '--squeeze-blank', '--show-tabs', '--show-nonprinting'),
  }),
  define({
    names: ['head'],
    approval: 'read-only',
    operands: 'read-all',
    numericOptions: true,
    options: [...flag('-q', '-v', '-z', '--quiet', '--silent', '--verbose', '--zero-terminated'), ...valued('non-path', '-c', '-n', '--bytes', '--lines')],
  }),
  define({ names: ['tail'], approval: 'read-only', operands: 'read-all', numericOptions: true, options: GNU_TAIL_OPTIONS }),
  define({
    names: ['wc'],
    approval: 'read-only',
    operands: 'read-all',
    options: flag(...letters('clmwL'), '--bytes', '--chars', '--lines', '--words', '--max-line-length'),
  }),
  define({ names: ['grep'], approval: 'read-only', operands: 'pattern-first', numericOptions: true, patternOptions: ['-e', '-f', '--regexp', '--file'], options: GNU_GREP_OPTIONS }),
  define({ names: ['egrep', 'fgrep'], approval: 'read-only', operands: 'pattern-first', numericOptions: true, patternOptions: ['-e', '-f', '--regexp', '--file'], options: GNU_GREP_OPTIONS }),
  define({ names: ['diff'], approval: 'read-only', operands: 'read-all', options: GNU_DIFF_OPTIONS }),
  define({
    names: ['stat'],
    approval: 'read-only',
    operands: 'read-all',
    options: [...flag('-f', '-t', '--file-system', '--terse'), ...marked('follows-symlinks', '-L', '--dereference'), ...valued('non-path', '-c', '--format', '--printf')],
  }),
  define({ names: ['du'], approval: 'read-only', operands: 'read-all', options: GNU_DU_OPTIONS }),
  define({ names: ['which'], approval: 'read-only', operands: 'none', options: flag('-a') }),
  define({
    names: ['file'],
    approval: 'read-only',
    operands: 'read-all',
    options: [
      ...flag(...letters('bcdhiIkLnNprsvz'), '--brief', '--mime', '--mime-type', '--mime-encoding', '--keep-going', '--dereference', '--no-dereference', '--no-pad', '--preserve-date', '--raw', '--special-files', '--uncompress'),
      ...valued('opens-path', '-f', '-m', '--files-from', '--magic-file'),
      ...marked('opens-path', '-C'),
      ...valued('non-path', '-F', '-P', '-e', '--separator', '--parameter', '--exclude'),
    ],
  }),
  define({ names: ['ps'], approval: 'read-only', operands: 'none', options: GNU_PS_OPTIONS, psLetters: { allowed: 'AaCcfhjlMmrSTuvwXx', sensitive: 'eE' } }),
  define({ names: ['sort'], approval: 'read-only', operands: 'read-all', options: GNU_SORT_OPTIONS }),
  define({ names: ['find'], approval: 'read-only', operands: 'read-all', extractor: 'find', noClusters: true, options: GNU_FIND_OPTIONS }),
];
