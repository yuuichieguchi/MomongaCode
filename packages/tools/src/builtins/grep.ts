import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import path from 'node:path';
import type { SandboxPolicy } from '@momonga/sandbox';
import { createReadAccessMatcher } from '../read-access.ts';
import { ripgrepUnavailableMessage } from '../ripgrep-locator.ts';
import type { ReadAccessMatcher } from '../read-access.ts';
import { defineTool, ToolExecutionError } from '../types.ts';
import type { ToolContext } from '../types.ts';
import { extensionsForType } from './file-types.ts';
import { regularFileProblem, statIfExists } from './files.ts';
import { sortByMtimeThenPath } from './glob.ts';
import { canonicalPathOf, resolvedPathOf, shownPath } from './paths.ts';
import { reachableAllowedRoots } from './walk.ts';

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

const deniedGlobs = (access: ReadAccessMatcher, target: string, isDirectory: boolean): string[] => {
  if (!isDirectory) return [];
  return access.deniedWithin(target).flatMap((resolved) => {
    const relative = `/${escapeGlob(path.relative(target, resolved).split(path.sep).join('/'))}`;
    return access.leadsToAllowed(resolved) ? ['--glob', `!${relative}`] : ['--glob', `!${relative}`, '--glob', `!${relative}/**`];
  });
};

const ripgrepArguments = (input: GrepInput, mode: OutputMode, target: string, access: ReadAccessMatcher, isDirectory: boolean, allowedRoots: readonly string[]): string[] => {
  const { before, after } = contextOf(input);
  return [
    '--no-config',
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
    ...(input.glob === undefined ? [] : ['--glob', input.glob]),
    ...deniedGlobs(access, target, isDirectory),
    '-e',
    input.pattern,
    '--',
    target,
    ...allowedRoots,
  ];
};

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

const recordsOf = (stdout: string, mode: OutputMode, input: GrepInput, visible: (recordPath: string) => boolean, show: (recordPath: string) => string): string[] => {
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
      if (visible(recordPath)) entries.push(recordPath);
    } else if (mode === 'count') {
      if (!COUNT_PAYLOAD.test(payload)) throw malformedRecord(show(recordPath));
      if (visible(recordPath)) entries.push(`${show(recordPath)}:${payload}`);
    } else {
      const parsed = CONTENT_PAYLOAD.exec(payload);
      if (parsed === null) throw malformedRecord(show(recordPath));
      const [, lineNumber, kind, text] = parsed as unknown as [string, string, string, string];
      if (visible(recordPath)) (groups[groups.length - 1] as string[]).push(lineNumbersWanted(input) ? `${show(recordPath)}${kind}${lineNumber}${kind}${text}` : `${show(recordPath)}${kind}${text}`);
    }
  }
  if (mode !== 'content') return entries;
  return groups.filter((group) => group.length > 0).flatMap((group, index) => (index === 0 ? group : [GROUP_SEPARATOR, ...group]));
};

const GROUP_SEPARATOR = '--';

const searchWithRipgrep = async (
  ripgrep: string,
  input: GrepInput,
  mode: OutputMode,
  target: string,
  isDirectory: boolean,
  ctx: ToolContext,
): Promise<SearchResult> => {
  const { readDenied, readAllowed } = ctx.sandboxPolicy;
  const access = createReadAccessMatcher({ readDenied, readAllowed, fileRules: ctx.sandboxPolicy.fileRules });
  const allowedRoots: string[] = [];
  if (isDirectory) {
    for await (const root of reachableAllowedRoots(target, '', [], { signal: ctx.signal, onUnreadable: () => undefined }, access)) allowedRoots.push(root.absolute);
  }
  const policy: SandboxPolicy = { writableRoots: [], writeDenied: [], writeDeniedLiterals: [], readDenied, ...(readAllowed === undefined ? {} : { readAllowed }), network: 'deny', fileRules: ctx.sandboxPolicy.fileRules, protectedSet: EMPTY_PROTECTED_SET };
  const spawnCwd = isDirectory ? target : path.dirname(target);
  const child = ctx.sandbox.spawn({ argv: [ripgrep, ...ripgrepArguments(input, mode, target, access, isDirectory, allowedRoots)], cwd: spawnCwd, env: ctx.env }, policy, ctx.signal);
  const visibleCache = new Map<string, boolean>();
  const visible = (recordPath: string): boolean => {
    let verdict = visibleCache.get(recordPath);
    if (verdict === undefined) {
      verdict = access.blockedBy(recordPath, spawnCwd, 'Grep') === undefined;
      visibleCache.set(recordPath, verdict);
    }
    return verdict;
  };
  const shownCache = new Map<string, string>();
  const show = (recordPath: string): string => {
    let shown = shownCache.get(recordPath);
    if (shown === undefined) {
      shown = shownPath(ctx, recordPath);
      shownCache.set(recordPath, shown);
    }
    return shown;
  };
  const [stdout, stderr, exit] = await Promise.all([collect(child.stdout), collect(child.stderr), child.exited]);
  if (exit.code === 1 && stdout === '') return { entries: [], unreadable: false };
  if (exit.code === 0) return { entries: recordsOf(stdout, mode, input, visible, show), unreadable: false };
  if (exit.code === 2) {
    const ioErrorsOnly = lineList(stderr).every((line) => line.includes('os error'));
    if (stdout !== '') return { entries: recordsOf(stdout, mode, input, visible, show), unreadable: true };
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
    const target = canonicalPathOf(ctx, 'path', input.path ?? '.');
    const shown = shownPath(ctx, resolvedPathOf(ctx, input.path ?? '.'));
    const stat = await statIfExists(target);
    if (stat === undefined) throw new ToolExecutionError(`Path does not exist: ${shown}`);
    const problem = stat.isDirectory() ? undefined : regularFileProblem(stat, shown);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    const mode = input.output_mode ?? 'files_with_matches';
    const ripgrep = await ctx.ripgrep.locate();
    if (!ripgrep.ok) throw new ToolExecutionError(ripgrepUnavailableMessage(ripgrep.cause));
    let found: SearchResult;
    try {
      found = await searchWithRipgrep(ripgrep.path, input, mode, target, stat.isDirectory(), ctx);
    } finally {
      await ripgrep.release();
    }
    const ordered = mode === 'files_with_matches' ? (await sortByMtimeThenPath(found.entries)).map((file) => shownPath(ctx, file)) : found.entries;
    const skipped = ordered.slice(input.offset ?? 0);
    const limited = input.head_limit === undefined || input.head_limit === 0 ? skipped : skipped.slice(0, input.head_limit);
    const lines = limited.length === 0 ? ['No matches found'] : limited;
    return { status: 'completed', output: [...lines, ...(found.unreadable ? [UNREADABLE_NOTE] : [])].join('\n') };
  },
});
