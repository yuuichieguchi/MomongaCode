import { defineTool, ToolExecutionError } from '../types.ts';
import { looksBinary, recordInLedger, regularFileProblem, scanLines, statIfExists } from './files.ts';
import { pageToFit } from '../paging.ts';
import { DEFAULT_LINE_LIMIT, MAX_LINE_CHARS, pageNumberedLines, pastEndMessage } from './format.ts';
import { accessedPathOf, canonicalPathOf, resolvedPathOf, shownPath } from './paths.ts';

type ReadInput = { file_path: string; offset?: number; limit?: number };

export const readTool = defineTool<ReadInput>({
  name: 'Read',
  tier: 'essential',
  description: `Reads a text file from the filesystem. file_path may be absolute or relative; a relative path is resolved against the working directory. Returns at most ${DEFAULT_LINE_LIMIT} lines by default in cat -n format; use offset (1-based line) and limit to page through large files. Lines longer than ${MAX_LINE_CHARS} characters are cut. Binary files are refused.`,
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
  title: (input, ctx) => `Read ${shownPath(ctx, accessedPathOf(ctx, input.file_path))}`,
  locations: (input, ctx) => [{ path: resolvedPathOf(ctx, input.file_path), ...(input.offset === undefined ? {} : { line: input.offset }) }],
  subject: (input, ctx) => ({ kind: 'path', tool: 'Read', paths: [resolvedPathOf(ctx, input.file_path)], access: 'read' }),
  execute: async (input, ctx) => {
    const canonical = canonicalPathOf(ctx, 'file_path', input.file_path);
    const shown = shownPath(ctx, resolvedPathOf(ctx, input.file_path));
    const stat = await statIfExists(canonical);
    if (stat === undefined) throw new ToolExecutionError(`File does not exist: ${shown}`);
    if (stat.isDirectory()) {
      throw new ToolExecutionError(`${shown} is a directory, not a file; use Glob to find files or Bash with ls to list it`);
    }
    const problem = regularFileProblem(stat, shown);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    if (await looksBinary(canonical)) {
      throw new ToolExecutionError(`${shown} is a binary file (${stat.size} bytes) and cannot be read as text`);
    }
    const offset = input.offset ?? 1;
    const lastLine = offset + (input.limit ?? DEFAULT_LINE_LIMIT) - 1;
    const selected: string[] = [];
    const scan = await scanLines(
      canonical,
      (line, lineNumber) => {
        if (lineNumber >= offset && lineNumber <= lastLine) selected.push(line);
      },
      ctx.signal,
    );
    await recordInLedger(ctx.session, canonical, scan.sha256);
    const files = [{ path: canonical, sha256: scan.sha256, access: 'read' as const }];
    if (scan.totalLines === 0) return { status: 'completed', output: '(file is empty)', files };
    if (offset > scan.totalLines) return { status: 'completed', output: pastEndMessage(offset, 'file', scan.totalLines), files };
    return { status: 'completed', output: await pageToFit(ctx.outputFit, (budget) => pageNumberedLines(selected, offset, scan.totalLines, budget)), files };
  },
});
