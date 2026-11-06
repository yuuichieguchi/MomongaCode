import { defineTool, ToolExecutionError, ToolInputError } from '../types.ts';
import type { AnyTool } from '../types.ts';
import { HISTORY_QUERY_MAX_CHARS, HISTORY_READ_TOOL_NAME, HISTORY_SEARCH_TOOL_NAME, HISTORY_TOOL_TIMEOUT_MS } from './constants.ts';
import type { HistoryScope, HistoryToolsOptions } from './port.ts';
import { renderRead, renderSearch } from './render.ts';
import type { ReadResume } from './render.ts';

type SearchInput = { query: string; scope?: HistoryScope };

type ReadInput = { runId?: string; step?: number; seqFrom?: number; seqTo?: number; offset?: number };

const continuationFor =
  (input: ReadInput, runId: string) =>
  (resume: ReadResume): string => {
    const arguments_ = [
      `runId=${runId}`,
      ...(input.step === undefined ? [] : [`step=${input.step}`]),
      `seqFrom=${resume.seqFrom}`,
      ...(input.seqTo === undefined ? [] : [`seqTo=${input.seqTo}`]),
      ...(resume.offset > 0 ? [`offset=${resume.offset}`] : []),
    ];
    return `More of this range remains. Call ${HISTORY_READ_TOOL_NAME} again with ${arguments_.join(' ')}.`;
  };

export const createHistoryTools = ({ port, trusted, project }: HistoryToolsOptions): AnyTool[] => {
  const search = defineTool<SearchInput>({
    name: HISTORY_SEARCH_TOOL_NAME,
    tier: 'optional',
    description:
      'Searches the recorded history of earlier runs and sessions for all the given words. Returns run ids, seq ranges and short snippets, best matches first; use HistoryRead with a run id and seq range to read the recorded events. Scope project (the default) searches this project; scope all also reaches other trusted projects and asks for approval first.',
    conciseDescription:
      'Searches earlier runs for all the given words; returns run ids, seq ranges and snippets. Read the events with HistoryRead. scope: project (default) or all, which asks for approval.',
    kind: 'search',
    sideEffect: 'read_only',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: HISTORY_QUERY_MAX_CHARS },
        scope: { type: 'string', enum: ['project', 'all'] },
      },
      required: ['query'],
      additionalProperties: false,
    },
    pagesOutput: true,
    timeoutMs: HISTORY_TOOL_TIMEOUT_MS,
    title: (input) => `Search history for ${input.query}`,
    subject: (input) => {
      if (input.query.trim() === '') throw new ToolInputError('query must contain more than whitespace');
      return trusted && input.scope === 'all' ? { kind: 'history', tool: HISTORY_SEARCH_TOOL_NAME, project: 'all' } : { kind: 'none', tool: HISTORY_SEARCH_TOOL_NAME };
    },
    execute: async (input, ctx) => {
      const result = await port.search({ query: input.query, scope: input.scope ?? 'project' });
      return { status: 'completed', output: renderSearch(result, ctx.outputBudgetChars) };
    },
  });

  const read = defineTool<ReadInput>({
    name: HISTORY_READ_TOOL_NAME,
    tier: 'optional',
    reads: 'history_range',
    description:
      'Reads the recorded events of one run, redacted, for a step or a seq range. Without runId it reads the current run, including ranges that context compaction replaced. A long range is paged: follow the instruction at the end of the output with seqFrom and offset.',
    conciseDescription:
      'Reads the recorded events of one run for a step or seq range; the current run if runId is omitted. A long range is paged: follow the instruction at the end with seqFrom and offset.',
    kind: 'read',
    sideEffect: 'read_only',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1 },
        step: { type: 'integer', minimum: 0 },
        seqFrom: { type: 'integer', minimum: 1 },
        seqTo: { type: 'integer', minimum: 1 },
        offset: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    pagesOutput: true,
    timeoutMs: HISTORY_TOOL_TIMEOUT_MS,
    title: (input) => `Read history of ${input.runId === undefined ? 'the current run' : `run ${input.runId}`}`,
    subject: (input) => {
      if (input.seqFrom !== undefined && input.seqTo !== undefined && input.seqFrom > input.seqTo) throw new ToolInputError('seqFrom must not exceed seqTo');
      if (input.offset !== undefined && input.offset > 0 && input.seqFrom === undefined) throw new ToolInputError('offset continues the event at seqFrom, so it requires seqFrom');
      const runProject = input.runId === undefined ? undefined : port.projectOf(input.runId);
      return runProject === undefined || runProject === project
        ? { kind: 'none', tool: HISTORY_READ_TOOL_NAME }
        : { kind: 'history', tool: HISTORY_READ_TOOL_NAME, project: runProject };
    },
    execute: async (input, ctx) => {
      const runId = input.runId ?? ctx.runId;
      const page = port.read({
        runId,
        ...(input.step === undefined ? {} : { step: input.step }),
        ...(input.seqFrom === undefined ? {} : { seqFrom: input.seqFrom }),
        ...(input.seqTo === undefined ? {} : { seqTo: input.seqTo }),
      });
      if (page === null) throw new ToolExecutionError(`no recorded run ${runId} is visible`);
      const offset = input.offset ?? 0;
      if (offset > 0 && page.events[0]?.seq !== input.seqFrom) throw new ToolExecutionError(`no recorded event at seq ${String(input.seqFrom)} to continue from`);
      const { output } = renderRead({
        page,
        denied: await port.readDenial(page.project),
        redact: (text) => port.redact(text),
        ownRun: page.runId === ctx.runId,
        offset,
        offsetSeq: input.seqFrom,
        budgetChars: ctx.outputBudgetChars,
        continuation: continuationFor(input, page.runId),
      });
      return { status: 'completed', output };
    },
  });

  return [search, read];
};
