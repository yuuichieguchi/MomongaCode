import { EMPTY_PROTECTED_SET, groupRecordOutcome, mapAsync, momongaLayout, nodeFileSystem, sha256Hex } from '@momonga/foundation';
import path from 'node:path';
import type { SandboxExit, SandboxPolicy } from '@momonga/sandbox';
import { requireSpawnMarker, settleFinishedCommand } from '../marker-settle.ts';
import { createReadAccessMatcher } from '../read-access.ts';
import { ripgrepUnavailableMessage } from '../ripgrep-locator.ts';
import type { ReadAccessMatcher } from '../read-access.ts';
import { defineTool, ToolExecutionError } from '../types.ts';
import type { ToolBackend, ToolContext } from '../types.ts';
import type { RipgrepLocator } from '../ripgrep-locator.ts';
import { extensionsForType } from './file-types.ts';
import { regularFileProblem, statIfExists } from './files.ts';
import { sortByMtimeThenPath } from './glob.ts';
import { canonicalPathOf, resolvedPathOf, shownPath } from './paths.ts';
import { reachableAllowedRoots, walkFiles } from './walk.ts';
import type { RuleBlockedEntry } from './walk.ts';

type OutputMode = 'content' | 'files_with_matches' | 'count';

type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: OutputMode;
  '-i'?: boolean;
  '-n'?: boolean;
  '-A'?: number;
  '-B'?: number;
  '-C'?: number;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
};

type SearchResult = { entries: string[]; unreadable: boolean };

const UNREADABLE_NOTE = '(some paths could not be read)';

const contextOf = (input: GrepInput): { before: number; after: number } => ({
  before: input['-B'] ?? input['-C'] ?? 0,
  after: input['-A'] ?? input['-C'] ?? 0,
});

const lineNumbersWanted = (input: GrepInput): boolean => input['-n'] ?? true;

const escapeGlob = (value: string): string => value.replace(/[\\[\]*?{}!]/g, '\\$&');

const exclusionOf = (target: string, excluded: string, withContents: boolean): string[] => {
  const relative = `/${escapeGlob(path.relative(target, excluded).split(path.sep).join('/'))}`;
  return withContents ? ['--glob', exclusionLine(`!${relative}`), '--glob', `${exclusionLine(`!${relative}`)}/**`] : ['--glob', exclusionLine(`!${relative}`)];
};

const deniedGlobs = async (access: ReadAccessMatcher, target: string, isDirectory: boolean): Promise<string[]> => {
  if (!isDirectory) return [];
  const globs: string[] = [];
  for (const resolved of await access.deniedWithin(target)) globs.push(...exclusionOf(target, resolved, !(await access.leadsToAllowed(resolved))));
  return globs;
};

const ruleBlockedGlobs = async (access: ReadAccessMatcher, target: string, isDirectory: boolean, ctx: ToolContext): Promise<string[]> => {
  if (!isDirectory || !access.hasReadRulesFor('Grep')) return [];
  const blocked: RuleBlockedEntry[] = [];
  const walk = walkFiles({
    root: target,
    readDenied: ctx.sandboxPolicy.readDenied,
    readAllowed: ctx.sandboxPolicy.readAllowed,
    fileRules: ctx.sandboxPolicy.fileRules,
    tool: 'Grep',
    includeSymlinkedFiles: false,
    signal: ctx.signal,
    onUnreadable: () => undefined,
    onRuleBlocked: (entry) => blocked.push(entry),
  });
  while (!(await walk.next()).done);
  return blocked.flatMap((entry) => exclusionOf(target, entry.absolute, entry.isDirectory));
};

const LINE_BREAK = /[\n\r]/;
const EDGE_WHITESPACE = /^\s|\s$/;
const LEADING_LINE_COMMENT = '#';
const NEWLINE_ONLY_CLASS = '[!\u0001-\u0009\u000b-\u{10ffff}]';

const literalClassOf = (character: string): string => `[${character}]`;

const exclusionLine = (glob: string): string => {
  const lineFree = glob.replace(/\n/g, NEWLINE_ONLY_CLASS);
  const last = [...lineFree].at(-1) as string;
  return /\s/.test(last) ? `${lineFree.slice(0, lineFree.length - last.length)}${literalClassOf(last)}` : lineFree;
};

const ESCAPED_TRAILING_SPACE = '\\ ';

const effectiveModelGlob = (glob: string): string => (glob.endsWith(ESCAPED_TRAILING_SPACE) ? glob : glob.trimEnd());

const trailingSpaceAsClass = (glob: string): string => {
  const body = glob.slice(0, -1);
  const backslashes = body.length - body.replace(/\\+$/, '').length;
  return backslashes % 2 === 1 ? `${body.slice(0, -1)}${literalClassOf(' ')}` : `${body}${literalClassOf(' ')}`;
};

const modelGlobFlags = (glob: string): string[] => {
  if (LINE_BREAK.test(glob)) throw new ToolExecutionError('glob must not contain a line break');
  const effective = effectiveModelGlob(glob);
  if (effective === '') return [];
  const lastKept = effective.endsWith(' ') ? trailingSpaceAsClass(effective) : effective;
  const [first] = lastKept;
  return ['--glob', first === LEADING_LINE_COMMENT || /\s/.test(first as string) ? `${literalClassOf(first as string)}${lastKept.slice(1)}` : lastKept];
};

const isConfigLine = (line: string): boolean => line !== '' && !LINE_BREAK.test(line) && !EDGE_WHITESPACE.test(line) && !line.startsWith(LEADING_LINE_COMMENT);

const ripgrepFlags = (input: GrepInput, mode: OutputMode, denied: readonly string[], ruleBlocked: readonly string[]): string[] => {
  const { before, after } = contextOf(input);
  return [
    '--color',
    'never',
    '--no-heading',
    '-H',
    '--hidden',
    '--glob',
    '!.git',
    '--sort',
    'path',
    '--no-require-git',
    '--no-ignore-parent',
    '--no-ignore-global',
    '--no-ignore-exclude',
    ...(mode === 'files_with_matches' ? ['-l'] : []),
    ...(mode === 'count' ? ['-c'] : []),
    '--null',
    ...(mode === 'content' ? ['-n'] : []),
    ...(mode === 'content' && before > 0 ? ['-B', String(before)] : []),
    ...(mode === 'content' && after > 0 ? ['-A', String(after)] : []),
    ...(input['-i'] === true ? ['-i'] : []),
    ...(input.multiline === true ? ['-U', '--multiline-dotall'] : []),
    ...(input.type === undefined ? [] : [...extensionsForType(input.type).flatMap((extension) => ['--type-add', `momonga:*.${extension}`]), '--type', 'momonga']),
    ...(input.glob === undefined ? [] : modelGlobFlags(input.glob)),
    ...denied,
    ...ruleBlocked,
  ];
};

const ripgrepOperands = (input: GrepInput, target: string, allowedRoots: readonly string[]): string[] => ['-e', input.pattern, '--', target, ...allowedRoots];

const configTextOf = (flags: readonly string[]): string => {
  const unfit = flags.find((line) => !isConfigLine(line));
  if (unfit !== undefined) throw new Error(`the ripgrep argument ${JSON.stringify(unfit)} cannot be one line of a ripgrep configuration file`);
  return `${flags.join('\n')}\n`;
};

const writeArgumentFile = async (file: string, text: string): Promise<void> => {
  await nodeFileSystem.mkdirPrivate(path.dirname(file));
  await nodeFileSystem.rm(file);
  const handle = await nodeFileSystem.open(file, 'wx', ARGUMENT_FILE_MODE);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
};

const ARGUMENT_FILE_MODE = 0o600;

const argumentFileOf = (ctx: ToolContext): string => path.join(momongaLayout(ctx.home).grepArguments, `${sha256Hex(ctx.idemKey)}.rgrc`);

const collect = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const lineList = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

const NUL = '\0';
const GROUP_SEPARATOR_LINE = '--\n';
const COUNT_PAYLOAD = /^\d+$/;
const CONTENT_PAYLOAD = /^(\d+)([:-])(.*)$/s;

type RipgrepRecord = { recordPath: string; payload: string } | 'separator';

const malformedRecord = (recordPath: string): ToolExecutionError => new ToolExecutionError(`ripgrep produced a malformed record for ${recordPath}`);

const nextRecord = (stdout: string, position: number, mode: OutputMode): { record: RipgrepRecord; next: number } => {
  if (mode === 'content' && stdout.startsWith(GROUP_SEPARATOR_LINE, position)) return { record: 'separator', next: position + GROUP_SEPARATOR_LINE.length };
  const nul = stdout.indexOf(NUL, position);
  if (nul === -1) throw malformedRecord(stdout.slice(position).split('\n')[0] as string);
  const recordPath = stdout.slice(position, nul);
  if (mode === 'files_with_matches') return { record: { recordPath, payload: '' }, next: nul + 1 };
  const lineEnd = stdout.indexOf('\n', nul + 1);
  const end = lineEnd === -1 ? stdout.length : lineEnd;
  return { record: { recordPath, payload: stdout.slice(nul + 1, end) }, next: end + 1 };
};

const recordsOf = async (stdout: string, mode: OutputMode, input: GrepInput, visible: (recordPath: string) => Promise<boolean>, show: (recordPath: string) => Promise<string>): Promise<string[]> => {
  const groups: string[][] = [[]];
  const entries: string[] = [];
  for (let position = 0; position < stdout.length; ) {
    const { record, next } = nextRecord(stdout, position, mode);
    position = next;
    if (record === 'separator') {
      groups.push([]);
      continue;
    }
    const { recordPath, payload } = record;
    if (mode === 'files_with_matches') {
      if (await visible(recordPath)) entries.push(recordPath);
    } else if (mode === 'count') {
      if (!COUNT_PAYLOAD.test(payload)) throw malformedRecord(await show(recordPath));
      if (await visible(recordPath)) entries.push(`${await show(recordPath)}:${payload}`);
    } else {
      const parsed = CONTENT_PAYLOAD.exec(payload);
      if (parsed === null) throw malformedRecord(await show(recordPath));
      const [, lineNumber, kind, text] = parsed as unknown as [string, string, string, string];
      if (await visible(recordPath)) {
        const shown = await show(recordPath);
        (groups[groups.length - 1] as string[]).push(lineNumbersWanted(input) ? `${shown}${kind}${lineNumber}${kind}${text}` : `${shown}${kind}${text}`);
      }
    }
  }
  if (mode !== 'content') return entries;
  return groups.filter((group) => group.length > 0).flatMap((group, index) => (index === 0 ? group : [GROUP_SEPARATOR, ...group]));
};

const GROUP_SEPARATOR = '--';

const grepPolicyOf = (ctx: ToolContext): SandboxPolicy => {
  const { readDenied, readAllowed } = ctx.sandboxPolicy;
  return { writableRoots: [], writeDenied: [], writeDeniedLiterals: [], readDenied, ...(readAllowed === undefined ? {} : { readAllowed }), network: 'deny', fileRules: ctx.sandboxPolicy.fileRules, protectedSet: EMPTY_PROTECTED_SET };
};

const RIPGREP_VERSION_LINE = /^ripgrep (\S+)/;

const reportedVersions = new WeakMap<RipgrepLocator, Map<string, Promise<string>>>();

type RipgrepCommand = { argv: string[]; cwd: string; env: Record<string, string> };

type RipgrepRun = { stdout: string; stderr: string; exit: SandboxExit };

const runRipgrep = async (ctx: ToolContext, command: RipgrepCommand, policy: SandboxPolicy, notes: string[]): Promise<RipgrepRun> => {
  const { file, fd, settle } = await requireSpawnMarker(ctx, 'Grep');
  const child = await ctx.sandbox.spawn({ ...command, markerFile: file }, policy, ctx.signal, { markerFd: fd });
  const attached = groupRecordOutcome(ctx.attachProcess({ pgid: child.pgid, startedAt: ctx.clock.now() }), file);
  const [stdout, stderr, exit, groupNotice] = await Promise.all([collect(child.stdout), collect(child.stderr), child.exited, attached]);
  if (groupNotice !== undefined) notes.push(groupNotice);
  notes.push(...(await settleFinishedCommand(settle, { pgid: child.pgid, exit, signal: ctx.signal })));
  return { stdout, stderr, exit };
};

const runVersion = async (ripgrep: string, ctx: ToolContext, notes: string[]): Promise<string> => {
  const { stdout, stderr, exit } = await runRipgrep(ctx, { argv: [ripgrep, '--version'], cwd: ctx.session.cwd, env: ctx.env }, grepPolicyOf(ctx), notes);
  const version = exit.code === 0 ? RIPGREP_VERSION_LINE.exec(stdout)?.[1] : undefined;
  if (version === undefined) throw new ToolExecutionError(`${ripgrep} --version did not report a ripgrep version: ${(stdout + stderr).trim()}`);
  return version;
};

const reportedVersionOf = (ripgrep: string, ctx: ToolContext, notes: string[]): Promise<string> => {
  let known = reportedVersions.get(ctx.ripgrep);
  if (known === undefined) {
    known = new Map();
    reportedVersions.set(ctx.ripgrep, known);
  }
  const versions = known;
  const existing = versions.get(ripgrep);
  if (existing !== undefined) return existing;
  const pending = runVersion(ripgrep, ctx, notes);
  versions.set(ripgrep, pending);
  void pending.catch(() => versions.delete(ripgrep));
  return pending;
};

const searchWithRipgrep = async (
  ripgrep: string,
  input: GrepInput,
  mode: OutputMode,
  target: string,
  isDirectory: boolean,
  ctx: ToolContext,
  notes: string[],
): Promise<SearchResult> => {
  const { readDenied, readAllowed } = ctx.sandboxPolicy;
  const access = await createReadAccessMatcher({ readDenied, readAllowed, fileRules: ctx.sandboxPolicy.fileRules }, ctx.paths);
  const allowedRoots: string[] = [];
  if (isDirectory) {
    for await (const root of reachableAllowedRoots(target, '', [], { signal: ctx.signal, onUnreadable: () => undefined }, access)) allowedRoots.push(root.absolute);
  }
  const ruleBlocked = await ruleBlockedGlobs(access, target, isDirectory, ctx);
  const argumentFile = argumentFileOf(ctx);
  const policy = grepPolicyOf(ctx);
  const spawnPolicy: SandboxPolicy = { ...policy, readAllowed: [...(policy.readAllowed ?? []), argumentFile] };
  const spawnCwd = isDirectory ? target : path.dirname(target);
  const flags = configTextOf(ripgrepFlags(input, mode, await deniedGlobs(access, target, isDirectory), ruleBlocked));
  try {
    await writeArgumentFile(argumentFile, flags);
    return await runSearch(ctx, { argv: [ripgrep, ...ripgrepOperands(input, target, allowedRoots)], cwd: spawnCwd, env: { ...ctx.env, RIPGREP_CONFIG_PATH: argumentFile } }, spawnPolicy, mode, input, access, spawnCwd, notes);
  } finally {
    await nodeFileSystem.rm(argumentFile);
  }
};

const runSearch = async (
  ctx: ToolContext,
  command: RipgrepCommand,
  policy: SandboxPolicy,
  mode: OutputMode,
  input: GrepInput,
  access: ReadAccessMatcher,
  spawnCwd: string,
  notes: string[],
): Promise<SearchResult> => {
  const visibleCache = new Map<string, boolean>();
  const visible = async (recordPath: string): Promise<boolean> => {
    let verdict = visibleCache.get(recordPath);
    if (verdict === undefined) {
      verdict = (await access.blockedBy(recordPath, spawnCwd, 'Grep')) === undefined;
      visibleCache.set(recordPath, verdict);
    }
    return verdict;
  };
  const shownCache = new Map<string, string>();
  const show = async (recordPath: string): Promise<string> => {
    let shown = shownCache.get(recordPath);
    if (shown === undefined) {
      shown = await shownPath(ctx, recordPath);
      shownCache.set(recordPath, shown);
    }
    return shown;
  };
  const { stdout, stderr, exit } = await runRipgrep(ctx, command, policy, notes);
  if (exit.code === 1 && stdout === '') return { entries: [], unreadable: false };
  if (exit.code === 0) return { entries: await recordsOf(stdout, mode, input, visible, show), unreadable: false };
  if (exit.code === 2) {
    const ioErrorsOnly = lineList(stderr).every((line) => line.includes('os error'));
    if (stdout !== '') return { entries: await recordsOf(stdout, mode, input, visible, show), unreadable: true };
    if (ioErrorsOnly) return { entries: [], unreadable: true };
  }
  const reason = exit.signal === null ? `exit code ${exit.code}` : `signal ${exit.signal}`;
  throw new ToolExecutionError(`ripgrep failed (${reason}): ${stderr.trim()}`);
};

export const grepTool = defineTool<GrepInput>({
  name: 'Grep',
  tier: 'essential',
  description:
    'Searches file contents with a regular expression (ripgrep syntax). path is a file or directory, defaults to the working directory, and a relative path is resolved against the working directory. output_mode: files_with_matches (default, newest first), content (path:line:text with optional -A/-B/-C context), or count. Respects .gitignore and .ignore, skips .git, includes dotfiles. head_limit and offset page through the output entries.',
  conciseDescription:
    'Searches file contents with a regular expression. path is a file or directory; a relative path is resolved against the working directory, which is also the default. output_mode: files_with_matches (default), content, or count. Respects .gitignore, includes dotfiles. Page with head_limit and offset.',
  conciseParameterDescriptions: {
    pattern: 'Regular expression',
    path: 'File or directory to search; a relative path is resolved against the working directory',
    glob: 'File name filter, e.g. "*.js"',
    type: 'File type, e.g. "ts"',
    '-i': 'Ignore case',
    '-n': 'Line numbers in content mode (default true)',
    '-A': 'Lines after each match',
    '-B': 'Lines before each match',
    '-C': 'Lines before and after each match',
    head_limit: 'Max entries (0 is unlimited)',
    offset: 'Entries to skip first',
    multiline: 'Match across lines',
  },
  kind: 'search',
  sideEffect: 'read_only',
  startsProcesses: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', minLength: 1, description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search; a relative path is resolved against the working directory; defaults to the working directory' },
      glob: { type: 'string', description: 'Glob filter for file names, for example "*.js"' },
      type: { type: 'string', description: 'File type filter, for example "ts" or "py"' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      '-i': { type: 'boolean', description: 'Case-insensitive search' },
      '-n': { type: 'boolean', description: 'Show line numbers in content mode (default true)' },
      '-A': { type: 'integer', minimum: 0, description: 'Lines of context after each match' },
      '-B': { type: 'integer', minimum: 0, description: 'Lines of context before each match' },
      '-C': { type: 'integer', minimum: 0, description: 'Lines of context before and after each match' },
      head_limit: { type: 'integer', minimum: 0, description: 'Return at most this many output entries (0 means unlimited)' },
      offset: { type: 'integer', minimum: 0, description: 'Skip this many output entries first' },
      multiline: { type: 'boolean', description: 'Let patterns match across lines' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  timeoutMs: 60_000,
  title: (input) => `Grep ${input.pattern}`,
  locations: (input, ctx) => [{ path: resolvedPathOf(ctx, input.path ?? '.') }],
  subject: (input, ctx) => {
    if (input.type !== undefined) extensionsForType(input.type);
    return { kind: 'path', tool: 'Grep', paths: [resolvedPathOf(ctx, input.path ?? '.')], access: 'read' };
  },
  execute: async (input, ctx) => {
    const target = await canonicalPathOf(ctx, 'path', input.path ?? '.');
    const shown = await shownPath(ctx, resolvedPathOf(ctx, input.path ?? '.'));
    const stat = await statIfExists(target);
    if (stat === undefined) throw new ToolExecutionError(`Path does not exist: ${shown}`);
    const problem = stat.isDirectory() ? undefined : regularFileProblem(stat, shown);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    const mode = input.output_mode ?? 'files_with_matches';
    const ripgrep = await ctx.ripgrep.locate(ctx.signal);
    if (!ripgrep.ok) throw new ToolExecutionError(ripgrepUnavailableMessage(ripgrep.cause));
    let found: SearchResult;
    let backend: ToolBackend;
    const notes: string[] = [];
    try {
      backend = { source: ripgrep.source, version: ripgrep.version ?? (await reportedVersionOf(ripgrep.path, ctx, notes)) };
      found = await searchWithRipgrep(ripgrep.path, input, mode, target, stat.isDirectory(), ctx, notes);
    } finally {
      await ripgrep.release();
    }
    const ordered = mode === 'files_with_matches' ? await mapAsync(await sortByMtimeThenPath(found.entries), (file) => shownPath(ctx, file)) : found.entries;
    const skipped = ordered.slice(input.offset ?? 0);
    const limited = input.head_limit === undefined || input.head_limit === 0 ? skipped : skipped.slice(0, input.head_limit);
    const lines = limited.length === 0 ? ['No matches found'] : limited;
    return { status: 'completed', output: [...lines, ...(found.unreadable ? [UNREADABLE_NOTE] : []), ...notes].join('\n'), backend };
  },
});
