export type OptionEffect =
  | 'flag'
  | 'non-path'
  | 'read'
  | 'write'
  | 'delete'
  | 'cwd'
  | 'root'
  | 'exec'
  | 'opens-path'
  | 'sensitive'
  | 'symlink-create'
  | 'follows-symlinks'
  | 'payload';

export type OptionTakes = 'none' | 'value' | 'attached' | 'command';

export type OptionCondition = { any?: readonly string[]; none?: readonly string[] };

export type OptionDecl = { name: string; takes: OptionTakes; effect: OptionEffect; applies?: OptionCondition };

export type OperandRole =
  | 'none'
  | 'read-all'
  | 'write-all'
  | 'copy'
  | 'move'
  | 'pattern-first'
  | 'first-write-rest-read'
  | 'first-read-second-write'
  | 'candidate-all';

export type ExtractorId =
  | 'sed'
  | 'dd'
  | 'ln'
  | 'install'
  | 'tar'
  | 'curl'
  | 'wget'
  | 'unzip'
  | 'transfer'
  | 'patch'
  | 'git'
  | 'awk'
  | 'find'
  | 'cd'
  | 'interpreter';

export type WrapperDecl = {
  positionals?: number;
  positionalWrites?: boolean;
  positionalRoot?: boolean;
  assignments?: boolean;
  strip?: 'always' | 'bare';
  approvable?: boolean;
  program?: true;
  approvedOptions?: readonly string[];
  queryOptions?: readonly string[];
};

export type CommandSpecInput = {
  names: readonly string[];
  namePattern?: RegExp;
  options?: readonly OptionDecl[];
  operands?: OperandRole;
  approval?: 'edit' | 'read-only';
  builtin?: true;
  neverPrefix?: true;
  payload?: 'shell' | 'eval' | 'source';
  inlineOptions?: RegExp;
  changesDirectory?: true;
  plainOperandsOnly?: true;
  numericOptions?: true;
  noClusters?: true;
  abbreviations?: true;
  extractor?: ExtractorId;
  wrapper?: WrapperDecl;
  patternOptions?: readonly string[];
  removes?: true;
  createsNames?: true;
  dialect?: 'bsd' | 'gnu';
  psLetters?: { allowed: string; sensitive: string };
};

export type CommandSpec = CommandSpecInput & {
  options: readonly OptionDecl[];
  operands: OperandRole;
  declOf(option: string): OptionDecl | undefined;
  effectOf(option: string): OptionEffect | undefined;
};

export const decl = (effect: OptionEffect, takes: OptionTakes, names: readonly string[]): OptionDecl[] => names.map((name) => ({ name, takes, effect }));

export const flag = (...names: string[]): OptionDecl[] => decl('flag', 'none', names);
export const valued = (effect: OptionEffect, ...names: string[]): OptionDecl[] => decl(effect, 'value', names);
export const optionalValue = (effect: OptionEffect, ...names: string[]): OptionDecl[] => decl(effect, 'attached', names);
export const marked = (effect: OptionEffect, ...names: string[]): OptionDecl[] => decl(effect, 'none', names);
export const letters = (text: string): string[] => [...text].map((letter) => `-${letter}`);
export const when = (conditions: OptionCondition, options: readonly OptionDecl[]): OptionDecl[] => options.map((option) => ({ ...option, applies: conditions }));

export const define = (input: CommandSpecInput): CommandSpec => {
  const options = input.options ?? [];
  const byName = new Map(options.map((option) => [option.name, option]));
  return {
    ...input,
    options,
    operands: input.operands ?? 'none',
    declOf: (option) => byName.get(option),
    effectOf: (option) => byName.get(option)?.effect,
  };
};

const SEARCH_OPTIONS: readonly OptionDecl[] = [
  ...valued('non-path', ...letters('emABCdDgtTjME'), '--regexp', '--max-count', '--include', '--exclude', '--exclude-dir', '--label', '--context', '--after-context', '--before-context', '--binary-files', '--directories', '--devices', '--glob', '--type', '--type-not', '--threads', '--max-columns', '--encoding', '--max-depth'),
  ...valued('read', '-f', '--file'),
];

const CURL_OPTIONS: readonly OptionDecl[] = [
  ...valued('non-path', ...letters('HdXAeFTKuUmwxbrCzyY'), '--header', '--data', '--request', '--user-agent', '--referer', '--form', '--upload-file', '--config', '--user', '--max-time', '--write-out', '--proxy', '--cookie', '--range', '--continue-at', '--time-cond'),
  ...valued('write', '-o', '--output', '-D', '--dump-header', '-c', '--cookie-jar', '--output-dir', '--trace', '--trace-ascii', '--stderr', '--etag-save', '--libcurl'),
];

const WGET_OPTIONS: readonly OptionDecl[] = [
  ...valued('non-path', ...letters('eiBtTwQlUnr'), '--execute', '--input-file', '--tries', '--timeout', '--wait', '--user', '--password'),
  ...valued('write', '-o', '--output-file', '-a', '--append-output', '-O', '--output-document', '-P', '--directory-prefix', '--save-cookies', '--warc-file', '--rejected-log'),
  ...flag('--spider'),
];

const TAR_OPTIONS: readonly OptionDecl[] = [
  ...valued('non-path', '-f', '-T', '-X', '--file', '--files-from', '--exclude-from'),
  ...valued('cwd', '-C', '--directory'),
  ...flag(...letters('xctvzjJpPkoOh'), '--extract', '--get', '--create', '--list', '--gzip', '--verbose'),
];

const TRANSFER_OPTIONS: readonly OptionDecl[] = [
  ...valued('non-path', ...letters('efPioFlScJD'), '--rsh', '--filter', '--port', '--bwlimit', '--timeout', '--rsync-path', '--exclude', '--include', '--exclude-from', '--include-from', '--files-from', '--suffix', '--compare-dest'),
  ...valued('write', '--log-file', '--temp-dir', '--backup-dir', '--partial-dir', '--write-batch', '--only-write-batch'),
  ...marked('delete', '--delete', '--delete-before', '--delete-after', '--delete-during', '--delete-delay', '--delete-excluded'),
];

export const COPY_TARGET_OPTIONS: readonly OptionDecl[] = [...valued('write', '-t', '--target-directory')];


const GIT_GLOBAL_OPTIONS: readonly OptionDecl[] = [
  ...flag('-p', '--paginate', '-P', '--no-pager', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-advice', '--bare', '--version', '--help', '--html-path', '--man-path', '--info-path'),
  ...valued('cwd', '-C', '--git-dir', '--work-tree'),
  ...valued('exec', '-c', '--config-env'),
  ...optionalValue('exec', '--exec-path'),
  ...valued('non-path', '--namespace', '--super-prefix', '--attr-source'),
];

const SHELL_NAMES = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash'] as const;

const STRIPPED = (extra: Partial<WrapperDecl> = {}): WrapperDecl => ({ strip: 'always', approvable: true, ...extra });
const WRAPPED = (extra: Partial<WrapperDecl> = {}): WrapperDecl => ({ ...extra });

export const NEUTRAL_SPECS: readonly CommandSpec[] = [
  define({ names: ['rg'], operands: 'pattern-first', patternOptions: ['-e', '-f', '--regexp', '--file', '--files'], options: [...SEARCH_OPTIONS, ...flag('--files')] }),
  define({ names: ['pwd'], approval: 'read-only', builtin: true, operands: 'none', options: flag('-L', '-P') }),
  define({ names: ['echo'], approval: 'read-only', builtin: true, operands: 'none', options: flag('-n', '-e', '-E') }),
  define({
    names: ['cd'],
    approval: 'read-only',
    builtin: true,
    changesDirectory: true,
    extractor: 'cd',
    operands: 'read-all',
    options: flag('-L', '-P'),
  }),
  define({ names: ['pushd', 'popd'], changesDirectory: true, extractor: 'cd', operands: 'read-all', options: flag('-n') }),
  define({ names: ['git'], createsNames: true, approval: 'read-only', extractor: 'git', operands: 'candidate-all', options: GIT_GLOBAL_OPTIONS }),

  define({ names: ['tee'], operands: 'write-all', options: flag('-a', '-i', '-p') }),
  define({ names: ['truncate'], operands: 'write-all', options: [...flag('-c'), ...valued('non-path', '-s'), ...valued('read', '-r')] }),
  define({ names: ['install'], createsNames: true, extractor: 'install', operands: 'copy', options: [...flag(...letters('bCcdpsv')), ...valued('non-path', '-B', '-f', '-g', '-m', '-o', '-S', '--suffix', '--mode', '--owner', '--group'), ...COPY_TARGET_OPTIONS] }),
  define({ names: ['ln'], createsNames: true, extractor: 'ln', operands: 'copy', options: [...flag(...letters('sfhnviFw')), ...valued('non-path', '-S', '--suffix'), ...COPY_TARGET_OPTIONS] }),
  define({ names: ['dd'], extractor: 'dd', operands: 'none' }),
  define({ names: ['curl'], extractor: 'curl', operands: 'none', options: [...CURL_OPTIONS, ...flag('-O', '--remote-name')] }),
  define({ names: ['wget'], extractor: 'wget', operands: 'none', options: WGET_OPTIONS }),
  define({ names: ['tar', 'bsdtar', 'gtar'], createsNames: true, extractor: 'tar', operands: 'read-all', options: TAR_OPTIONS }),
  define({ names: ['unzip'], createsNames: true, extractor: 'unzip', operands: 'read-all', options: [...valued('non-path', '-x', '-P'), ...valued('write', '-d')] }),
  define({ names: ['zip'], operands: 'first-write-rest-read', options: [...valued('non-path', '-b', '-t', '-n', '-x', '-i'), ...valued('write', '-O', '--output-file')] }),
  define({ names: ['rsync', 'scp'], createsNames: true, extractor: 'transfer', operands: 'copy', options: TRANSFER_OPTIONS }),
  define({ names: ['patch'], extractor: 'patch', operands: 'none', options: flag('--dry-run') }),
  define({ names: ['awk', 'gawk', 'mawk'], extractor: 'awk', operands: 'read-all', options: [...valued('non-path', '-F', '-v', '--field-separator', '--assign'), ...valued('read', '-f', '--file')] }),
  define({ names: ['less'], operands: 'read-all', options: [...valued('non-path', ...letters('pPtTxyzhbjk')), ...valued('write', '-o', '-O', '--log-file')] }),
  define({ names: ['more'], operands: 'read-all', options: valued('non-path', '-n', '-p') }),
  define({ names: ['uniq'], operands: 'first-read-second-write', options: valued('non-path', '-f', '-s', '-w') }),
  define({ names: ['xxd'], operands: 'first-read-second-write', options: valued('non-path', ...letters('lscgon')) }),
  define({ names: ['nl'], operands: 'read-all', options: valued('non-path', ...letters('bdfhilnsvw')) }),
  define({ names: ['cut'], operands: 'read-all', options: valued('non-path', '-b', '-c', '-d', '-f') }),
  define({ names: ['base64'], operands: 'read-all', options: [...valued('non-path', '-w', '-b'), ...valued('read', '-i'), ...valued('write', '-o')] }),
  define({ names: ['od'], operands: 'read-all', options: valued('non-path', '-N', '-j', '-t', '-A', '-w') }),
  define({ names: ['strings'], operands: 'read-all', options: valued('non-path', '-n', '-t', '-e') }),
  define({ names: ['cmp'], operands: 'read-all', options: valued('non-path', '-n', '-i') }),
  define({ names: ['tree'], operands: 'read-all', options: valued('write', '-o') }),

  define({ names: ['env'], neverPrefix: true, wrapper: WRAPPED({ assignments: true, program: true }), options: [...flag('-i', '-0', '-v', '--ignore-environment', '--null', '--debug'), ...valued('non-path', '-u', '-P', '-a', '--unset', '--argv0'), ...valued('cwd', '-C', '--chdir'), ...valued('payload', '-S', '--split-string')] }),
  define({
    names: ['sudo'],
    neverPrefix: true,
    wrapper: WRAPPED({ assignments: true }),
    options: [
      ...flag(...letters('AbBEHKknPSsVv'), '--askpass', '--background', '--bell', '--non-interactive', '--preserve-groups', '--set-home', '--shell', '--stdin', '--reset-timestamp', '--remove-timestamp'),
      ...optionalValue('non-path', '--preserve-env'),
      ...marked('cwd', '-i', '--login'),
      ...valued('cwd', '-D', '--chdir'),
      ...valued('root', '-R', '--chroot'),
      ...valued('non-path', '-u', '-C', '-g', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--close-from', '--host', '--prompt', '--role', '--type', '--other-user', '--command-timeout'),
    ],
  }),
  define({ names: ['doas'], neverPrefix: true, wrapper: WRAPPED(), options: [...flag('-n', '-s', '-L'), ...valued('non-path', '-u', '-C')] }),
  define({ names: ['nice'], wrapper: STRIPPED({ program: true, approvedOptions: ['-n'] }), numericOptions: true, options: valued('non-path', '-n', '--adjustment') }),
  define({ names: ['ionice'], neverPrefix: true, wrapper: WRAPPED(), options: [...flag('-t', '--ignore'), ...valued('non-path', ...letters('cnpPu'), '--class', '--classdata', '--pid', '--pgid', '--uid')] }),
  define({ names: ['stdbuf'], wrapper: STRIPPED({ program: true, approvedOptions: ['-e', '-i', '-o'] }), options: valued('non-path', '-i', '-o', '-e', '--input', '--output', '--error') }),
  define({
    names: ['flock'],
    neverPrefix: true,
    wrapper: WRAPPED({ positionals: 1, positionalWrites: true }),
    options: [
      ...flag(...letters('sxenuoF'), '--shared', '--exclusive', '--nonblock', '--nb', '--unlock', '--close', '--no-fork', '--verbose'),
      ...valued('non-path', '-w', '-E', '--timeout', '--wait', '--conflict-exit-code'),
      ...valued('payload', '-c', '--command'),
    ],
  }),
  define({ names: ['chroot'], neverPrefix: true, wrapper: WRAPPED({ positionals: 1, positionalRoot: true }), options: [...flag('--skip-chdir'), ...valued('non-path', '--userspec', '--groups')] }),
  define({
    names: ['script'],
    neverPrefix: true,
    wrapper: WRAPPED({ positionals: 1, positionalWrites: true }),
    options: [...flag(...letters('aeFkqrdf')), ...valued('non-path', '-t', '-E'), ...valued('write', '-I', '-O', '-B', '-T'), ...valued('payload', '-c', '--command')],
  }),
  define({ names: ['sandbox-exec'], neverPrefix: true, wrapper: WRAPPED(), options: valued('non-path', ...letters('fpnD')) }),
  define({
    names: ['watch'],
    neverPrefix: true,
    wrapper: WRAPPED(),
    options: [
      ...flag(...letters('bcCegpqtx'), '--beep', '--color', '--no-color', '--errexit', '--chgexit', '--precise', '--no-title', '--exec', '--differences', '--equexit'),
      ...valued('non-path', '-n', '--interval'),
      ...optionalValue('non-path', '-d'),
    ],
  }),
  define({
    names: ['parallel'],
    neverPrefix: true,
    wrapper: WRAPPED(),
    options: [
      ...flag(...letters('kXmqvtu0gzdU'), '--will-cite', '--keep-order', '--null', '--halt', '--bar', '--progress', '--eta', '--dry-run', '--tag', '--group', '--ungroup', '--line-buffer', '--citation', '--semaphore'),
      ...valued('non-path', ...letters('jnNLSaIsrC'), '--jobs', '--arg-file', '--max-args', '--max-replace-args', '--delimiter', '--sshlogin', '--timeout', '--retries', '--colsep', '--header'),
      ...valued('write', '--joblog', '--results'),
      ...valued('cwd', '--wd', '--workdir'),
    ],
  }),
  define({ names: ['caffeinate'], neverPrefix: true, wrapper: WRAPPED(), options: [...flag(...letters('dimsu')), ...valued('non-path', '-t', '-w')] }),
  define({ names: ['time'], wrapper: STRIPPED(), options: flag('-p') }),
  define({ names: ['nohup'], wrapper: STRIPPED({ program: true, approvedOptions: [] }), options: [] }),
  define({ names: ['command'], wrapper: STRIPPED({ queryOptions: ['-v', '-V'] }), options: flag('-p', '-v', '-V') }),
  define({ names: ['builtin'], wrapper: STRIPPED(), options: [] }),
  define({ names: ['noglob'], wrapper: STRIPPED({ program: true }), options: [] }),
  define({ names: ['exec'], neverPrefix: true, wrapper: WRAPPED(), options: [...flag('-c', '-l'), ...valued('non-path', '-a')] }),
  define({ names: ['busybox'], neverPrefix: true, wrapper: WRAPPED(), options: [] }),
  define({ names: ['setsid'], neverPrefix: true, wrapper: WRAPPED(), options: flag('-c', '-f', '-w', '--ctty', '--fork', '--wait') }),
  define({ names: ['arch'], neverPrefix: true, wrapper: WRAPPED(), noClusters: true, options: [...flag('-arm64', '-x86_64', '-x86_64h', '-i386', '-32', '-64'), ...valued('non-path', '-arch')] }),
  define({ names: ['unbuffer'], neverPrefix: true, wrapper: WRAPPED(), options: flag('-p') }),
  define({
    names: ['xargs'],
    wrapper: { strip: 'bare', program: true },
    options: [
      ...flag(...letters('0oprtxh'), '--null', '--no-run-if-empty', '--verbose', '--interactive', '--exit', '--open-tty', '--show-limits', '--replace', '--eof', '--max-lines', '--help', '--version'),
      ...valued('non-path', ...letters('IELPnsdaJ'), '--max-args', '--max-procs', '--delimiter', '--arg-file', '--max-chars', '--process-slot-var'),
      ...optionalValue('non-path', '-i', '-l', '-e'),
    ],
  }),
  define({
    names: ['timeout'],
    wrapper: STRIPPED({ positionals: 1, program: true }),
    options: [...flag('-f', '-p', '-v', '--foreground', '--preserve-status', '--verbose'), ...valued('non-path', '-s', '-k', '--signal', '--kill-after')],
  }),

  ...SHELL_NAMES.map((name) => define({ names: [name], neverPrefix: true, payload: 'shell' })),
  define({ names: ['eval'], neverPrefix: true, payload: 'eval' }),
  define({ names: ['source', '.'], neverPrefix: true, payload: 'source' }),
  define({ names: ['su'], neverPrefix: true }),

  define({ names: ['python', 'python2', 'python3'], namePattern: /^python[0-9.]*$/, extractor: 'interpreter', inlineOptions: /^-[A-Za-z]*c/ }),
  define({ names: ['node', 'nodejs', 'deno', 'bun'], extractor: 'interpreter', inlineOptions: /^(-[A-Za-z]*[epr]|--eval|--print)/ }),
  define({ names: ['perl'], namePattern: /^perl[0-9.]*$/, extractor: 'interpreter', inlineOptions: /^-[A-Za-z]*[eE]/ }),
  define({ names: ['ruby'], namePattern: /^ruby[0-9.]*$/, extractor: 'interpreter', inlineOptions: /^-[A-Za-z]*e/ }),
  define({ names: ['php'], namePattern: /^php[0-9.]*$/, extractor: 'interpreter', inlineOptions: /^-[A-Za-z]*r/ }),
  define({ names: ['osascript', 'lua'], namePattern: /^(osascript|lua[0-9.]*)$/, extractor: 'interpreter', inlineOptions: /^-[A-Za-z]*e/ }),
];

export type CommandSpecs = {
  all: readonly CommandSpec[];
  specOf(name: string): CommandSpec | undefined;
};

export const specsOf = (all: readonly CommandSpec[]): CommandSpecs => {
  const byName = new Map(all.flatMap((spec) => spec.names.map((name) => [name, spec] as const)));
  return { all, specOf: (name) => byName.get(name) ?? all.find((spec) => spec.namePattern?.test(name) === true) };
};
