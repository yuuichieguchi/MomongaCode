import { defineTool, ToolExecutionError, ToolInputError } from '../types.ts';
import { READ_TOOL_NAME } from '@momonga/protocol';
import type { ToolContext, ToolResult } from '../types.ts';
import type { ReadHandle } from '@momonga/foundation';
import { NotUtf8Error, filesOfHandle, handleLooksBinary, isLinkRefusal, isMissing, openWithoutFollowing, recordInLedger, regularFileProblem, scanLines } from './files.ts';
import { pageToFit } from '../paging.ts';
import { DEFAULT_LINE_LIMIT, MAX_LINE_CHARS, pageNumberedLines, pastEndMessage } from './format.ts';
import { accessedPathOf, resolvedPathOf, shownPath } from './paths.ts';

type ReadInput = { file_path: string; offset?: number; limit?: number };

export const readTool = defineTool<ReadInput>({
  name: READ_TOOL_NAME,
  tier: 'essential',
  description: `Reads a text file from the filesystem. file_path may be absolute or relative; a relative path is resolved against the working directory. Returns at most ${DEFAULT_LINE_LIMIT} lines by default in cat -n format; use offset (1-based line) and limit to page through large files. Lines longer than ${MAX_LINE_CHARS} characters are cut. Binary files and files that are not UTF-8 text are refused.`,
  conciseDescription: `Reads a text file. A relative file_path is resolved against the working directory. Returns up to ${DEFAULT_LINE_LIMIT} lines (cat -n); page with offset and limit. Binary files are refused.`,
  conciseParameterDescriptions: {
    file_path: 'File to read; a relative path is resolved against the working directory',
    offset: 'First line, 1-based',
    limit: 'Number of lines',
  },
  kind: 'read',
  sideEffect: 'read_only',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to read; a relative path is resolved against the working directory' },
      offset: { type: 'integer', minimum: 1, description: 'Line number to start reading from (1-based)' },
      limit: { type: 'integer', minimum: 1, description: 'Number of lines to read' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  pagesOutput: true,
  timeoutMs: 30_000,
  title: async (input, ctx) => `Read ${await shownPath(ctx, await accessedPathOf(ctx, input.file_path))}`,
  locations: (input, ctx) => [{ path: resolvedPathOf(ctx, input.file_path), ...(input.offset === undefined ? {} : { line: input.offset }) }],
  subject: (input, ctx) => ({ kind: 'path', tool: READ_TOOL_NAME, paths: [resolvedPathOf(ctx, input.file_path)], access: 'read' }),
  execute: async (input, ctx) => {
    const shown = await shownPath(ctx, resolvedPathOf(ctx, input.file_path));
    const canonical = ctx.decidedPaths?.[0];
    if (canonical === undefined) throw new ToolInputError(`file_path cannot be resolved to a real location: ${shown}`);
    let handle: ReadHandle;
    try {
      handle = await openWithoutFollowing(ctx.files, canonical);
    } catch (error) {
      if (isMissing(error)) throw new ToolExecutionError(`File does not exist: ${shown}`);
      if (isLinkRefusal(error)) throw new ToolExecutionError(`${shown} became a link after its read was decided, so it is not read; retry the call`);
      throw error;
    }
    try {
      return await readThrough(handle, canonical, shown, input, ctx);
    } finally {
      await handle.close();
    }
  },
});

const readThrough = async (handle: ReadHandle, canonical: string, shown: string, input: ReadInput, ctx: ToolContext): Promise<ToolResult> => {
  const stat = await handle.stat();
  if (stat.isDirectory()) {
    throw new ToolExecutionError(`${shown} is a directory, not a file; use Glob to find files or Bash with ls to list it`);
  }
  const problem = regularFileProblem(stat, shown);
  if (problem !== undefined) throw new ToolExecutionError(problem);
  if (await handleLooksBinary(handle)) {
    throw new ToolExecutionError(`${shown} is a binary file (${stat.size} bytes) and cannot be read as text`);
  }
  const offset = input.offset ?? 1;
  const lastLine = offset + (input.limit ?? DEFAULT_LINE_LIMIT) - 1;
  const selected: string[] = [];
  const scan = await scanLines(
    filesOfHandle(handle),
    canonical,
    (line, lineNumber) => {
      if (lineNumber >= offset && lineNumber <= lastLine) selected.push(line);
    },
    ctx.signal,
  ).catch((error: unknown) => {
    if (error instanceof NotUtf8Error) throw new ToolExecutionError(`${shown} is not UTF-8 text (${stat.size} bytes) and cannot be read as text; its encoding is not guessed`);
    throw error;
  });
  await recordInLedger(ctx.files, ctx.session, canonical, scan.sha256);
  const files = [{ path: canonical, sha256: scan.sha256, access: 'read' as const }];
  if (scan.totalLines === 0) return { status: 'completed', output: '(file is empty)', files };
  if (offset > scan.totalLines) return { status: 'completed', output: pastEndMessage(offset, 'file', scan.totalLines), files };
  return { status: 'completed', output: await pageToFit(ctx.outputFit, (budget) => pageNumberedLines(selected, offset, scan.totalLines, budget)), files };
};
