import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type { SandboxPolicy } from '@momonga/sandbox';
import { createReadAccessMatcher } from '../read-access.ts';
import type { ReadAccessMatcher } from '../read-access.ts';
import { defineTool, ToolExecutionError } from '../types.ts';
import type { ToolContext } from '../types.ts';
import { extensionsForType } from './file-types.ts';
import { looksBinary, regularFileProblem, statIfExists } from './files.ts';
import { sortByMtimeThenPath } from './glob.ts';
import { canonicalPathOf, requireAbsolute } from './paths.ts';
import { isPermissionError, reachableAllowedRoots, walkFiles } from './walk.ts';

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

const resolveRipgrep = (envPath: string | undefined): string | undefined => {
  for (const directory of (envPath ?? '').split(path.delimiter)) {
    if (directory === '') continue;
    const candidate = path.join(directory, 'rg');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
    }
  }
  return undefined;
};

const escapeGlob = (value: string): string => value.replace(/[\\[\]*?{}!]/g, '\\$&');

const deniedGlobs = (access: ReadAccessMatcher, target: string, isDirectory: boolean): string[] => {
  if (!isDirectory) return [];
  return access.deniedWithin(target).flatMap((resolved) => {
    const relative = escapeGlob(path.relative(target, resolved));
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

const recordsOf = (stdout: string, mode: OutputMode, input: GrepInput, visible: (recordPath: string) => boolean): string[] => {
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
      if (!COUNT_PAYLOAD.test(payload)) throw malformedRecord(recordPath);
      if (visible(recordPath)) entries.push(`${recordPath}:${payload}`);
    } else {
      const parsed = CONTENT_PAYLOAD.exec(payload);
      if (parsed === null) throw malformedRecord(recordPath);
      const [, lineNumber, kind, text] = parsed as unknown as [string, string, string, string];
      if (visible(recordPath)) (groups[groups.length - 1] as string[]).push(lineNumbersWanted(input) ? `${recordPath}${kind}${lineNumber}${kind}${text}` : `${recordPath}${kind}${text}`);
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
  const [stdout, stderr, exit] = await Promise.all([collect(child.stdout), collect(child.stderr), child.exited]);
  if (exit.code === 1 && stdout === '') return { entries: [], unreadable: false };
  if (exit.code === 0) return { entries: recordsOf(stdout, mode, input, visible), unreadable: false };
  if (exit.code === 2) {
    const ioErrorsOnly = lineList(stderr).every((line) => line.includes('os error'));
    if (stdout !== '') return { entries: recordsOf(stdout, mode, input, visible), unreadable: true };
    if (ioErrorsOnly) return { entries: [], unreadable: true };
  }
  const reason = exit.signal === null ? `exit code ${exit.code}` : `signal ${exit.signal}`;
  throw new ToolExecutionError(`ripgrep failed (${reason}): ${stderr.trim()}`);
};

const matchedLineNumbers = (text: string, lines: readonly string[], expression: RegExp, multiline: boolean): number[] => {
  if (!multiline) {
    const hits: number[] = [];
    lines.forEach((line, index) => {
      if (expression.test(line)) hits.push(index + 1);
    });
    return hits;
  }
  const lineStarts: number[] = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lineStarts.push(index + 1);
  const lineOf = (position: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] as number) <= position) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const hits = new Set<number>();
  for (const match of text.matchAll(expression)) {
    const first = lineOf(match.index);
    const endPosition = match[0].length === 0 ? match.index : match.index + match[0].length - 1;
    const last = Math.min(lineOf(endPosition), lines.length);
    for (let line = first; line <= last; line += 1) hits.add(line);
  }
  return [...hits].sort((left, right) => left - right);
};

const contentLines = (
  file: string,
  lines: readonly string[],
  hits: readonly number[],
  input: GrepInput,
): Array<{ lineNumber: number; text: string }> => {
  const { before, after } = contextOf(input);
  const withNumbers = lineNumbersWanted(input);
  const hitSet = new Set(hits);
  const shown = new Set<number>();
  for (const hit of hits) {
    for (let line = Math.max(1, hit - before); line <= Math.min(lines.length, hit + after); line += 1) shown.add(line);
  }
  return [...shown]
    .sort((left, right) => left - right)
    .map((lineNumber) => {
      const separator = hitSet.has(lineNumber) ? ':' : '-';
      const text = lines[lineNumber - 1] as string;
      return { lineNumber, text: withNumbers ? `${file}${separator}${lineNumber}${separator}${text}` : `${file}${separator}${text}` };
    });
};

const splitGroups = (shown: ReadonlyArray<{ lineNumber: number; text: string }>): string[][] => {
  const groups: string[][] = [];
  let previous = -1;
  for (const line of shown) {
    if (previous === -1 || line.lineNumber !== previous + 1) groups.push([]);
    (groups[groups.length - 1] as string[]).push(line.text);
    previous = line.lineNumber;
  }
  return groups;
};

const searchWithJavaScript = async (input: GrepInput, mode: OutputMode, target: string, isDirectory: boolean, ctx: ToolContext): Promise<SearchResult> => {
  const multiline = input.multiline === true;
  let expression: RegExp;
  try {
    expression = new RegExp(input.pattern, `${input['-i'] === true ? 'i' : ''}m${multiline ? 'gs' : ''}`);
  } catch (error) {
    throw new ToolExecutionError(`Invalid regular expression: ${(error as Error).message}`);
  }
  const extensions = input.type === undefined ? undefined : extensionsForType(input.type);
  const globMatch = input.glob === undefined ? undefined : picomatch(input.glob, { dot: true, basename: true });
  const { before, after } = contextOf(input);
  const withContext = mode === 'content' && (before > 0 || after > 0);

  let unreadable = false;
  const candidates: string[] = [];
  if (isDirectory) {
    for await (const entry of walkFiles({
      root: target,
      readDenied: ctx.sandboxPolicy.readDenied,
      readAllowed: ctx.sandboxPolicy.readAllowed,
      fileRules: ctx.sandboxPolicy.fileRules,
      tool: 'Grep',
      includeSymlinkedFiles: false,
      signal: ctx.signal,
      onUnreadable: () => void (unreadable = true),
    })) {
      const extension = path.extname(entry.relative).slice(1);
      if (extensions !== undefined && !extensions.includes(extension)) continue;
      if (globMatch !== undefined && !globMatch(entry.relative)) continue;
      candidates.push(entry.absolute);
    }
  } else {
    candidates.push(target);
  }

  const files: string[] = [];
  const groups: string[][] = [];
  const entries: string[] = [];
  for (const file of candidates) {
    ctx.signal.throwIfAborted();
    let text: string;
    try {
      if (await looksBinary(file)) continue;
      text = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      unreadable = true;
      continue;
    }
    const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
    const hits = matchedLineNumbers(text, lines, expression, multiline);
    if (hits.length === 0) continue;
    if (mode === 'files_with_matches') files.push(file);
    else if (mode === 'count') entries.push(`${file}:${hits.length}`);
    else groups.push(...splitGroups(contentLines(file, lines, hits, input)));
  }

  if (mode === 'files_with_matches') return { entries: await sortByMtimeThenPath(files), unreadable };
  if (mode === 'count') return { entries, unreadable };
  const joined: string[] = [];
  groups.forEach((group, index) => {
    if (index > 0 && withContext) joined.push('--');
    joined.push(...group);
  });
  return { entries: joined, unreadable };
};

export const grepTool = defineTool<GrepInput>({
  name: 'Grep',
  tier: 'essential',
  description:
    'Searches file contents with a regular expression (ripgrep syntax when available). path is an absolute file or directory and defaults to the current working directory. output_mode: files_with_matches (default, newest first), content (path:line:text with optional -A/-B/-C context), or count. Respects .gitignore and .ignore, skips .git, includes dotfiles. head_limit and offset page through the output entries.',
  kind: 'search',
  sideEffect: 'read_only',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', minLength: 1, description: 'Regular expression to search for' },
      path: { type: 'string', description: 'Absolute file or directory to search; defaults to the current working directory' },
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
  locations: (input) => [{ path: input.path ?? '.' }],
  subject: (input, ctx) => {
    if (input.type !== undefined) extensionsForType(input.type);
    return { kind: 'path', tool: 'Grep', paths: [requireAbsolute('path', input.path ?? ctx.cwd)], access: 'read' };
  },
  execute: async (input, ctx) => {
    const target = canonicalPathOf('path', input.path ?? ctx.session.cwd);
    const stat = await statIfExists(target);
    if (stat === undefined) throw new ToolExecutionError(`Path does not exist: ${target}`);
    const problem = stat.isDirectory() ? undefined : regularFileProblem(stat, target);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    const mode = input.output_mode ?? 'files_with_matches';
    const ripgrep = resolveRipgrep(ctx.env['PATH']);
    const found =
      ripgrep === undefined
        ? await searchWithJavaScript(input, mode, target, stat.isDirectory(), ctx)
        : await searchWithRipgrep(ripgrep, input, mode, target, stat.isDirectory(), ctx);
    const ordered = mode === 'files_with_matches' && ripgrep !== undefined ? await sortByMtimeThenPath(found.entries) : found.entries;
    const skipped = ordered.slice(input.offset ?? 0);
    const limited = input.head_limit === undefined || input.head_limit === 0 ? skipped : skipped.slice(0, input.head_limit);
    const lines = limited.length === 0 ? ['No matches found'] : limited;
    return { status: 'completed', output: [...lines, ...(found.unreadable ? [UNREADABLE_NOTE] : [])].join('\n') };
  },
});
