import type { JobView } from '@momonga/protocol';
import { defineTool, ToolExecutionError } from '../types.ts';
import type { ReconcileContext, ToolContext } from '../types.ts';
import type { BackgroundJobs } from '../ports.ts';

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

const compileFilter = (pattern: string): RegExp => {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new ToolExecutionError(`filter is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const bashOutputTool = defineTool<BashOutputInput>({
  name: 'BashOutput',
  description:
    'Reads the new output of a background job (Bash run_in_background) and reports whether it runs, exited or was stopped. filter keeps only new lines matching a regular expression. block waits until the job ends or timeout ms pass (default 30000, maximum 600000).',
  kind: 'execute',
  sideEffect: 'read_only',
  requiresJobs: true,
  inputSchema: {
    type: 'object',
    properties: {
      bash_id: { type: 'string', minLength: 1 },
      filter: { type: 'string', minLength: 1 },
      block: { type: 'boolean' },
      timeout: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_WAIT_MS },
    },
    required: ['bash_id'],
    additionalProperties: false,
  },
  timeoutMs: 10_000,
  title: (input) => `Read output of ${input.bash_id}`,
  subject: () => ({ kind: 'none', tool: 'BashOutput' }),
  prepare: async (input: BashOutputInput, ctx: ToolContext) => ({ waitUntil: ctx.clock.now() + (input.timeout ?? DEFAULT_OUTPUT_WAIT_MS) }),
  execute: async (input, ctx, prepared) => {
    const jobs = requireJobs(ctx);
    const filter = input.filter === undefined ? undefined : compileFilter(input.filter);
    const waitUntil = prepared?.['waitUntil'];
    if (input.block === true) {
      if (typeof waitUntil !== 'number') throw new Error('BashOutput lost the time it may wait until');
      const job = jobs.status(ctx.runId, input.bash_id);
      if (job.status === 'running' && ctx.clock.now() < waitUntil) {
        return { status: 'pending', awaits: { kind: 'job', jobId: job.id }, wakeAt: waitUntil };
      }
    }
    const { job, output } = await jobs.read(ctx.runId, input.bash_id, filter === undefined ? {} : { filter });
    const header = `Job ${job.id}: ${describeJobStatus(job)}.`;
    return { status: 'completed', output: output === '' ? `${header}\nNo new output.` : `${header}\n${output}` };
  },
  reconcile: async () => ({ outcome: 'not_applied', output: '' }),
});

export const killBashTool = defineTool<KillBashInput>({
  name: 'KillBash',
  description: 'Stops a background job and the processes it started.',
  kind: 'execute',
  sideEffect: 'write',
  requiresJobs: true,
  inputSchema: {
    type: 'object',
    properties: { shell_id: { type: 'string', minLength: 1 } },
    required: ['shell_id'],
    additionalProperties: false,
  },
  timeoutMs: 30_000,
  title: (input) => `Stop ${input.shell_id}`,
  subject: () => ({ kind: 'none', tool: 'KillBash' }),
  execute: async (input, ctx) => {
    const job = await requireJobs(ctx).kill(ctx.runId, input.shell_id);
    return { status: 'completed', output: `Job ${job.id}: ${describeJobStatus(job)}.` };
  },
  reconcile: async () => ({ outcome: 'not_applied', output: '' }),
});
