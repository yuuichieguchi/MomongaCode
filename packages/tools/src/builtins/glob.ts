import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { mapAsync } from '@momonga/foundation';
import { defineTool, ToolExecutionError } from '../types.ts';
import { statIfExists } from './files.ts';
import { canonicalPathOf, resolvedPathOf, shownPath } from './paths.ts';
import { walkFiles } from './walk.ts';

type GlobInput = { pattern: string; path?: string };

export const MAX_GLOB_RESULTS = 100;
const TRUNCATION_NOTICE = '(Results are truncated. Consider a more specific path or pattern.)';

export const sortByMtimeThenPath = async (files: readonly string[]): Promise<string[]> => {
  const stamped = await Promise.all(files.map(async (file) => ({ file, mtimeMs: (await fs.promises.stat(file)).mtimeMs })));
  return stamped.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)).map((entry) => entry.file);
};

export const globTool = defineTool<GlobInput>({
  name: 'Glob',
  tier: 'essential',
  description: `Finds files by glob pattern (for example "**/*.ts"), matched relative to path. path is a directory, defaults to the working directory, and a relative path is resolved against the working directory. Respects .gitignore and .ignore, skips .git, includes dotfiles. Returns paths relative to the working directory when inside it and absolute otherwise, newest first, at most ${MAX_GLOB_RESULTS}.`,
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
  timeoutMs: 60_000,
  title: (input) => `Glob ${input.pattern}`,
  locations: (input, ctx) => [{ path: resolvedPathOf(ctx, input.path ?? '.') }],
  subject: (input, ctx) => ({
    kind: 'path',
    tool: 'Glob',
    paths: [resolvedPathOf(ctx, input.path ?? '.')],
    access: 'read',
  }),
  execute: async (input, ctx) => {
    const root = await canonicalPathOf(ctx, 'path', input.path ?? '.');
    const shown = await shownPath(ctx, resolvedPathOf(ctx, input.path ?? '.'));
    const stat = await statIfExists(root);
    if (stat === undefined) throw new ToolExecutionError(`Directory does not exist: ${shown}`);
    if (!stat.isDirectory()) throw new ToolExecutionError(`${shown} is not a directory`);
    const isMatch = picomatch(input.pattern, { dot: true });
    const matches: string[] = [];
    for await (const entry of walkFiles({
      root,
      readDenied: ctx.sandboxPolicy.readDenied,
      readAllowed: ctx.sandboxPolicy.readAllowed,
      fileRules: ctx.sandboxPolicy.fileRules,
      tool: 'Glob',
      includeSymlinkedFiles: true,
      signal: ctx.signal,
      onUnreadable: () => undefined,
      onRuleBlocked: () => undefined,
    })) {
      if (isMatch(entry.relative)) matches.push(path.join(root, entry.relative));
    }
    if (matches.length === 0) return { status: 'completed', output: 'No files found' };
    const sorted = await sortByMtimeThenPath(matches);
    const listed = await mapAsync(sorted.slice(0, MAX_GLOB_RESULTS), (file) => shownPath(ctx, file));
    return { status: 'completed', output: [...listed, ...(sorted.length > MAX_GLOB_RESULTS ? [TRUNCATION_NOTICE] : [])].join('\n') };
  },
});
