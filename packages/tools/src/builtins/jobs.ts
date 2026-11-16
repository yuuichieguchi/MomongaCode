import type { JobView } from '@momonga/protocol';
import { BASH_OUTPUT_TOOL_NAME, COMMAND_TOOL_NAME, KILL_BASH_TOOL_NAME } from '@momonga/protocol';
import { defineTool, ToolExecutionError } from '../types.ts';
import type { ReconcileContext, ToolContext } from '../types.ts';
import { checkWithPatterns, validateUntrusted } from '@momonga/foundation';
import type { BackgroundJobs, LineFilter } from '../ports.ts';

export const DEFAULT_OUTPUT_WAIT_MS = 30_000;
export const MAX_OUTPUT_WAIT_MS = 600_000;

type BashOutputInput = { bash_id: string; filter?: string; block?: boolean; timeout?: number };
type KillBashInput = { shell_id: string };

export const describeJobStatus = (job: JobView): string => {
  switch (job.status) {
    case 'running':
      return 'it is still running';
    case 'exited':
      return job.exitCode === undefined ? 'it exited' : `it exited with code ${job.exitCode}`;
    case 'killed':
      return job.signal === undefined ? 'it was stopped' : `it was stopped (${job.signal})`;
    case 'unknown':
      return 'the runtime stopped while it ran, so its result is unknown';
  }
};

const requireJobs = (ctx: ReconcileContext): BackgroundJobs => {
  if (ctx.jobs === undefined) throw new ToolExecutionError('Background jobs are not available in this runtime');
  return ctx.jobs;
};

const FILTER_IDENTITY = 'BashOutput.filter';

const assertFilterSyntax = (pattern: string): void => {
  try {
    new RegExp(pattern);
  } catch (error) {
    throw new ToolExecutionError(`filter is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export type LineFilterOptions = { readonly signal?: AbortSignal; readonly patternCheckLimitMs?: number };

export const createLineFilter = (pattern: string, options: LineFilterOptions): LineFilter => {
  assertFilterSyntax(pattern);
  const schema = { type: 'string', pattern };
  return async (lines) => {
    const checked = await checkWithPatterns(() => lines.map((line) => validateUntrusted(FILTER_IDENTITY, schema, line).valid), options);
    if (checked.kind === 'stopped') throw new ToolExecutionError('BashOutput was cancelled');
    if (checked.kind === 'not-checked') {
      throw new ToolExecutionError(
        `filter could not be matched against the new output within ${checked.limitMs} ms: the pattern is too costly to match. The output was not consumed: read it again with a simpler filter, or with none.`,
      );
    }
    return lines.filter((_line, index) => checked.value[index] === true);
  };
};

const lineFilterOf = (pattern: string, ctx: ToolContext): LineFilter =>
  createLineFilter(pattern, { signal: ctx.signal, ...(ctx.patternCheckLimitMs === undefined ? {} : { patternCheckLimitMs: ctx.patternCheckLimitMs }) });

export const bashOutputTool = defineTool<BashOutputInput>({
  name: BASH_OUTPUT_TOOL_NAME,
  tier: 'optional',
  companionOf: COMMAND_TOOL_NAME,
  description: `Reads the output a background job (started with Bash run_in_background) has produced since the last BashOutput call, and reports whether the job is running, exited or stopped. filter keeps only the output lines that match a regular expression; the other new lines are discarded. With block true the call waits until the job ends or timeout milliseconds pass (default ${DEFAULT_OUTPUT_WAIT_MS}, maximum ${MAX_OUTPUT_WAIT_MS}).`,
  conciseDescription: `Reads the new output of a background job and its state. filter keeps only lines matching a regular expression. With block true it waits until the job ends or timeout ms pass (default ${DEFAULT_OUTPUT_WAIT_MS}, maximum ${MAX_OUTPUT_WAIT_MS}).`,
  conciseParameterDescriptions: {
    bash_id: 'Job id from Bash',
    filter: 'Regular expression; keep matching lines only',
    block: 'Wait for the job to end',
    timeout: 'Maximum wait in milliseconds',
  },
  kind: 'execute',
  sideEffect: 'read_only',
  inputSchema: {
    type: 'object',
    properties: {
      bash_id: { type: 'string', minLength: 1, description: 'The job id returned by Bash' },
      filter: { type: 'string', minLength: 1, description: 'Regular expression; only matching lines of the new output are returned' },
      block: { type: 'boolean', description: 'Wait for the job to end' },
      timeout: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_WAIT_MS, description: 'How long block may wait, in milliseconds' },
    },
    required: ['bash_id'],
    additionalProperties: false,
  },
  timeoutMs: 10_000,
  title: (input) => `Read output of ${input.bash_id}`,
  subject: () => ({ kind: 'none', tool: BASH_OUTPUT_TOOL_NAME }),
  prepare: async (input: BashOutputInput, ctx: ToolContext) => ({ waitUntil: ctx.clock.now() + (input.timeout ?? DEFAULT_OUTPUT_WAIT_MS) }),
  execute: async (input, ctx, prepared) => {
    const jobs = requireJobs(ctx);
    const keep = input.filter === undefined ? undefined : lineFilterOf(input.filter, ctx);
    const waitUntil = prepared?.['waitUntil'];
    if (input.block === true) {
      if (typeof waitUntil !== 'number') throw new Error('BashOutput lost the time it may wait until');
      const job = jobs.status(ctx.runId, input.bash_id);
      if (job.status === 'running' && ctx.clock.now() < waitUntil) {
        return { status: 'pending', awaits: { kind: 'job', jobId: job.id }, wakeAt: waitUntil };
      }
    }
    const { job, output } = await jobs.read(ctx.runId, input.bash_id, { call: `${ctx.runId}/${ctx.callId}`, ...(keep === undefined ? {} : { keep }) });
    const header = `Job ${job.id}: ${describeJobStatus(job)}.`;
    return { status: 'completed', output: output === '' ? `${header}\nNo new output.` : `${header}\n${output}` };
  },
  reconcile: async () => ({ outcome: 'not_applied', output: '' }),
});

export const killBashTool = defineTool<KillBashInput>({
  name: KILL_BASH_TOOL_NAME,
  tier: 'optional',
  companionOf: COMMAND_TOOL_NAME,
  description: 'Stops a background job started with Bash run_in_background, together with every process it started. Stopping a job that has already ended reports how it ended.',
  conciseDescription: 'Stops a background job and every process it started.',
  conciseParameterDescriptions: { shell_id: 'Job id from Bash' },
  kind: 'execute',
  sideEffect: 'write',
  subjectKind: 'none',
  inputSchema: {
    type: 'object',
    properties: { shell_id: { type: 'string', minLength: 1, description: 'The job id returned by Bash' } },
    required: ['shell_id'],
    additionalProperties: false,
  },
  timeoutMs: 30_000,
  title: (input) => `Stop ${input.shell_id}`,
  subject: () => ({ kind: 'none', tool: KILL_BASH_TOOL_NAME }),
  execute: async (input, ctx) => {
    const { view, kill } = await requireJobs(ctx).kill(ctx.runId, input.shell_id);
    if (kill === 'requested') return { status: 'completed', output: `Job ${view.id}: kill requested; it stops when its owner finishes the stop.` };
    return { status: 'completed', output: `Job ${view.id}: ${describeJobStatus(view)}.` };
  },
  reconcile: async () => ({ outcome: 'not_applied', output: '' }),
});
