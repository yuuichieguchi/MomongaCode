import path from 'node:path';
import type { RedirectTarget, Segment, Word } from './shell.ts';

export type PathEffects = { writes: RedirectTarget[]; reads: RedirectTarget[]; opaque: boolean };

const NONE: PathEffects = { writes: [], reads: [], opaque: false };
const REMOTE_NAME = '__remote_name__';
const EXTRACTED = '__extracted__';

const set = (...values: string[]): ReadonlySet<string> => new Set(values);

const positionalArguments = (args: Word[], valuedOptions: ReadonlySet<string>): Word[] => {
  const positional: Word[] = [];
  let skipNext = false;
  let afterDoubleDash = false;
  for (const word of args) {
    if (skipNext) {
      skipNext = false;
    } else if (!afterDoubleDash && word.literal && word.value === '--') {
      afterDoubleDash = true;
    } else if (!afterDoubleDash && word.literal && word.value.startsWith('-') && word.value !== '-') {
      skipNext = valuedOptions.has(word.value);
    } else {
      positional.push(word);
    }
  }
  return positional;
};

const targets = (words: Word[]): RedirectTarget[] => words.map((word) => word.staticValue);

const shortValues = (args: Word[], letter: string, otherValued = ''): RedirectTarget[] => {
  const values: RedirectTarget[] = [];
  args.forEach((word, index) => {
    if (!word.literal || !/^-[^-]/.test(word.value)) return;
    for (let position = 1; position < word.value.length; position += 1) {
      const current = word.value.charAt(position);
      if (current === letter) {
        const rest = word.value.slice(position + 1);
        values.push(rest === '' ? (args[index + 1]?.staticValue ?? null) : rest);
        return;
      }
      if (otherValued.includes(current)) return;
    }
  });
  return values;
};

const longValues = (args: Word[], name: string): RedirectTarget[] => {
  const values: RedirectTarget[] = [];
  args.forEach((word, index) => {
    if (!word.literal) return;
    if (word.value === `--${name}`) values.push(args[index + 1]?.staticValue ?? null);
    else if (word.value.startsWith(`--${name}=`)) values.push(word.value.slice(name.length + 3));
  });
  return values;
};

const hasLiteral = (args: Word[], pattern: RegExp): boolean => args.some((word) => word.literal && pattern.test(word.value));

const isRemote = (target: RedirectTarget): boolean => target !== null && /^[^/]*:/.test(target) && !target.startsWith('.');

const withoutStdout = (values: RedirectTarget[]): RedirectTarget[] => values.filter((value) => value !== '-');

const intoDirectory = (directories: RedirectTarget[], entry: string): RedirectTarget[] =>
  directories.map((directory) => (directory === null ? null : `${directory}/${entry}`));

const COPY_VALUED = set('-t', '-S', '-m', '-o', '-g', '--target-directory', '--suffix', '--mode', '--owner', '--group');

const copyLike = (name: string, args: Word[]): PathEffects => {
  const directories = [...shortValues(args, 't', 'SmogT'), ...longValues(args, 'target-directory')];
  const positional = positionalArguments(args, COPY_VALUED);
  const reads = name === 'ln' ? [] : targets(directories.length > 0 ? positional : positional.slice(0, -1));
  if (directories.length > 0) return { writes: directories, reads, opaque: false };
  if (positional.length === 1 && name === 'ln') return { writes: [null], reads, opaque: false };
  const destination = positional.at(-1);
  return { writes: destination === undefined ? [] : [destination.staticValue], reads, opaque: false };
};

const SED_VALUED = set('-e', '-f', '-l', '--expression', '--file', '--line-length');

const sedEffects = (args: Word[]): PathEffects => {
  const inPlace = hasLiteral(args, /^(-[A-Za-z]*i|--in-place)/);
  const scriptFiles = [...shortValues(args, 'f', 'el'), ...longValues(args, 'file')];
  const scriptGivenByOption = scriptFiles.length > 0 || shortValues(args, 'e', 'fl').length > 0 || longValues(args, 'expression').length > 0;
  const positional = positionalArguments(args, SED_VALUED);
  const files = targets(scriptGivenByOption ? positional : positional.slice(1));
  return inPlace ? { writes: files, reads: scriptFiles, opaque: false } : { writes: [], reads: [...scriptFiles, ...files], opaque: false };
};

const perlEffects = (args: Word[]): PathEffects => {
  if (!hasLiteral(args, /^-[A-Za-z]*i/)) return NONE;
  const scriptGivenByOption = hasLiteral(args, /^-[A-Za-z]*[eE]/);
  const positional = positionalArguments(args, set('-e', '-E', '-I', '-M', '-m'));
  return { writes: targets(scriptGivenByOption ? positional : positional.slice(1)), reads: [], opaque: false };
};

const CURL_VALUED_LETTERS = 'HdXAeFTKuUmwxbcDrCzyY';

const curlEffects = (args: Word[]): PathEffects => {
  const outputs = withoutStdout([...shortValues(args, 'o', CURL_VALUED_LETTERS), ...longValues(args, 'output')]);
  const remoteName = hasLiteral(args, /^(-[A-Za-z]*O|--remote-name)$/);
  const directories = longValues(args, 'output-dir');
  const named = remoteName ? (directories.length > 0 ? intoDirectory(directories, REMOTE_NAME) : [null]) : [];
  return { writes: [...outputs, ...named], reads: [], opaque: false };
};

const wgetEffects = (args: Word[]): PathEffects => {
  const logs = [...shortValues(args, 'o', 'OPeiBtTwQlUnr'), ...shortValues(args, 'a', 'OPeiBtTwQlUnr'), ...longValues(args, 'output-file')];
  const documents = [...shortValues(args, 'O', 'oaPeiBtTwQlUnr'), ...longValues(args, 'output-document')];
  if (documents.length > 0) return { writes: [...logs, ...withoutStdout(documents)], reads: [], opaque: false };
  if (hasLiteral(args, /^--spider$/)) return { writes: logs, reads: [], opaque: false };
  const prefixes = [...shortValues(args, 'P', 'oaOeiBtTwQlUnr'), ...longValues(args, 'directory-prefix')];
  return { writes: [...logs, ...(prefixes.length > 0 ? intoDirectory(prefixes, REMOTE_NAME) : [null])], reads: [], opaque: false };
};

const TAR_VALUED = set('-f', '-C', '-T', '-X', '--file', '--directory', '--files-from', '--exclude-from');

const tarEffects = (args: Word[]): PathEffects => {
  const first = args[0];
  const oldStyle = first !== undefined && first.literal && !first.value.startsWith('-');
  const letters = oldStyle
    ? (first as Word).value
    : args.filter((word) => word.literal && /^-[A-Za-z]+$/.test(word.value)).map((word) => word.value.slice(1)).join('');
  const extract = letters.includes('x') || hasLiteral(args, /^--(extract|get)$/);
  const create = letters.includes('c') || hasLiteral(args, /^--create$/);
  const listing = letters.includes('t') || hasLiteral(args, /^--list$/);
  const rest = oldStyle ? args.slice(1) : args;
  const takesFile = oldStyle ? letters.includes('f') : false;
  const takesDirectory = oldStyle ? letters.includes('C') : false;
  const leading = oldStyle ? rest.slice(0, Number(takesFile) + Number(takesDirectory)) : [];
  const archives = oldStyle
    ? takesFile ? [leading[takesDirectory && letters.indexOf('C') < letters.indexOf('f') ? 1 : 0]?.staticValue ?? null] : []
    : [...shortValues(args, 'f', 'CTX'), ...longValues(args, 'file')];
  const directories = oldStyle
    ? takesDirectory ? [leading[takesFile && letters.indexOf('f') < letters.indexOf('C') ? 1 : 0]?.staticValue ?? null] : []
    : [...shortValues(args, 'C', 'fTX'), ...longValues(args, 'directory')];
  const operands = oldStyle ? rest.slice(leading.length) : positionalArguments(args, TAR_VALUED);
  const reads: RedirectTarget[] = [];
  const writes: RedirectTarget[] = [];
  if (extract) {
    reads.push(...archives);
    writes.push(...(directories.length > 0 ? intoDirectory(directories, EXTRACTED) : [null]));
  } else if (create) {
    writes.push(...archives);
    reads.push(...targets(operands));
  } else if (listing) {
    reads.push(...archives);
  }
  return { writes, reads, opaque: false };
};

const unzipEffects = (args: Word[]): PathEffects => {
  const positional = positionalArguments(args, set('-d', '-x', '-P'));
  const reads = positional.slice(0, 1).map((word) => word.staticValue);
  if (hasLiteral(args, /^-[lptvZz]+$/)) return { writes: [], reads, opaque: false };
  const directories = shortValues(args, 'd', 'xP');
  return { writes: directories.length > 0 ? intoDirectory(directories, EXTRACTED) : [null], reads, opaque: false };
};

const zipEffects = (args: Word[]): PathEffects => {
  const positional = positionalArguments(args, set('-b', '-t', '-n', '-x', '-i', '-O', '--output-file'));
  const archive = positional[0];
  return { writes: archive === undefined ? [] : withoutStdout([archive.staticValue]), reads: targets(positional.slice(1)), opaque: false };
};

const TRANSFER_VALUED = set('-e', '-f', '-P', '-i', '-o', '-F', '-l', '-S', '-c', '-J', '-D', '--rsh', '--filter', '--port', '--bwlimit', '--timeout', '--rsync-path', '--log-file', '--temp-dir', '--exclude', '--include', '--exclude-from', '--include-from', '--files-from', '--backup-dir', '--suffix', '--compare-dest', '--partial-dir');

const transferEffects = (args: Word[]): PathEffects => {
  const positional = targets(positionalArguments(args, TRANSFER_VALUED));
  if (positional.length < 2) return NONE;
  const destination = positional.at(-1) ?? null;
  const sources = positional.slice(0, -1).filter((source) => !isRemote(source));
  return { writes: isRemote(destination) ? [] : [destination], reads: sources, opaque: false };
};

const GIT_CLONE_VALUED = set('-b', '--branch', '-o', '--origin', '--depth', '--reference', '--template', '-c', '--config', '--separate-git-dir', '-j', '--jobs', '--filter', '--upload-pack', '-u', '--shallow-since', '--shallow-exclude', '--server-option');
const GIT_GLOBAL_VALUED = set('-c', '-C', '--git-dir', '--work-tree', '--exec-path', '--namespace', '--config-env');

const gitEffects = (args: Word[]): PathEffects => {
  let index = 0;
  while (index < args.length && (args[index] as Word).literal && (args[index] as Word).value.startsWith('-')) {
    index += GIT_GLOBAL_VALUED.has((args[index] as Word).value) ? 2 : 1;
  }
  const subcommand = args[index];
  if (subcommand === undefined || !subcommand.literal || subcommand.value !== 'clone') return NONE;
  const positional = positionalArguments(args.slice(index + 1), GIT_CLONE_VALUED);
  return { writes: [positional[1]?.staticValue ?? null], reads: [], opaque: false };
};

const READER_VALUED: Readonly<Record<string, ReadonlySet<string>>> = {
  cat: set(),
  head: set('-n', '-c'),
  tail: set('-n', '-c', '-s', '--pid'),
  less: set('-p', '-P', '-t', '-T', '-x', '-y', '-z', '-h', '-b', '-j', '-k', '-o', '-O'),
  more: set('-n', '-p'),
  wc: set(),
  sort: set('-k', '-t', '-T', '-S', '-o', '--key', '--field-separator', '--output', '--temporary-directory', '--buffer-size'),
  uniq: set('-f', '-s', '-w'),
  nl: set('-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w'),
  cut: set('-b', '-c', '-d', '-f'),
  base64: set('-w', '-b'),
  xxd: set('-l', '-s', '-c', '-g', '-o', '-n'),
  od: set('-N', '-j', '-t', '-A', '-w'),
  strings: set('-n', '-t', '-e'),
  diff: set('-U', '-C', '-x', '-I', '-F', '-L', '--label'),
  cmp: set('-n', '-i'),
};

const SEARCH_VALUED = set('-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '-g', '-t', '-T', '-j', '-M', '-E', '--regexp', '--file', '--max-count', '--include', '--exclude', '--exclude-dir', '--label', '--context', '--after-context', '--before-context', '--binary-files', '--directories', '--devices', '--glob', '--type', '--type-not', '--threads', '--max-columns', '--encoding', '--max-depth');

const searchEffects = (args: Word[]): PathEffects => {
  const patternFiles = [...shortValues(args, 'f', 'emABCdDgtTjME'), ...longValues(args, 'file')];
  const patternGiven =
    patternFiles.length > 0 || shortValues(args, 'e', 'fmABCdDgtTjME').length > 0 || longValues(args, 'regexp').length > 0 || hasLiteral(args, /^--files$/);
  const positional = positionalArguments(args, SEARCH_VALUED);
  return { writes: [], reads: [...patternFiles, ...targets(patternGiven ? positional : positional.slice(1))], opaque: false };
};

const awkEffects = (args: Word[]): PathEffects => {
  const programFiles = [...shortValues(args, 'f', 'Fv'), ...longValues(args, 'file')];
  const positional = positionalArguments(args, set('-F', '-v', '-f', '--field-separator', '--assign', '--file'));
  if (programFiles.length > 0) return { writes: [], reads: [...programFiles, ...targets(positional)], opaque: true };
  const program = positional[0];
  const opaque = program === undefined || !program.literal || /system\s*\(|\|/.test(program.value);
  return { writes: [], reads: targets(positional.slice(1)), opaque };
};

const sortEffects = (args: Word[]): PathEffects => {
  const outputs = [...shortValues(args, 'o', 'ktTS'), ...longValues(args, 'output')];
  const base = readerEffects('sort', args);
  return { ...base, writes: outputs };
};

const readerEffects = (name: string, args: Word[]): PathEffects => {
  const valued = READER_VALUED[name];
  if (valued === undefined) return NONE;
  return { writes: [], reads: targets(positionalArguments(args, valued)), opaque: false };
};

const INTERPRETER_INLINE: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^python[0-9.]*$/, /^-[A-Za-z]*c/],
  [/^(node|nodejs|deno|bun)$/, /^(-[A-Za-z]*[epr]|--eval|--print)/],
  [/^perl[0-9.]*$/, /^-[A-Za-z]*[eE]/],
  [/^ruby[0-9.]*$/, /^-[A-Za-z]*e/],
  [/^php[0-9.]*$/, /^-[A-Za-z]*r/],
  [/^(osascript|lua[0-9.]*)$/, /^-[A-Za-z]*e/],
];

const INTERPRETER_NAMES = /^(python[0-9.]*|node|nodejs|deno|bun|perl[0-9.]*|ruby[0-9.]*|php[0-9.]*|osascript|lua[0-9.]*)$/;

const interpreterIsOpaque = (name: string, args: Word[]): boolean => {
  if (!INTERPRETER_NAMES.test(name)) return false;
  const inline = INTERPRETER_INLINE.some(([names, flag]) => names.test(name) && hasLiteral(args, flag));
  const hasOperand = args.some((word) => !word.literal || !word.value.startsWith('-'));
  return inline || !hasOperand;
};

export const pathEffectsOf = (segment: Segment): PathEffects => {
  const program = segment.words[segment.effectiveIndex];
  if (program === undefined || !program.literal) return NONE;
  const name = path.basename(program.value);
  const args = segment.words.slice(segment.effectiveIndex + 1);
  const opaque = interpreterIsOpaque(name, args);
  const effects = effectsFor(name, args);
  return opaque ? { ...effects, opaque: true } : effects;
};

const effectsFor = (name: string, args: Word[]): PathEffects => {
  switch (name) {
    case 'tee':
      return { writes: targets(positionalArguments(args, set())), reads: [], opaque: false };
    case 'touch':
      return { writes: targets(positionalArguments(args, set('-t', '-d', '-r'))), reads: [], opaque: false };
    case 'truncate':
      return { writes: targets(positionalArguments(args, set('-s', '-r'))), reads: [], opaque: false };
    case 'cp':
    case 'mv':
    case 'install':
    case 'ln':
      return copyLike(name, args);
    case 'dd':
      return {
        writes: args.filter((word) => word.value.startsWith('of=')).map((word) => (word.staticValue === null ? null : word.staticValue.slice(3))),
        reads: args.filter((word) => word.value.startsWith('if=')).map((word) => (word.staticValue === null ? null : word.staticValue.slice(3))),
        opaque: false,
      };
    case 'sed':
      return sedEffects(args);
    case 'perl':
      return perlEffects(args);
    case 'curl':
      return curlEffects(args);
    case 'wget':
      return wgetEffects(args);
    case 'tar':
    case 'bsdtar':
    case 'gtar':
      return tarEffects(args);
    case 'unzip':
      return unzipEffects(args);
    case 'zip':
      return zipEffects(args);
    case 'rsync':
    case 'scp':
      return transferEffects(args);
    case 'patch':
      return hasLiteral(args, /^--dry-run$/) ? NONE : { writes: [null], reads: [], opaque: false };
    case 'git':
      return gitEffects(args);
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rg':
      return searchEffects(args);
    case 'awk':
    case 'gawk':
    case 'mawk':
      return awkEffects(args);
    case 'sort':
      return sortEffects(args);
    default:
      return readerEffects(name, args);
  }
};
