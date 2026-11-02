import { defineTool, ToolExecutionError } from '../types.ts';
import { looksBinary, recordInLedger, regularFileProblem, scanLines, statIfExists } from './files.ts';
import { DEFAULT_LINE_LIMIT, pageNumberedLines, pastEndMessage } from './format.ts';
import { canonicalPathOf, requireAbsolute } from './paths.ts';

type ReadInput = { file_path: string; offset?: number; limit?: number };

export const readTool = defineTool<ReadInput>({
  name: 'Read',
  tier: 'essential',
  description:
    'Reads a text file from the filesystem. file_path must be absolute. Returns at most 2000 lines by default in cat -n format; use offset (1-based line) and limit to page through large files. Lines longer than 2000 characters are cut. Binary files are refused.',
  kind: 'read',
  sideEffect: 'read_only',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to read' },
      offset: { type: 'integer', minimum: 1, description: 'Line number to start reading from (1-based)' },
      limit: { type: 'integer', minimum: 1, description: 'Number of lines to read' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  pagesOutput: true,
  timeoutMs: 30_000,
  title: (input) => `Read ${input.file_path}`,
  locations: (input) => [{ path: input.file_path, ...(input.offset === undefined ? {} : { line: input.offset }) }],
  subject: (input) => ({ kind: 'path', tool: 'Read', paths: [requireAbsolute('file_path', input.file_path)], access: 'read' }),
  execute: async (input, ctx) => {
    const canonical = canonicalPathOf('file_path', input.file_path);
    const stat = await statIfExists(canonical);
    if (stat === undefined) throw new ToolExecutionError(`File does not exist: ${input.file_path}`);
    if (stat.isDirectory()) {
      throw new ToolExecutionError(`${input.file_path} is a directory, not a file; use Glob to find files or Bash with ls to list it`);
    }
    const problem = regularFileProblem(stat, input.file_path);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    if (await looksBinary(canonical)) {
      throw new ToolExecutionError(`${input.file_path} is a binary file (${stat.size} bytes) and cannot be read as text`);
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
    if (scan.totalLines === 0) return { status: 'completed', output: '(file is empty)' };
    if (offset > scan.totalLines) return { status: 'completed', output: pastEndMessage(offset, 'file', scan.totalLines) };
    return { status: 'completed', output: pageNumberedLines(selected, offset, scan.totalLines, ctx.outputBudgetChars) };
  },
});
