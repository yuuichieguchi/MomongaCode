import path from 'node:path';
import { GLOB_TOOL_NAME } from '@momonga/protocol';
import { compileGlob, mapAsync } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { defineTool, ToolExecutionError } from '../types.ts';
import { statIfExists } from './files.ts';
import { canonicalPathOf, resolvedPathOf, shownPath } from './paths.ts';
import { partialSearchNote } from './grep.ts';
import { walkFiles } from './walk.ts';

type GlobInput = { pattern: string; path?: string };

export const MAX_GLOB_RESULTS = 100;
const TRUNCATION_NOTICE = '(Results are truncated. Consider a more specific path or pattern.)';

export const sortByMtimeThenPath = async (host: Pick<FileSystem, 'stat'>, files: readonly string[]): Promise<string[]> => {
  const stamped = await Promise.all(files.map(async (file) => ({ file, mtimeMs: (await host.stat(file)).mtimeMs })));
  return stamped.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)).map((entry) => entry.file);
};

export const globTool = defineTool<GlobInput>({
  name: GLOB_TOOL_NAME,
  tier: 'essential',
  description: `Finds files by glob pattern (for example "**/*.ts"), matched relative to path. path is a directory, defaults to the working directory, and a relative path is resolved against the working directory. Respects .gitignore and .ignore, skips .git, includes dotfiles. Returns paths relative to the working directory when inside it and absolute otherwise, newest first, at most ${MAX_GLOB_RESULTS}. Supported syntax: *, **, ?, [...] and {a,b}; extglob groups, parentheses, | and a leading ! are refused.`,
  conciseDescription: `Finds files by glob pattern, for example "**/*.ts", under path. A relative path is resolved against the working directory, which is also the default. Respects .gitignore, includes dotfiles. Newest first, at most ${MAX_GLOB_RESULTS}.`,
  conciseParameterDescriptions: {
    pattern: 'Glob pattern',
    path: 'Directory to search; a relative path is resolved against the working directory',
  },
  kind: 'search',
  sideEffect: 'read_only',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', minLength: 1, description: 'Glob pattern to match files against' },
      path: { type: 'string', description: 'Directory to search; a relative path is resolved against the working directory; defaults to the working directory' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  timeoutMs: (_input, limits) => limits.search.timeoutMs,
  expiry: 'detach',
  title: (input) => `Glob ${input.pattern}`,
  locations: (input, ctx) => [{ path: resolvedPathOf(ctx, input.path ?? '.') }],
  subject: (input, ctx) => ({
    kind: 'path',
    tool: GLOB_TOOL_NAME,
    paths: [resolvedPathOf(ctx, input.path ?? '.')],
    access: 'read',
  }),
  execute: async (input, ctx) => {
    if (path.isAbsolute(input.pattern)) throw new ToolExecutionError(`The pattern ${input.pattern} is absolute; use a pattern relative to the search root, and name the root with path.`);
    const glob = compileGlob(input.pattern);
    if (glob.kind === 'refused') throw new ToolExecutionError(`The pattern ${input.pattern} uses ${glob.unsupported}, which Glob does not support; use plain globs: *, **, ?, [...], {a,b}.`);
    const root = await canonicalPathOf(ctx, 'path', input.path ?? '.');
    const shown = await shownPath(ctx, resolvedPathOf(ctx, input.path ?? '.'));
    const stat = await statIfExists(ctx.files, root);
    if (stat === undefined) throw new ToolExecutionError(`Directory does not exist: ${shown}`);
    if (!stat.isDirectory()) throw new ToolExecutionError(`${shown} is not a directory`);
    const matches: string[] = [];
    const walking = AbortSignal.any([ctx.signal, ctx.expired]);
    const entries = walkFiles({
      files: ctx.files,
      root,
      readDenied: ctx.sandboxPolicy.readDenied,
      readAllowed: ctx.sandboxPolicy.readAllowed,
      fileRules: ctx.sandboxPolicy.fileRules,
      tool: GLOB_TOOL_NAME,
      includeSymlinkedFiles: true,
      signal: walking,
      onUnreadable: () => undefined,
      onRuleBlocked: () => undefined,
    })[Symbol.asyncIterator]();
    const expired = new Promise<'expired'>((resolve) => {
      if (walking.aborted) resolve('expired');
      else walking.addEventListener('abort', () => resolve('expired'), { once: true });
    });
    for (;;) {
      const pending = entries.next();
      const next = await Promise.race([pending, expired]);
      if (next === 'expired') {
        void pending.then(undefined, (error: unknown) => {
          if (!walking.aborted) throw error;
        });
        break;
      }
      if (next.done === true) break;
      if (glob.matches(next.value.relative)) matches.push(path.join(root, next.value.relative));
    }
    ctx.signal.throwIfAborted();
    const partial = ctx.expired.aborted ? [partialSearchNote(ctx.limits.search.timeoutMs, 'entries')] : [];
    if (matches.length === 0) return { status: 'completed', output: 'No files found', ...(partial.length === 0 ? {} : { notes: partial }) };
    const sorted = await sortByMtimeThenPath(ctx.files, matches);
    const listed = await mapAsync(sorted.slice(0, MAX_GLOB_RESULTS), (file) => shownPath(ctx, file));
    const notes = [...(sorted.length > MAX_GLOB_RESULTS ? [TRUNCATION_NOTICE] : []), ...partial];
    return { status: 'completed', output: listed.join('\n'), ...(notes.length === 0 ? {} : { notes }) };
  },
});
