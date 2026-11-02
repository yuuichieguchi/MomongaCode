import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { defineTool, ToolExecutionError } from '../types.ts';
import { statIfExists } from './files.ts';
import { canonicalPathOf, requireAbsolute } from './paths.ts';
import { walkFiles } from './walk.ts';

type GlobInput = { pattern: string; path?: string };

const MAX_RESULTS = 100;
const TRUNCATION_NOTICE = '(Results are truncated. Consider a more specific path or pattern.)';

export const sortByMtimeThenPath = async (files: readonly string[]): Promise<string[]> => {
  const stamped = await Promise.all(files.map(async (file) => ({ file, mtimeMs: (await fs.promises.stat(file)).mtimeMs })));
  return stamped.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)).map((entry) => entry.file);
};

export const globTool = defineTool<GlobInput>({
  name: 'Glob',
  tier: 'essential',
  description:
    'Finds files by glob pattern (for example "**/*.ts"), matched relative to path. path defaults to the current working directory and must be an absolute directory. Respects .gitignore and .ignore, skips .git, includes dotfiles. Returns absolute paths, newest first, at most 100.',
  kind: 'search',
  sideEffect: 'read_only',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', minLength: 1, description: 'Glob pattern to match files against' },
      path: { type: 'string', description: 'Absolute directory to search; defaults to the current working directory' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  timeoutMs: 60_000,
  title: (input) => `Glob ${input.pattern}`,
  subject: (input, ctx) => ({
    kind: 'path',
    tool: 'Glob',
    paths: [requireAbsolute('path', input.path ?? ctx.cwd)],
    access: 'read',
  }),
  execute: async (input, ctx) => {
    const root = canonicalPathOf('path', input.path ?? ctx.session.cwd);
    const stat = await statIfExists(root);
    if (stat === undefined) throw new ToolExecutionError(`Directory does not exist: ${root}`);
    if (!stat.isDirectory()) throw new ToolExecutionError(`${root} is not a directory`);
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
    })) {
      if (isMatch(entry.relative)) matches.push(path.join(root, entry.relative));
    }
    if (matches.length === 0) return { status: 'completed', output: 'No files found' };
    const sorted = await sortByMtimeThenPath(matches);
    const shown = sorted.slice(0, MAX_RESULTS);
    return { status: 'completed', output: [...shown, ...(sorted.length > MAX_RESULTS ? [TRUNCATION_NOTICE] : [])].join('\n') };
  },
});
