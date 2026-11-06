import { defineTool, ToolExecutionError } from '../types.ts';
import { DEFAULT_LINE_LIMIT, pageNumberedLines, pastEndMessage, splitLines } from './format.ts';

type ReadOutputInput = { handle: string; offset?: number; limit?: number };

export const readOutputTool = defineTool<ReadOutputInput>({
  name: 'ReadOutput',
  tier: 'essential',
  reads: 'output_handle',
  description: `Reads a saved tool output by the handle reported when the output was truncated. Returns at most ${DEFAULT_LINE_LIMIT} lines by default in cat -n format; use offset (1-based line) and limit to page.`,
  conciseDescription: `Reads a saved output by its handle, up to ${DEFAULT_LINE_LIMIT} lines (cat -n); page with offset and limit.`,
  conciseParameterDescriptions: {
    handle: 'Handle from a truncated result',
    offset: 'First line, 1-based',
    limit: 'Number of lines',
  },
  kind: 'read',
  sideEffect: 'read_only',
  inputSchema: {
    type: 'object',
    properties: {
      handle: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Output handle from a truncated result' },
      offset: { type: 'integer', minimum: 1, description: 'Line number to start reading from (1-based)' },
      limit: { type: 'integer', minimum: 1, description: 'Number of lines to read' },
    },
    required: ['handle'],
    additionalProperties: false,
  },
  pagesOutput: true,
  timeoutMs: 10_000,
  title: (input) => `Read output ${input.handle.slice(0, 12)}`,
  subject: () => ({ kind: 'none', tool: 'ReadOutput' }),
  execute: async (input, ctx) => {
    const offset = input.offset ?? 1;
    const range = { lineStart: offset, lineEnd: offset + (input.limit ?? DEFAULT_LINE_LIMIT) - 1 };
    const page = await ctx.blobs.read(input.handle, range).catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === 'BLOB_NOT_FOUND') throw new ToolExecutionError('Unknown output handle');
      throw error;
    });
    if (offset > page.totalLines) return { status: 'completed', output: pastEndMessage(offset, 'output', page.totalLines) };
    return { status: 'completed', output: pageNumberedLines(splitLines(page.text), offset, page.totalLines, ctx.outputBudgetChars) };
  },
});
