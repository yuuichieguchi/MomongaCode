import { randomBytes } from 'node:crypto';
import { findHolders, reconcileProcessGroup } from '@momonga/foundation';
import { defineTool, ToolExecutionError } from '../types.ts';
import type { SandboxExit } from '@momonga/sandbox';
import type { BackgroundJobs } from '../ports.ts';
import type { ReconcileContext, ToolContext, ToolResult } from '../types.ts';
import { describeJobStatus } from './jobs.ts';
import { canonicalDirectories, insideAny } from './paths.ts';
import { nodeShellPorts, resolveBashPath } from './shell.ts';

type BashInput = { command: string; timeout?: number; description?: string; run_in_background?: boolean };

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 1_800_000;
export const MAX_BACKGROUND_TIMEOUT_MS = 7_200_000;
const TITLE_CHARS = 80;
const HEAD_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 4 * 1024 * 1024;
const STREAM_DRAIN_MS = 1000;
const CONTINUATION_BYTE = 0b1100_0000;

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & CONTINUATION_BYTE) === 0b1000_0000;

const createCapture = () => {
  const head: Buffer[] = [];
  const tail: Buffer[] = [];
  let headSize = 0;
  let tailSize = 0;
  let omitted = 0;
  return {
    push(chunk: Buffer): void {
      let rest = chunk;
      if (headSize < HEAD_BYTES) {
        const taken = rest.subarray(0, HEAD_BYTES - headSize);
        head.push(taken);
        headSize += taken.length;
        rest = rest.subarray(taken.length);
      }
      if (rest.length === 0) return;
      tail.push(rest);
      tailSize += rest.length;
      while (tailSize > TAIL_BYTES) {
        const excess = tailSize - TAIL_BYTES;
        const first = tail[0] as Buffer;
        if (first.length <= excess) {
          tail.shift();
          omitted += first.length;
          tailSize -= first.length;
        } else {
          tail[0] = first.subarray(excess);
          omitted += excess;
          tailSize -= excess;
        }
      }
    },
    text(): string {
      let headBytes = Buffer.concat(head);
      let tailBytes = Buffer.concat(tail);
      if (omitted === 0) return Buffer.concat([headBytes, tailBytes]).toString('utf8');
      let leadIndex = headBytes.length - 1;
      while (leadIndex > 0 && isContinuation(headBytes[leadIndex])) leadIndex -= 1;
      const lead = headBytes[leadIndex] ?? 0;
      const sequenceLength = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= CONTINUATION_BYTE ? 2 : 1;
      const headEnd = leadIndex + sequenceLength > headBytes.length ? leadIndex : headBytes.length;
      let tailStart = 0;
      while (tailStart < tailBytes.length && isContinuation(tailBytes[tailStart])) tailStart += 1;
      const dropped = omitted + (headBytes.length - headEnd) + tailStart;
      headBytes = headBytes.subarray(0, headEnd);
      tailBytes = tailBytes.subarray(tailStart);
      return `${headBytes.toString('utf8')}\n[… ${dropped} bytes omitted …]\n${tailBytes.toString('utf8')}`;
    },
  };
};

const trapScript = (nonce: string): string =>
  `trap 'status=$?; printf "\\n__MOMONGA_CWD_${nonce}__=%s\\n" "$(pwd -P)"; exit $status' EXIT`;

const extractCwd = (output: string, nonce: string): { output: string; cwd: string | undefined } => {
  const prefix = `__MOMONGA_CWD_${nonce}__=`;
  const index = output.lastIndexOf(prefix);
  if (index === -1) return { output, cwd: undefined };
  const lineEnd = output.indexOf('\n', index);
  const cwd = output.slice(index + prefix.length, lineEnd === -1 ? output.length : lineEnd);
  const removeFrom = output[index - 1] === '\n' ? index - 1 : index;
  const removeTo = lineEnd === -1 ? output.length : lineEnd + 1;
  return { output: output.slice(0, removeFrom) + output.slice(removeTo), cwd };
};

const waitForStreams = async (streams: Promise<void>): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STREAM_DRAIN_MS);
  });
  try {
    await Promise.race([streams, expired]);
  } finally {
    clearTimeout(timer);
  }
};

const requireMarker = (ctx: ToolContext): string => {
  if (ctx.processMarker === undefined) throw new ToolExecutionError('Bash needs a process marker from the executor');
  return ctx.processMarker;
};

const requireJobs = (ctx: ReconcileContext): BackgroundJobs => {
  if (ctx.jobs === undefined) throw new ToolExecutionError('Background jobs are not available in this runtime');
  return ctx.jobs;
};

const startBackgroundJob = async (input: BashInput, ctx: ToolContext): Promise<ToolResult> => {
  const { jobId } = await requireJobs(ctx).start({
    runId: ctx.runId,
    callKey: ctx.idemKey,
    callId: ctx.callId,
    command: input.command,
    timeoutMs: input.timeout ?? DEFAULT_BACKGROUND_TIMEOUT_MS,
    spawn: (markerFile, signal) =>
      ctx.sandbox.spawn(
        {
          argv: ['/bin/bash', '-c', input.command],
          cwd: ctx.session.cwd,
          env: { ...ctx.env, GIT_TERMINAL_PROMPT: '0', PAGER: 'cat', GIT_PAGER: 'cat' },
          markerFile,
          ...(ctx.tmpDir === undefined ? {} : { tmpDir: ctx.tmpDir }),
        },
        ctx.sandboxPolicy,
        signal,
      ),
  });
  return {
    status: 'completed',
    output: `Started background job ${jobId}. Read its output with BashOutput (bash_id ${jobId}) and stop it with KillBash (shell_id ${jobId}).`,
  };
};

export const bashTool = defineTool<BashInput>({
  name: 'Bash',
  description:
    'Runs a shell command with /bin/bash inside a sandbox, in the current working directory. Output combines stdout and stderr. A cd that stays inside the workspace persists to later calls. timeout is in milliseconds (default 120000, maximum 600000). No process started by the command outlives it. With run_in_background the command starts as a background job and the call returns its job id at once; read its output with BashOutput and stop it with KillBash. For a background job timeout is the time the job may run (default 1800000, maximum 7200000); a job ends with its command, with KillBash, at its time limit, or when MomongaCode stops.',
  kind: 'execute',
  sideEffect: 'exec',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, description: 'The command to run' },
      timeout: { type: 'integer', minimum: 1, maximum: MAX_BACKGROUND_TIMEOUT_MS, description: 'Timeout in milliseconds' },
      description: { type: 'string', description: 'Short description of what the command does' },
      run_in_background: { type: 'boolean', description: 'Run the command as a background job and return its job id immediately' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  timeoutMs: (input) => Math.min(input.run_in_background === true ? DEFAULT_TIMEOUT_MS : (input.timeout ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS),
  title: (input) => input.description ?? input.command.slice(0, TITLE_CHARS),
  subject: (input) => ({ kind: 'command', tool: 'Bash', command: input.command }),
  execute: async (input, ctx) => {
    if (input.run_in_background === true) return startBackgroundJob(input, ctx);
    const marker = requireMarker(ctx);
    const nonce = randomBytes(16).toString('hex');
    const script = `${trapScript(nonce)}\n${input.command}`;
    const child = ctx.sandbox.spawn(
      {
        argv: [resolveBashPath(process.platform, { ...nodeShellPorts(), env: ctx.env }), '-c', script],
        cwd: ctx.session.cwd,
        env: { ...ctx.env, GIT_TERMINAL_PROMPT: '0', PAGER: 'cat', GIT_PAGER: 'cat' },
        markerFile: marker,
        ...(ctx.tmpDir === undefined ? {} : { tmpDir: ctx.tmpDir }),
      },
      ctx.sandboxPolicy,
      ctx.signal,
    );
    ctx.attachProcess({ pgid: child.pgid, startedAt: ctx.clock.now() });

    const capture = createCapture();
    const iterators = [child.stdout, child.stderr].map((stream) => stream[Symbol.asyncIterator]());
    let streamFailure: { error: unknown } | undefined;
    let closing: Promise<void> | undefined;
    const closeIterators = (): Promise<void> => (closing ??= Promise.all(iterators.map((iterator) => iterator.return?.())).then(() => undefined));
    const pumps = iterators.map((iterator) =>
      (async () => {
        for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) capture.push(Buffer.from(step.value));
      })().catch((error: unknown) => {
        streamFailure ??= { error };
        closeIterators().catch((closeError: unknown) => {
          streamFailure ??= { error: closeError };
        });
      }),
    );
    let exit: SandboxExit;
    const notes: string[] = [];
    try {
      exit = await child.exited;
      const holders = await findHolders(marker);
      if (holders.length > 0) {
        await reconcileProcessGroup({ pgid: child.pgid, marker });
        notes.push(`Terminated ${holders.length} process(es) that outlived the command.`);
      }
      await waitForStreams(Promise.all(pumps).then(() => undefined));
    } finally {
      await closeIterators();
    }
    if (streamFailure !== undefined) throw streamFailure.error;

    const extracted = extractCwd(capture.text(), nonce);
    let output = extracted.output.replace(/\n+$/, '');
    if (extracted.cwd !== undefined) {
      if (insideAny(extracted.cwd, canonicalDirectories(ctx.roots))) {
        ctx.session.cwd = extracted.cwd;
      } else {
        output += `${output === '' ? '' : '\n'}Shell cwd was reset to ${ctx.session.cwd}`;
      }
    }
    for (const note of notes) output += `${output === '' ? '' : '\n'}${note}`;
    if (exit.signal !== null) return { status: 'failed', output: `${output}${output === '' ? '' : '\n'}[terminated by ${exit.signal}]` };
    if (exit.code !== 0) return { status: 'failed', output: `${output}${output === '' ? '' : '\n'}[exit code ${exit.code}]` };
    return { status: 'completed', output };
  },
  reconcile: async (input, record, ctx) => {
    if (input.run_in_background === true) {
      const job = requireJobs(ctx).byCall(ctx.idemKey);
      if (job === undefined) return { outcome: 'not_applied', output: '' };
      return {
        outcome: 'already_applied',
        output: `Started background job ${job.id}. The call was interrupted after the job started, so ${describeJobStatus(job)}.`,
      };
    }
    if (record.pgid !== undefined && ctx.processMarker !== undefined) {
      return reconcileProcessGroup({ pgid: record.pgid, marker: ctx.processMarker });
    }
    return {
      outcome: 'unknown',
      output: 'The interrupted command may or may not have started, and its effect is unknown; inspect the current state before retrying it.',
    };
  },
});
